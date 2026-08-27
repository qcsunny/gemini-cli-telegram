/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file messageLoop.ts
 * @description Core message execution loop and LLM orchestrator.
 * Handles prompt formatting, local file binding, real-time response streaming via a single-draft state machine,
 * automated multi-tier model fallback chains, transcript reasoning recovery, and generated artifact auto-delivery.
 */

import type { DaemonSession, ChannelReply, MessageFormatter, MultimodalInput } from './types.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { ICONS, escapeHtml } from '../channels/telegram/ui.js';
import { runAgyPrint, extractThoughtAndContent } from '../agy/agyCli.js';
import type { AgyRunResult } from '../agy/types.js';
import { readThoughtFromTranscript } from './messageLoop/transcript.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker, parseFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';
import { getTuningConfig, getDefaultModel } from '../config/userConfig.js';
import { getEffectiveModelOrder, getChannelModel } from './modelRegistry.js';
import { classifyAndRouteQuery, AUTO_MODEL_NAME } from './router.js';
import { isBackendAvailable, markBackendFailed, markBackendHealthy } from './backendHealth.js';

import { withTimeout } from './messageLoop/threading.js';
import { stripThoughtTags } from '../utils/textUtils.js';
import { stripWholeMessageCodeFence, normalizeCodeFences, stripSearchResultPayloads } from './messageLoop/textUtils.js';
import { detectAndSendNewArtifacts } from './messageLoop/artifact.js';
import { forceReleaseDraft } from '../channels/telegram/bot/channelReply.js';
import { evaluateRetryState } from './messageLoop/retry.js';
import { StreamDraft } from './messageLoop/streamDraft.js';
import { ModelFallbackChain } from './messageLoop/modelFallbackChain.js';

const sleep = (ms: number) => {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
};

/**
 * Build the structured message payload for finalizing a reply.
 * Centralizes the repeated finalContent construction that was duplicated
 * 3 times in the finalize path.
 */
function buildFinalContent(
  answerBuffer: string,
  thoughtBuffer: string,
  footerParts: string[],
): { content: string; thought?: string; footerText?: string } {
  const content = { content: answerBuffer.trim() } as { content: string; thought?: string; footerText?: string };
  if (thoughtBuffer.trim()) content.thought = thoughtBuffer.trim();
  if (footerParts.length > 0) content.footerText = `⚙️ ${footerParts.join(' · ')}`;
  return content;
}

// agy's text mode streams small chunks while generating but dumps the remaining
// ~50-80% of the answer in one final stdout write at process exit. Any single
// text event above STREAM_RECHUNK_THRESHOLD is split into STREAM_SLICE_SIZE
// slices paced STREAM_SLICE_GAP_MS apart so the tail renders as a sequence of
// small draft edits instead of one giant jump. The gap must stay >= the debounce
// window (userConfig debounceIntervalMs, default 350) or the debounce gate would
// collapse the slices back into a single edit.
const STREAM_RECHUNK_THRESHOLD = 800;
const STREAM_SLICE_SIZE = 600;
const STREAM_SLICE_GAP_MS = 400;

// Ephemeral draft previews (sendRichMessageDraft) expire server-side after ~30s
// without an update. While a draft-mode reply is streaming, this heartbeat
// re-sends the current buffer so the preview stays alive even when agy's
// thought/text events stall (thoughts flush at step boundaries, leaving long
// silent gaps). Drafts can't be created until the first sendRichDraft, so the
// tick checks reply.usesEphemeralDraft each time.
const DRAFT_HEARTBEAT_MS = 20_000;

// Callers use getTuningConfig() at runtime so SIGHUP-triggered cache clears take effect.

/**
 * Channel-agnostic message processing loop. Streams output to the channel in
 * real-time, manages session state, and handles autonomous Autopilot loops
 * entirely on the Node side.
 *
 * The concrete model backend (local agy CLI, deepseek, web2api, opencode,
 * claude, codex) is resolved per-model inside the loop and walked as a
 * monotonic fallback chain on failure.
 */
function agyPrintTimeout(): string {
  const tuning = getTuningConfig();
  const hard = tuning.modelRunHardTimeoutMs ?? 900_000;
  const min = Math.max(hard + 300_000, 1_800_000);
  const m = Math.ceil(min / 60_000);
  return `${m}m`;
}

export interface PreparedPrompt {
  finalPrompt: string;
  extraDirs: string[];
  extraFiles: string[];
}

/**
 * Prepares the final prompt from multimodal input, resolving local media
 * attachment paths into prompt lines and backend-specific file/dir grants.
 */
export function preparePromptWithMedia(input: MultimodalInput): PreparedPrompt {
  let finalPrompt = input.text || '';
  let extraDirs: string[] = [];
  let extraFiles: string[] = [];
  if (input.media && input.media.length > 0) {
    const mediaLines = input.media.map(item => {
      return `[本地关联文件 - 类型: ${item.type}, 物理路径: "${item.path}", 原始文件名: "${item.fileName || '未知'}"]`;
    });
    finalPrompt = `${mediaLines.join('\n')}\n\n${finalPrompt}`;
    // Give the agy backend tooling access to the directory holding each
    // attachment so it can actually read the file (e.g. a PDF/文本附件)
    // rather than just seeing the path string. This relies on agy's
    // --add-dir flag and is consumed by the agy fallback path.
    extraDirs = [...new Set(input.media.map((item) => path.dirname(item.path)))];
    // Separately, feed the opencode backend the file paths themselves so it
    // can attach the bytes via its native --file flag. Without this, opencode
    // vision models only see the path string in the prompt and cannot read
    // the content. The two channels are mutually supporting: agy uses
    // extraDirs, opencode uses extraFiles — neither replaces the other.
    extraFiles = [...new Set(input.media.map((item) => item.path))];
  }
  return { finalPrompt, extraDirs, extraFiles };
}

export interface ExecutionErrorInfo {
  result: AgyRunResult;
  model: string;
  aborted: boolean;
  lastErrorMessage: string;
  didTimeout: boolean;
}

/**
 * Builds the user-facing HTML error message for a failed model run, choosing
 * the reason/detail/hint from the exit code, stderr/stdout signatures, and the
 * failing channel.
 */
export function buildExecutionErrorHtml(info: ExecutionErrorInfo): string {
  const { result: finalResult, model, aborted, lastErrorMessage, didTimeout } = info;
  const stderrStr = finalResult.stderr || '';
  const stdoutStr = finalResult.output || '';

  // Friendly, user-facing upstream messages (e.g. web2api empty-response
  // warning) are shown verbatim WITHOUT the generic "执行失败 / agy CLI"
  // prefix, since they are not CLI/login errors.
  const isFriendlyUpstreamMsg = !!stderrStr.trim() && /[⚠️❌]/.test(stderrStr) && !/(failed|Error|refused|terminated)/.test(stderrStr);

  const isAuthError = stderrStr.includes('authentication failed') || stdoutStr.includes('authentication failed') || stdoutStr.includes('not signed in') || stdoutStr.includes('Authentication required');
  const isTerminated = stderrStr.includes('terminated due to error') || stdoutStr.includes('terminated due to error');

  let errorReason = 'Execution failed';
  if (isAuthError) errorReason = 'Authentication expired or not logged in';
  if (isTerminated) errorReason = 'Agent process terminated abnormally';
  if (finalResult.isTimeout || aborted || didTimeout) errorReason = 'Execution cancelled or timed out';

  let detailMsg = '';

  if (isFriendlyUpstreamMsg) {
    detailMsg = `\n\n${escapeHtml(stderrStr.trim())}`;
  } else if (stdoutStr.includes('Welcome to the Antigravity CLI') || stdoutStr.includes('not signed in') || stdoutStr.includes('Authentication required')) {
    detailMsg = `\n\n<b>Note</b>: local agy CLI is not logged in. Login interaction info:\n<pre>Welcome to the Antigravity CLI. You are currently not signed in. Select login method: > 1. Google OAuth</pre>\nLog in via SSH and run <code>agy auth login</code> to re-authenticate.`;
  } else {
    const lines: string[] = [];
    if (stdoutStr.trim()) {
      lines.push(...stdoutStr.trim().split('\n').filter((l: string) => l.includes('429') || l.includes('503') || l.includes('canceled') || l.includes('failed') || l.includes('Error') || l.includes('refused') || l.includes('not supported')));
    }
    if (stderrStr.trim()) {
      lines.push(...stderrStr.trim().split('\n').filter((l: string) => l.includes('429') || l.includes('503') || l.includes('canceled') || l.includes('failed') || l.includes('Error') || l.includes('refused') || l.includes('not supported')));
    }
    const uniqueLines = Array.from(new Set(lines)).slice(0, 3);
    if (uniqueLines.length > 0) {
      detailMsg = `\n\n<b>Error details</b>:\n<pre>${uniqueLines.map(escapeHtml).join('\n')}</pre>`;
    }
  }

  // BUG-07: Choose error hint based on the actual failing channel, not always agy CLI.
  const failingChannel = getChannelModel(model);
  const channelHint = (!failingChannel || failingChannel === 'agy')
    ? 'Please verify that your local `agy` CLI is logged in and configured properly.'
    : `Please check that the ${failingChannel} backend service is reachable and configured correctly.`;
  return isFriendlyUpstreamMsg
    ? `${escapeHtml(stderrStr.trim())}`
    : `${ICONS.error} <b>${errorReason}</b> (exit code: ${finalResult.exitCode}). ${aborted || finalResult.isTimeout || didTimeout ? 'Task was cancelled or timed out (possibly by the system watchdog or the user).' : (lastErrorMessage ? `\n\n${escapeHtml(lastErrorMessage)}` : channelHint)}${detailMsg}`;
}

export async function processMessage(
  session: DaemonSession,
  input: MultimodalInput,
  reply: ChannelReply,
  formatter: MessageFormatter,
): Promise<void> {
  const chatId = session.chatId ?? Number(session.sessionId);
  const signal = session.abortController.signal;

  if (signal.aborted) {
    logger.debug(`[messageLoop] Signal already aborted. Skipping.`);
    await reply.send(`${ICONS.cancel} Task cancelled.`);
    return;
  }

  // 1. Prepare prompt and resolve local multimedia file paths
  const { finalPrompt, extraDirs: mediaExtraDirs, extraFiles: mediaExtraFiles } = preparePromptWithMedia(input);

  if (!finalPrompt.trim()) {
    logger.debug('[messageLoop] Empty prompt input, doing nothing.');
    return;
  }

  logger.debug(`[messageLoop] Prompt prepared: "${finalPrompt.slice(0, 100)}..."`);

  // 2. Single-draft append-only streaming state machine (buffers, draft.phase,
  // debounced edit pipeline) — extracted into StreamDraft.
  const draft = new StreamDraft(reply, formatter);
  let isDone = false;

    const cwd = session.currentProject?.path || process.cwd();

    try {
      session.busy = true;
      session._busySince = Date.now();
      session.turnCount++;

      let initialModel = session.model || getEffectiveModelOrder()[0];
      if (initialModel === AUTO_MODEL_NAME) {
        try {
          const routeResult = await classifyAndRouteQuery(finalPrompt, '', cwd);
          initialModel = routeResult.targetModel;
          logger.info(`[messageLoop] Auto-routed prompt to "${initialModel}" (category=${routeResult.category}, method=${routeResult.method}, elapsed=${routeResult.elapsedMs}ms)`);
        } catch (e) {
          logger.warn(`[messageLoop] Auto-router fallback: ${e}`);
          initialModel = getEffectiveModelOrder()[0] || 'Gemini 3.7 Flash (High)';
        }
      }

      // Build a capability-tier-aware fallback chain. The actual number of
      // tiers (T0..Tn) is data-driven from `modelsConfig.tiers` in config (see
      // src/config/models.json) — the modelOrder resolver returns every model
      // starting at `initialModel` and walks downward through lower-priority
      // tiers. Guarantees monotonic downgrade (只降不升). Models that
      // permanently failed are skipped via chain.skipModels.
      // Retry policy (per the agreed design):
      //   • Each model is attempted up to retriesPerModel times (configurable via tuning).
      //   • On exhausting a model's retries, downgrade to the next-weaker
      //     model in the capability-based fallback chain.
      //   • The chain is walked downward (只降不升): it never upgrades back to higher tiers.
      //   • Retries within a single model are intended for transient failures
      //     (rate limits, timeouts, etc.) where the same model can recover
      //     after a brief cooldown — they are NOT meant to mask a permanent
      //     capability mismatch (that is what downgrade is for).
      //   • Total budget across the whole run is chain.length * retriesPerModel.
      const retriesPerModel = getTuningConfig().retriesPerModel;
      const chain = new ModelFallbackChain(initialModel, retriesPerModel);

      // User-facing downgrade notice + fresh-bubble reset, invoked by
      // chain.advance() before each downgrade attempt.
      const onDowngrade = async (reason: string, prevModel: string, nextModel: string, switchedChannel: boolean): Promise<void> => {
        const nextCh = getChannelModel(nextModel);
        const switchNote = switchedChannel ? ` (switched to ${nextCh} channel)` : '';
        // BUG-05: Edit the existing message instead of sending a new one to avoid
        // flooding the chat with multiple "downgrading..." messages.
        const degradeHtml = `${ICONS.warning} ⚠️ Current model \`${prevModel}\` call failed (${escapeHtml(reason).slice(0, 200)}), automatically downgrading to \`${nextModel}\`${switchNote} and retrying...`;
        if (draft.currentMessageId) {
          try { await reply.edit(draft.currentMessageId, degradeHtml); } catch { await reply.send(degradeHtml); }
        } else {
          await reply.send(degradeHtml);
        }
        // Start the next attempt with a fresh bubble so the downgrade note
        // above stays visible (reusing it would overwrite the note).
        draft.currentMessageId = null;
      };

      let success = false;
      let lastResult: AgyRunResult | null = null;
      let lastErrorMessage = '';
      let didTimeout = false;

      let thoughtEventCount = 0;
      let textEventCount = 0;

      const turnStartTime = Date.now();

      // Whether this run used agy's stream-json format. In that mode the live
      // body is assembled from `text_delta`, which agy slices on byte boundaries
      // and can SPLIT multi-byte characters (e.g. CJK) across deltas — producing
      // replacement boxes (□). agy's final `result.response` (carried in
      // result.output) is the complete, correctly-encoded answer, so the final
      // body must come from there, not from the buffered deltas. Declared here
      // (outside the retry loop) so finalize can read it after the loop ends.
      const usedStreamJson = Boolean(getTuningConfig().streamJsonForChat);

      while (chain.attempts < chain.maxAttempts && !success && !signal.aborted) {
        chain.attempts++;
        // Reset per-attempt buffers so a new attempt starts from a clean
        // slate (otherwise a failed attempt's partial blocks would leak into
        // the next attempt's message). NOTE: draft.currentMessageId is intentionally
        // NOT reset here — on a same-model retry we reuse the existing draft
        // bubble (edit it back to "Thinking...") instead of sending a fresh
        // placeholder, avoiding duplicate "Thinking..." messages in the chat.
        // advanceModel() nulls it after a downgrade so the downgrade note
        // stays visible and the next attempt opens a new bubble.
        draft.thoughtBuffer = '';
        draft.answerBuffer = '';
        isDone = false;
        draft.phase = 'thinking';
        thoughtEventCount = 0;
        textEventCount = 0;

        let rawStreamBuffer = '';

        // Immediately send a placeholder "Thinking..." draft bubble to Telegram
        // so the user gets instant visual feedback while the model starts up.
        if (draft.hasRich) {
          await draft.updateMessageStream(false).catch((err) => {
            logger.warn(`[messageLoop] Failed to send initial placeholder: ${err}`);
          });
        }

        try {
          // Lazy health check: skip this model if its backend is in cooldown.
          {
            const channel = getChannelModel(chain.currentModel);
            if (!isBackendAvailable(channel)) {
              logger.info(`[messageLoop] Skipping model "${chain.currentModel}" — backend "${channel}" is in cooldown`);
              if (await chain.advance(`backend ${channel} temporarily unavailable`, onDowngrade)) continue;
              break;
            }
          }

          logger.info(`[messageLoop] Attempt ${chain.attempts}/${chain.maxAttempts}: Running prompt with model="${chain.currentModel}" (model retry ${chain.failsForModel + 1}/${retriesPerModel})`);
          // Stale-event guard: once this attempt settles (resolves OR rejects),
          // ignore any late events from the just-killed child (SIGINT on timeout)
          // so they never pollute the next attempt's shared stream buffers.
          let attemptStale = false;
          let result: AgyRunResult;
          // Declared outside the try so the finally (which may run after a
          // synchronous throw from setInterval) can clear it safely.
          let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
          try {
            // Tail re-chunking helpers (attempt-scoped because they close over
            // the attempt's rawStreamBuffer).
            const appendTextToStream = (text: string): void => {
              rawStreamBuffer += text;
              const parsed = extractThoughtAndContent(rawStreamBuffer);
              if (parsed.thought) {
                draft.thoughtBuffer = parsed.thought;
                // Use rawStreamBuffer for draft.answerBuffer during streaming to avoid content loss
                draft.answerBuffer = rawStreamBuffer;
              } else {
                draft.answerBuffer = rawStreamBuffer;
              }
              // Transition between thinking ↔ body phases based on buffer content
              if (draft.phase === 'thinking' && draft.answerBuffer.trim()) {
                draft.phase = 'body';
              } else if (draft.phase === 'body' && !draft.answerBuffer.trim()) {
                draft.phase = 'thinking';
              }
            };

            const feedSlicedTail = async (text: string): Promise<void> => {
              for (let i = 0; i < text.length; i += STREAM_SLICE_SIZE) {
                appendTextToStream(text.slice(i, i + STREAM_SLICE_SIZE));
                // Each slice becomes its own draft edit through the same
                // debounce + adaptive-throttle pipeline; awaiting serializes
                // them. The gap below prevents the debounce gate from collapsing
                // consecutive slices.
                await draft.updateMessageStream(false).catch(err => {
                  logger.warn(`[messageLoop] Error in draft.updateMessageStream: ${err}`);
                });
                await sleep(STREAM_SLICE_GAP_MS);
              }
            };

            // Ephemeral-draft heartbeat: the ~30s preview must be re-sent even
            // across long silent gaps (thoughts flush at agy step boundaries, so
            // streaming can stall for tens of seconds). Cleared in the finally
            // below. `unref()` keeps it from holding the event loop in tests.
            heartbeatTimer = setInterval(() => {
              if (draft.isFinished || !reply.usesEphemeralDraft) return;
              draft.updateMessageStream(false).catch(err => {
                logger.warn(`[messageLoop] Error in draft heartbeat draft.updateMessageStream: ${err}`);
              });
            }, DRAFT_HEARTBEAT_MS);
            (heartbeatTimer as unknown as { unref?: () => void }).unref?.();

            result = await withTimeout((resetInactivity, runSignal) => runAgyPrint({
              prompt: finalPrompt,
              cwd,
              conversationId: session.conversationId,
              model: chain.currentModel,
              proxy: session.proxy,
              printTimeout: agyPrintTimeout(),
              signal: runSignal,
              extraDirs: mediaExtraDirs,
              extraFiles: mediaExtraFiles,
              // Regular chat: auto-approve all tool permissions (web search,
              // bash, file ops) unless explicitly disabled in tuning config.
              // /invest already passes allowTools: true on its own path.
              allowTools: getTuningConfig().autoApproveTools,
              // When tuning.streamJsonForChat is on, request agy's stream-json
              // format. We don't need the chunk payload ourselves — agyCli already
              // re-emits each text_delta as an `onEvent({type:'text'})` — we only
              // pass onChunk to flip the run into stream-json mode. The final body
              // is taken from result.output (result.response), never from the
              // buffered deltas, because of the multi-byte splitting described
              // above.
              onChunk: usedStreamJson ? () => resetInactivity() : undefined,
              onActivity: () => resetInactivity(),
              onSpawn: (pid) => { session.childPid = pid; },
              onEvent: async (event) => {
                if (attemptStale) return;
              // Any streamed event counts as progress: reset both the model-run
              // inactivity timer and the bot's stuck-session watchdog (_busySince)
              // so a slow-but-active long reply is never killed mid-stream.
              resetInactivity();
              session._busySince = Date.now();
              if (event.type === 'thought') {
                thoughtEventCount++;
              } else if (event.type === 'text') {
                textEventCount++;
              }

              logger.debug(`[EVENT] type="${event.type}" content.length=${event.content?.length || 0} content_preview="${(event.content || '').slice(0, 100).replace(/\n/g, '\\n')}"`);

              if (event.type === 'thought') {
                draft.thoughtBuffer += event.content || '';
                logger.info(`[TRACE] thought event → draft.thoughtBuffer.len=${draft.thoughtBuffer.length} preview="${(event.content || '').slice(0, 80).replace(/\n/g, '\\n')}"`);
              } else if (event.type === 'text') {
                const text = event.content || '';
                // Oversized chunks (agy's final gush) are split and each slice is
                // flushed as its own edit so the tail doesn't jump in one go.
                // The 'done' event only fires after this loop drains (agyCli
                // serializes events), so finalize never outruns the tail.
                if (text.length > STREAM_RECHUNK_THRESHOLD) {
                  await feedSlicedTail(text);
                } else {
                  appendTextToStream(text);
                }
              } else if (event.type === 'done') {
                isDone = true;
                logger.debug(`[EVENT STATS] thought event count=${thoughtEventCount} text event count=${textEventCount}`);
              }

              logger.debug(`[BUFFER] draft.thoughtBuffer.length=${draft.thoughtBuffer.length} draft.answerBuffer.length=${draft.answerBuffer.length}`);

              draft.updateMessageStream(isDone).catch(err => {
                logger.warn(`[messageLoop] Error in draft.updateMessageStream: ${err}`);
              });
            }
          }), chain.currentModel || session.model || 'unknown', signal);
          } finally {
            // Mark the attempt as settled: any late events (e.g. a 'done' emitted
            // by the close-handler of a child we just SIGINT-killed on timeout)
            // must be ignored so they can't touch the next attempt's buffers.
            attemptStale = true;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }

          lastResult = result;

          if (result.exitCode === 0) {
            success = true;
            markBackendHealthy(getChannelModel(chain.currentModel));
            // If we had to fall back, persist the change to disk and update session
            if (chain.currentModel && chain.currentModel !== session.model) {
              logger.info(`[messageLoop] Successfully downgraded to model "${chain.currentModel}". Updating session.`);
              session.model = chain.currentModel;
              await setConversation(chatId, result.conversationId || session.conversationId || '', cwd, chain.currentModel, session.threadId);
            }
            break;
          }

          const stderr = result.stderr || '';
          const output = result.output || draft.answerBuffer;
          const evaluation = evaluateRetryState(stderr || output, chain.failsForModel, retriesPerModel);

          if (evaluation.isConnection) {
            markBackendFailed(getChannelModel(chain.currentModel));
          }
          if (evaluation.isPermanent) {
            chain.skipModels.add(chain.currentModel);
            logger.info(`[messageLoop] Permanently skipping model "${chain.currentModel}" — permanent failure`);
          }
          if (evaluation.backoffMs > 0) {
            logger.info(`[messageLoop] Rate-limited, backing off ${evaluation.backoffMs}ms before retry`);
            await sleep(evaluation.backoffMs);
          }

          chain.failsForModel++;
          if (signal.aborted) break;
          if (chain.failsForModel < retriesPerModel) continue; // retry same model
          if (await chain.advance(evaluation.reason, onDowngrade)) continue; // downgrade to next
          break; // last model failed → terminate
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.error(`[messageLoop] Attempt ${chain.attempts} error: ${errMsg}`);
          if (signal.aborted) throw e;
          if (typeof e === 'object' && e !== null && 'isTimeout' in e && e.isTimeout === true) didTimeout = true;
          lastErrorMessage = errMsg;
          const evaluation = evaluateRetryState(e, chain.failsForModel, retriesPerModel);

          if (evaluation.isConnection) {
            markBackendFailed(getChannelModel(chain.currentModel));
          }
          if (evaluation.isPermanent) {
            chain.skipModels.add(chain.currentModel);
            logger.info(`[messageLoop] Permanently skipping model "${chain.currentModel}" — connection error`);
          }
          if (evaluation.backoffMs > 0) {
            logger.info(`[messageLoop] Rate-limited, backing off ${evaluation.backoffMs}ms before retry`);
            await sleep(evaluation.backoffMs);
          }

          chain.failsForModel++;
          if (signal.aborted) break;
          if (chain.failsForModel < retriesPerModel) continue; // retry same model
          if (await chain.advance(evaluation.reason, onDowngrade)) continue; // downgrade to next
          break; // last model failed → terminate
        }
      }

      const finalResult = lastResult || { conversationId: '', output: draft.answerBuffer, exitCode: 1 };

      // In stream-json mode the live body was assembled from agy's incremental
      // `text_delta`, which agy slices on byte boundaries and can split a
      // multi-byte character (e.g. a CJK glyph) across two deltas — those halves
      // surface as replacement boxes (□) once each delta is JSON-decoded on its
      // own. agy's final `result.response` (carried in result.output) is the
      // complete, correctly-encoded answer, so substitute it for the buffered
      // deltas as the authoritative body. Text mode never hits this path
      // (draft.answerBuffer already equals the clean accumulated stdout).
      if (usedStreamJson && finalResult.exitCode === 0 && finalResult.output) {
        draft.answerBuffer = finalResult.output;
      }
      // Media models (gemini-image/music/canvas): text streaming was suppressed,
      // so draft.answerBuffer is empty. Set it to the preamble text (with media
      // data URLs / HTML stripped) so the user sees a text message alongside
      // the media file.
      if (finalResult.mediaFiles?.length && finalResult.output) {
        draft.answerBuffer = finalResult.output;
      }

      // 4. Save and persist the updated conversation ID
      if (finalResult.conversationId && finalResult.exitCode === 0) {
        session.conversationId = finalResult.conversationId;
        await setConversation(chatId, finalResult.conversationId, cwd, session.model, session.threadId);
      }

      // Wait for any pending stream updates to completely finish before rendering final message
      draft.isFinished = true;
      await draft.drainPending();

      // Strip <thought> XML from draft.answerBuffer unconditionally before final rendering.
      // Raw stdout chunks accumulate into draft.answerBuffer including any <thought>…</thought>
      // tags. Whether draft.thoughtBuffer was populated by the close-handler (agy-CLI path) or
      // will be populated by transcript recovery below, draft.answerBuffer must be clean before
      // markdownToHtml renders it, or a second <details> block will appear.
      {
        const parsed = extractThoughtAndContent(draft.answerBuffer);
        draft.answerBuffer = stripSearchResultPayloads(normalizeCodeFences(stripWholeMessageCodeFence(parsed.content)));
        if (parsed.thought && draft.thoughtBuffer.length === 0) {
          // Promote inline thought to draft.thoughtBuffer if not already set by onEvent
          draft.thoughtBuffer = parsed.thought;
        }
      }

      // Aggressive stray thought-tag cleanup: if any unpaired <thought>
      // tags survived the extractThoughtAndContent step (e.g. an upstream interrupt
      // mid-tag while body text was already streaming), strip them here so they never
      // leak as literal text into the user-facing final message.
      draft.answerBuffer = stripThoughtTags(draft.answerBuffer);

      // Recover this turn's complete non-body output (planner reasoning + tool
      // calls + tool results) from agy's transcript. The transcript is a strict
      // superset of what the live stream carries — streaming only relays reasoning
      // text plus bare tool names — so when it is available it REPLACES the
      // streamed buffer rather than being skipped, otherwise tool calls and their
      // results would never reach the Thinking Process block. Non-agy backends
      // have no transcript, so their real-time thought is kept as-is.
      if (session.conversationId) {
        const hadRealtimeThought = draft.thoughtBuffer.length > 0;
        const result = await readThoughtFromTranscript(
          session.conversationId,
          draft.answerBuffer,
          turnStartTime,
          // Already streaming a thought: the transcript is fully written by the
          // time agy exits, so poll briefly instead of blocking the reply for 5 s.
          hadRealtimeThought ? { maxAttempts: 5 } : undefined,
        );
        if (result && result.thought) {
          draft.thoughtBuffer = result.thought;
          logger.info(`[messageLoop] Successfully recovered thought from transcript: source=${result.source}, length=${draft.thoughtBuffer.length}, replacedRealtime=${hadRealtimeThought}`);
        } else if (hadRealtimeThought) {
          logger.info(`[messageLoop] Keeping real-time thought — no transcript for conversation ${session.conversationId}: length=${draft.thoughtBuffer.length}`);
        } else {
          logger.info(`[messageLoop] No thought recovered from transcript for conversation ${session.conversationId}`);
        }
      }

      // 5. Finalize: send the complete content as a real persisted message.
      // The HTML path (via sendRich) handles thought→details, blockquote
      // stripping, heading hoisting, and footer formatting internally.

      // Footer usage: local agy models return cumulative usage summed from
      // their database; backends fill it from the streamed/parsed proto.
      logger.info(`[footer] Calculating footer - exitCode=${finalResult.exitCode}, usage=${JSON.stringify(finalResult.usage)}`);
      const footerText = formatFooterMarker(
        chain.currentModel || getDefaultModel() || '',
        finalPrompt,
        draft.answerBuffer + (draft.thoughtBuffer.trim() ? '\n' + draft.thoughtBuffer.trim() : ''),
        finalResult.usage,
      );

      if (finalResult.exitCode === 0) {
        const footerParts = parseFooterMarker(footerText);

        logger.info(`[footer] footerText="${footerText}" footerParts=${JSON.stringify(footerParts)}`);

        // Atomically send the real persisted message.
        const replyContext = {
          answerMarkdown: draft.answerBuffer.trim(),
          thinkingMarkdown: draft.thoughtBuffer.trim(),
        };

        if (draft.currentMessageId !== null) {
          draft.phase = 'footer';
          try {
            const finalContent = buildFinalContent(draft.answerBuffer, draft.thoughtBuffer, footerParts);

            logger.info(`[TRACE finalize] content.len=${finalContent.content.length} thought.len=${(finalContent.thought || '').length} thought.preview="${(finalContent.thought || '').slice(0, 80).replace(/\n/g, '\\n')}" hasSendRich=${!!reply.sendRich} hasEditRich=${!!reply.editRich}`);

            // The streaming draft is now a REAL persisted message (sendRichDraft
            // uses sendRichMessage), so finalize by EDITING it in place with the
            // final content (thought folded into a details block + footer).
            // Only send a brand-new message if no edit primitive is available
            // (e.g. plain-text fallback or a legacy non-rich reply object).
            if (reply.editRich) {
              const persistedId = await reply.editRich!(draft.currentMessageId, finalContent);
              if (typeof persistedId === 'number' && persistedId > 0) draft.currentMessageId = persistedId;
            } else if (reply.sendRich) {
              draft.currentMessageId = await reply.sendRich!(finalContent);
            } else {
              // Plain text fallback
              const finalText = draft.thoughtBuffer.trim()
                ? `🧠 Thinking Process\n\n${draft.thoughtBuffer.trim()}\n\n${draft.answerBuffer.trim()}`
                : draft.answerBuffer.trim();
              await reply.edit!(draft.currentMessageId, finalText);
            }
            if (draft.answerBuffer.trim()) messageCache.set(draft.currentMessageId!, draft.answerBuffer.trim(), replyContext, chatId, chain.currentModel, session.conversationId);
          } catch (e) {
            logger.warn(`[messageLoop] Finalize failed: ${e}`);
            try {
              const finalContent = buildFinalContent(draft.answerBuffer, draft.thoughtBuffer, footerParts);
              if (reply.editRich) {
                const persistedId = await reply.editRich!(draft.currentMessageId, finalContent);
                if (typeof persistedId === 'number' && persistedId > 0) draft.currentMessageId = persistedId;
              } else {
                draft.currentMessageId = await reply.sendRich!(finalContent);
              }
              if (draft.answerBuffer.trim()) messageCache.set(draft.currentMessageId, draft.answerBuffer.trim(), replyContext, chatId, chain.currentModel, session.conversationId);
            } catch (e2) {
              logger.error(`[messageLoop] editRich/sendRich fallback failed: ${e2}`);
              // Last resort: persist the answer as a plain-text message so the
              // user never loses the response to an edit failure.
              try {
                const finalText = draft.thoughtBuffer.trim()
                  ? `🧠 Thinking Process\n\n${draft.thoughtBuffer.trim()}\n\n${draft.answerBuffer.trim()}`
                  : draft.answerBuffer.trim();
                draft.currentMessageId = await reply.send!(finalText);
                if (draft.answerBuffer.trim()) messageCache.set(draft.currentMessageId, draft.answerBuffer.trim(), replyContext, chatId, chain.currentModel, session.conversationId);
              } catch (e3) {
                logger.error(`[messageLoop] Plain-text degrade failed: ${e3}`);
              }
            }
          }
        } else if (draft.answerBuffer.trim()) {
          // No draft was ever created (e.g. model outputs all at once).
          try {
            const finalContent = buildFinalContent(draft.answerBuffer, draft.thoughtBuffer, footerParts);
            draft.currentMessageId = await reply.sendRich!(finalContent);
            if (draft.answerBuffer.trim()) messageCache.set(draft.currentMessageId!, draft.answerBuffer.trim(), replyContext, chatId, chain.currentModel, session.conversationId);
          } catch (e) {
            logger.warn(`[messageLoop] sendRich (no-draft path) failed: ${e}`);
            try {
              draft.currentMessageId = await reply.send!(draft.answerBuffer.trim());
              if (draft.answerBuffer.trim()) messageCache.set(draft.currentMessageId, draft.answerBuffer.trim(), replyContext, chatId, chain.currentModel, session.conversationId);
            } catch (e2) {
              logger.warn(`[messageLoop] send fallback failed: ${e2}`);
            }
          }
        }

        if (finalResult.conversationId) {
          await detectAndSendNewArtifacts(session, finalResult.conversationId, turnStartTime);
        }
        // Media models (gemini-image/music/canvas): send extracted media files
        // via session.sendMedia(). Temp files are cleaned up after sending.
        if (finalResult.mediaFiles?.length && session.sendMedia) {
          for (const file of finalResult.mediaFiles) {
            try {
              await session.sendMedia(file.path, file.type, file.caption);
            } catch (e) {
              logger.error(`[messageLoop] Failed to send media file ${file.path}: ${e}`);
            } finally {
              fs.unlink(file.path).catch(() => {});
            }
          }
        }
      } else if (finalResult.exitCode !== 0) {
        logger.error(`[messageLoop] DIAGNOSTIC - Execution Failed!\n` +
          `ExitCode: ${finalResult.exitCode}\n` +
          `Signal: ${finalResult.signal || 'none'}\n` +
          `Duration: ${finalResult.durationMs}ms\n` +
          `IsTimeout: ${finalResult.isTimeout}\n` +
          `CWD: ${cwd}\n` +
          `Stderr (preview): ${finalResult.stderr?.substring(0, 1000)}\n` +
          `Stdout (preview): ${finalResult.output?.substring(0, 1000)}\n`);
        
        const errorHtml = buildExecutionErrorHtml({
          result: finalResult,
          model: chain.currentModel,
          aborted: signal.aborted,
          lastErrorMessage,
          didTimeout,
        });
        if (draft.currentMessageId) {
          try {
            await reply.edit(draft.currentMessageId, errorHtml);
          } catch (e) {
            await reply.send(errorHtml);
          }
        } else {
          await reply.send(errorHtml);
        }
      }

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error(`[messageLoop] Error running prompt: ${errMsg}`);
    if (signal.aborted) {
      await reply.send(`${ICONS.cancel} Task cancelled by the user.`);
    } else {
      await reply.send(`${ICONS.error} Error: ${errMsg}`);
    }
  } finally {
    session.busy = false;
    session._busySince = undefined;
    session.childPid = undefined;
    // BUG-02: Force-release any active draft to prevent activeDraftIds leaks
    // on error/cancel paths that bypass the normal finalizer.
    forceReleaseDraft(chatId);
  }
}
