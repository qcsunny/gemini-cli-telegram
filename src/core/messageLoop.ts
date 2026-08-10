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
import { logger } from '../utils/logger.js';
import { ICONS, escapeHtml } from '../channels/telegram/ui.js';
import { runAgyPrint, extractThoughtAndContent } from '../agy/agyCli.js';
import type { AgyRunResult } from '../agy/types.js';
import { readThoughtFromTranscript } from './messageLoop/transcript.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker, parseFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';
import { getTuningConfig, getDefaultModel } from '../config/userConfig.js';
import { getEffectiveModelOrder, getChannelModel, buildTierAwareChain } from './modelRegistry.js';
import { isBackendAvailable, markBackendFailed, markBackendHealthy, isConnectionError } from './backendHealth.js';

import { withTimeout } from './messageLoop/threading.js';
import { stripWholeMessageCodeFence, normalizeCodeFences, stripSearchResultPayloads } from './messageLoop/textUtils.js';
import { detectAndSendNewArtifacts } from './messageLoop/artifact.js';
import { forceReleaseDraft } from '../channels/telegram/bot/channelReply.js';

const sleep = (ms: number) => {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
};

// Callers use getTuningConfig() at runtime so SIGHUP-triggered cache clears take effect.

/**
 * Channel-agnostic message processing loop using local agy CLI wrapper.
 * Streams output to the channel in real-time, manages session mappings,
 * and handles autonomous Autopilot loops entirely on the Node side.
 */
function agyPrintTimeout(): string {
  const tuning = getTuningConfig();
  const hard = tuning.modelRunHardTimeoutMs ?? 900_000;
  const min = Math.max(hard + 300_000, 1_800_000);
  const m = Math.ceil(min / 60_000);
  return `${m}m`;
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
  let finalPrompt = input.text || '';
  let mediaExtraDirs: string[] = [];
  if (input.media && input.media.length > 0) {
    const mediaLines = input.media.map(item => {
      return `[本地关联文件 - 类型: ${item.type}, 物理路径: "${item.path}", 原始文件名: "${item.fileName || '未知'}"]`;
    });
    finalPrompt = `${mediaLines.join('\n')}\n\n${finalPrompt}`;
    // Give the model tooling access to the directory holding each attachment
    // so it can actually read the file (e.g. a PDF/文本附件) rather than just
    // seeing the path string.
    mediaExtraDirs = [...new Set(input.media.map((item) => path.dirname(item.path)))];
  }

  if (!finalPrompt.trim()) {
    logger.debug('[messageLoop] Empty prompt input, doing nothing.');
    return;
  }

  logger.debug(`[messageLoop] Prompt prepared: "${finalPrompt.slice(0, 100)}..."`);

  // 2. Local variables for streaming response
  let thoughtBuffer = '';
  let answerBuffer = '';
  let currentMessageId: number | null = null;
  let lastEditTime = 0;
  let isFinished = false;
  let isDone = false;
  let activeUpdatePromise: Promise<any> = Promise.resolve();

  const hasRichPrimitives = !!reply.sendRichDraft;

  // ── Single-draft append-only state machine ────────────────────────────────
  type Phase = 'thinking' | 'body' | 'footer';
  let phase: Phase = 'thinking';

  // Render the whole authoritative content to the wire (draft while streaming,
  // real message once finalized).
  const flushBlocks = async () => {
    const stripped = answerBuffer.trim()
      .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
      .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?thought[^>]*>/gi, '')
      .replace(/<\/?thinking[^>]*>/gi, '')
      .replace(/<\/?think[^>]*>/gi, '')
      .trim();
    const content: { content: string; thought?: string } = {
      content: stripped,
    };
    if (thoughtBuffer.trim()) content.thought = thoughtBuffer.trim();

    logger.info(`[TRACE flushBlocks] phase=${phase} msgId=${currentMessageId} content.len=${content.content.length} thought.len=${(content.thought || '').length}`);

    if (currentMessageId === null || currentMessageId === 0) {
      const resId = await reply.sendRichDraft!(content);
      if (typeof resId === 'number' && resId > 0) currentMessageId = resId;
    } else if (phase === 'footer') {
      await reply.editRichDraft!(currentMessageId, content);
    } else {
      await reply.editRichDraft!(currentMessageId, content);
    }
  };

  // Stream editing helper — append-only.
  const updateMessageStream = async (isFinal = false) => {
    if (isFinished && !isFinal) return;
    const now = Date.now();
    if (!isFinal && now - lastEditTime < getTuningConfig().debounceIntervalMs) return;
    lastEditTime = now;

    activeUpdatePromise = activeUpdatePromise.then(async () => {
      if (isFinished && !isFinal) return;
      try {
        if (!hasRichPrimitives) {
          // Non-rich fallback: plain text (thinking then body), single message path.
          let text = '';
          if (thoughtBuffer.trim()) {
            const prefix = isFinal ? '🧠 Thinking Process\n\n' : '🧠 Thinking...\n\n';
            text = prefix + thoughtBuffer.trim();
            if (answerBuffer.trim()) text += '\n\n' + answerBuffer.trim();
          } else if (answerBuffer.trim()) {
            text = answerBuffer.trim();
          }
          if (text) {
            const truncated = formatter.truncateForEdit(text);
            if (!currentMessageId) currentMessageId = await reply.sendPlain(truncated);
            else await reply.editPlain(currentMessageId, truncated);
          }
          return;
        }

        // ── Rich HTML streaming path ──
        // Send the full content each time via sendRichDraft (HTML mode).
        // sendRichDraft handles <tg-thinking> animation and details blocks.
        await flushBlocks();
      } catch (e) {
        logger.warn(`[messageLoop] Failed to update streaming message: ${e}`);
      }
    });

    await activeUpdatePromise;
  };

    const cwd = session.currentProject?.path || process.cwd();

    try {
      session.busy = true;
      session._busySince = Date.now();
      session.turnCount++;

      // Build a capability-tier-aware fallback chain (T0 -> T1 -> T2 -> T3).
      // Guarantees monotonic downgrade (只降不升). Models that permanently failed
      // are skipped via skipModels.
      const skipModels = new Set<string>();
      const chain = buildTierAwareChain(session.model || getEffectiveModelOrder()[0], skipModels);

      // Retry policy (per the agreed design):
      //   • Each model is attempted up to retriesPerModel times (configurable via tuning).
      //   • On exhausting a model's retries, downgrade to the next-weaker
      //     model in the capability-based fallback chain.
      //   • The chain is walked downward (只降不升): it never upgrades back to higher tiers.
      //   • Total budget is chain.length * retriesPerModel.
      //     temporary failures (rate limits, transient errors) where a model
      //     may recover after a brief cooldown.
      //   • Total budget is chain.length * retriesPerModel.
      const retriesPerModel = getTuningConfig().retriesPerModel;
      const maxAttempts = chain.length * retriesPerModel;

      let modelToUse = chain[0];
      let chainIdx = 0;          // index into `chain`
      let failsForModel = 0;     // consecutive failures on the current model
      let attempts = 0;
      let success = false;
      let lastResult: any = null;
      let lastErrorMessage = '';
      let didTimeout = false;

      // Advance to the next model in the fallback chain. The chain is circular:
      // after the last (weakest) model, it wraps to the first (strongest) model.
      // Returns true if there is a next model to try, false if we've completed
      // a full loop and should terminate.
      //
      // Also detects channel switches (e.g., agy → deepseek) and logs them
      // with a 🔀 emoji so the user sees the backend change in Telegram.
      const advanceModel = async (reason: string): Promise<boolean> => {
        const prevModel = modelToUse;
        if (chainIdx + 1 >= chain.length) {
          logger.warn(`[messageLoop] Model "${prevModel}" failed (${reason}). Full fallback chain exhausted — terminating (attempt ${attempts}/${maxAttempts}).`);
          return false;
        }
        chainIdx++;
        modelToUse = chain[chainIdx];
        failsForModel = 0;
        // Detect whether the downgrade crosses a channel boundary (agy ↔ deepseek ↔ web2api)
        const prevCh = getChannelModel(prevModel);
        const nextCh = getChannelModel(modelToUse);
        const switchedChannel = prevCh && nextCh && prevCh !== nextCh;
        const logTag = switchedChannel ? `[messageLoop] 🔀 Channel switch ${prevCh}→${nextCh}` : '[messageLoop]';
        logger.warn(`${logTag} Model "${prevModel}" failed (${reason}). Downgrading to "${modelToUse}" (attempt ${attempts}/${maxAttempts}).`);
        const switchNote = switchedChannel ? ` (switched to ${nextCh} channel)` : '';
        // BUG-05: Edit the existing message instead of sending a new one to avoid
        // flooding the chat with multiple "downgrading..." messages.
        const degradeHtml = `${ICONS.warning} ⚠️ Current model \`${prevModel}\` call failed (${escapeHtml(reason).slice(0, 200)}), automatically downgrading to \`${modelToUse}\`${switchNote} and retrying...`;
        if (currentMessageId) {
          try { await reply.edit(currentMessageId, degradeHtml); } catch { await reply.send(degradeHtml); }
        } else {
          await reply.send(degradeHtml);
        }
        // Start the next attempt with a fresh bubble so the downgrade note
        // above stays visible (reusing it would overwrite the note).
        currentMessageId = null;
        return true;
      };

      let thoughtEventCount = 0;
      let textEventCount = 0;

      let turnStartTime = 0;

      while (attempts < maxAttempts && !success && !signal.aborted) {
        attempts++;
        // Reset per-attempt buffers so a new attempt starts from a clean
        // slate (otherwise a failed attempt's partial blocks would leak into
        // the next attempt's message). NOTE: currentMessageId is intentionally
        // NOT reset here — on a same-model retry we reuse the existing draft
        // bubble (edit it back to "Thinking...") instead of sending a fresh
        // placeholder, avoiding duplicate "Thinking..." messages in the chat.
        // advanceModel() nulls it after a downgrade so the downgrade note
        // stays visible and the next attempt opens a new bubble.
        thoughtBuffer = '';
        answerBuffer = '';
        isDone = false;
        phase = 'thinking';
        thoughtEventCount = 0;
        textEventCount = 0;

        let rawStreamBuffer = '';

        // Immediately send a placeholder "Thinking..." draft bubble to Telegram
        // so the user gets instant visual feedback while the model starts up.
        if (hasRichPrimitives) {
          await updateMessageStream(false).catch((err) => {
            logger.warn(`[messageLoop] Failed to send initial placeholder: ${err}`);
          });
        }

        try {
          // Lazy health check: skip this model if its backend is in cooldown.
          {
            const channel = getChannelModel(modelToUse);
            if (!isBackendAvailable(channel)) {
              logger.info(`[messageLoop] Skipping model "${modelToUse}" — backend "${channel}" is in cooldown`);
              if (await advanceModel(`backend ${channel} temporarily unavailable`)) continue;
              break;
            }
          }

          logger.info(`[messageLoop] Attempt ${attempts}/${maxAttempts}: Running prompt with model="${modelToUse}" (model retry ${failsForModel + 1}/${retriesPerModel})`);
          turnStartTime = Date.now();
          // Stale-event guard: once this attempt settles (resolves OR rejects),
          // ignore any late events from the just-killed child (SIGINT on timeout)
          // so they never pollute the next attempt's shared stream buffers.
          let attemptStale = false;
          let result: AgyRunResult;
          try {
            result = await withTimeout((resetInactivity, runSignal) => runAgyPrint({
              prompt: finalPrompt,
              cwd,
              conversationId: session.conversationId,
              model: modelToUse,
              proxy: session.proxy,
              printTimeout: agyPrintTimeout(),
              signal: runSignal,
              extraDirs: mediaExtraDirs,
              onActivity: () => resetInactivity(),
              onSpawn: (pid) => { session.childPid = pid; },
              onEvent: (event) => {
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
                thoughtBuffer += event.content || '';
                logger.info(`[TRACE] thought event → thoughtBuffer.len=${thoughtBuffer.length} preview="${(event.content || '').slice(0, 80).replace(/\n/g, '\\n')}"`);
              } else if (event.type === 'text') {
                rawStreamBuffer += event.content || '';
                const parsed = extractThoughtAndContent(rawStreamBuffer);
                if (parsed.thought) {
                  thoughtBuffer = parsed.thought;
                  // Use rawStreamBuffer for answerBuffer during streaming to avoid content loss
                  answerBuffer = rawStreamBuffer;
                } else {
                  answerBuffer = rawStreamBuffer;
                }
                // Transition between thinking ↔ body phases based on buffer content
                if (phase === 'thinking' && answerBuffer.trim()) {
                  phase = 'body';
                } else if (phase === 'body' && !answerBuffer.trim()) {
                  phase = 'thinking';
                }
              } else if (event.type === 'done') {
                isDone = true;
                logger.debug(`[EVENT STATS] thought event count=${thoughtEventCount} text event count=${textEventCount}`);
              }

              logger.debug(`[BUFFER] thoughtBuffer.length=${thoughtBuffer.length} answerBuffer.length=${answerBuffer.length}`);

              updateMessageStream(isDone).catch(err => {
                logger.warn(`[messageLoop] Error in updateMessageStream: ${err}`);
              });
            }
          }), modelToUse || session.model || 'unknown', signal);
          } finally {
            // Mark the attempt as settled: any late events (e.g. a 'done' emitted
            // by the close-handler of a child we just SIGINT-killed on timeout)
            // must be ignored so they can't touch the next attempt's buffers.
            attemptStale = true;
          }

          lastResult = result;

          if (result.exitCode === 0) {
            success = true;
            markBackendHealthy(getChannelModel(modelToUse));
            // If we had to fall back, persist the change to disk and update session
            if (modelToUse && modelToUse !== session.model) {
              logger.info(`[messageLoop] Successfully downgraded to model "${modelToUse}". Updating session.`);
              session.model = modelToUse;
              await setConversation(chatId, result.conversationId || session.conversationId || '', cwd, modelToUse, session.threadId);
            }
            break;
          }

          const stderr = result.stderr || '';
          const output = result.output || answerBuffer;

          // Backend health: mark backend failed on connection-level errors
          if (isConnectionError(result.stderr) || isConnectionError(result.output)) {
            markBackendFailed(getChannelModel(modelToUse));
          }

          // ANY non-success is eligible for a retry/downgrade (rate-limit,
          // auth error, process termination, hard timeout, generic error).
          const parsed = parseErrorMessage(stderr || output || 'Unknown error');
          const isRateLimited = parsed.type === 'rate_limit';
          const isPermanent = parsed.type === 'connection' || parsed.type === 'auth' || parsed.type === 'critical';
          const reason = parsed.message;

          // Adaptive skip: permanently failed models (connection errors) are
          // excluded from the rest of this session's fallback chain.
          if (isPermanent) {
            skipModels.add(modelToUse);
            logger.info(`[messageLoop] Permanently skipping model "${modelToUse}" — connection error`);
          }

          // Exponential backoff on rate-limit before retry
          if (isRateLimited && failsForModel < retriesPerModel) {
            const backoffMs = Math.min(1000 * Math.pow(2, failsForModel), 30000);
            logger.info(`[messageLoop] Rate-limited, backing off ${backoffMs}ms before retry`);
            await sleep(backoffMs);
          }

          failsForModel++;
          // User cancelled (e.g. /cancel): stop retrying immediately instead of
          // burning through the retry/downgrade budget pointlessly.
          if (signal.aborted) break;
          if (failsForModel < retriesPerModel) continue; // retry same model
          if (await advanceModel(reason)) continue;          // downgrade to next
          break;                                            // last model failed → terminate
        } catch (e: any) {
          logger.error(`[messageLoop] Attempt ${attempts} error: ${e?.message || e}`);
          if (signal.aborted) throw e;
          // Remember whether the final failure was a hard/inactivity timeout so
          // the terminal error message can still say "timed out" even though
          // withTimeout rejects (no AgyRunResult carries isTimeout=true).
          if (e?.isTimeout) didTimeout = true;

          // Backend health: mark backend failed on connection-level errors
          if (isConnectionError(e)) {
            markBackendFailed(getChannelModel(modelToUse));
          }

          // ANY thrown error is eligible for a retry/downgrade (including
          // hard-timeout / inactivity kills from withTimeout, auth errors,
          // process termination, and generic failures) — not just rate-limits.
          const errMsg = e?.message || String(e);
          lastErrorMessage = errMsg;
          const parsed = parseErrorMessage(errMsg);
          const isRateLimited = parsed.type === 'rate_limit';
          const isEofError = errMsg.includes('EOF') || errMsg.includes('streamGenerateContent') || errMsg.includes('daily-cloudcode-pa');
          const isPermanent = isConnectionError(e) || isEofError || parsed.type === 'auth' || parsed.type === 'critical';
          const reason = isEofError ? 'Google cloud API connection dropped (EOF network fluctuation)' : parsed.message;

          // Adaptive skip: permanently failed models are excluded from the rest of this session
          if (isPermanent) {
            skipModels.add(modelToUse);
            logger.info(`[messageLoop] Permanently skipping model "${modelToUse}" — connection error`);
          }

          // Exponential backoff on rate-limit before retry
          if (isRateLimited && failsForModel < retriesPerModel) {
            const backoffMs = Math.min(1000 * Math.pow(2, failsForModel), 30000);
            logger.info(`[messageLoop] Rate-limited, backing off ${backoffMs}ms before retry`);
            await sleep(backoffMs);
          }

          failsForModel++;
          // User cancelled (e.g. /cancel): stop retrying immediately.
          if (signal.aborted) break;
          if (failsForModel < retriesPerModel) continue; // retry same model
          if (await advanceModel(reason)) continue;          // downgrade to next
          break;                                            // last model failed → terminate
        }
      }

      const finalResult = lastResult || { conversationId: '', output: answerBuffer, exitCode: 1 };

      // 4. Save and persist the updated conversation ID
      if (finalResult.conversationId) {
        session.conversationId = finalResult.conversationId;
        await setConversation(chatId, finalResult.conversationId, cwd, session.model, session.threadId);
      }

      // Wait for any pending stream updates to completely finish before rendering final message
      isFinished = true;
      try {
        await activeUpdatePromise;
      } catch (e) {
        logger.warn(`[messageLoop] Error waiting for active update promise: ${e}`);
      }

      // Strip <thought> XML from answerBuffer unconditionally before final rendering.
      // Raw stdout chunks accumulate into answerBuffer including any <thought>…</thought>
      // tags. Whether thoughtBuffer was populated by the close-handler (agy-CLI path) or
      // will be populated by transcript recovery below, answerBuffer must be clean before
      // markdownToHtml renders it, or a second <details> block will appear.
      {
        const parsed = extractThoughtAndContent(answerBuffer);
        answerBuffer = stripSearchResultPayloads(normalizeCodeFences(stripWholeMessageCodeFence(parsed.content)));
        if (parsed.thought && thoughtBuffer.length === 0) {
          // Promote inline thought to thoughtBuffer if not already set by onEvent
          thoughtBuffer = parsed.thought;
        }
      }

      // Aggressive stray thought-tag cleanup: if any unpaired <thought>
      // tags survived the extractThoughtAndContent step (e.g. an upstream interrupt
      // mid-tag while body text was already streaming), strip them here so they never
      // leak as literal text into the user-facing final message.
      answerBuffer = answerBuffer
        .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
        .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
        .replace(/<\/?thought[^>]*>/gi, '')
        .replace(/<\/?thinking[^>]*>/gi, '')
        .replace(/<\/?think[^>]*>/gi, '')
        .trim();

      if (thoughtBuffer.length === 0 && session.conversationId) {
        const result = await readThoughtFromTranscript(session.conversationId, answerBuffer, turnStartTime);
        if (result && result.thought) {
          thoughtBuffer = result.thought;
          logger.info(`[messageLoop] Successfully recovered thought from transcript: source=${result.source}, length=${thoughtBuffer.length}`);
        } else {
          logger.info(`[messageLoop] No thought recovered from transcript for conversation ${session.conversationId}`);
        }
      } else if (thoughtBuffer.length > 0) {
        logger.info(`[messageLoop] Skipping transcript thought recovery since thoughtBuffer already contains real-time thought: length=${thoughtBuffer.length}`);
      }

      // 5. Finalize: send the complete content as a real persisted message.
      // The HTML path (via sendRich) handles thought→details, blockquote
      // stripping, heading hoisting, and footer formatting internally.

      // Local agy models already return cumulative usage from their database
       logger.info(`[footer] Calculating footer - exitCode=${finalResult.exitCode}, usage=${JSON.stringify(finalResult.usage)}`);
      const footerText = formatFooterMarker(
        modelToUse || getDefaultModel() || '',
        finalPrompt,
        answerBuffer + (thoughtBuffer.trim() ? '\n' + thoughtBuffer.trim() : ''),
        finalResult.usage,
      );

      if (finalResult.exitCode === 0) {
        const footerParts = parseFooterMarker(footerText);

        logger.info(`[footer] footerText="${footerText}" footerParts=${JSON.stringify(footerParts)}`);

        // Atomically send the real persisted message.
        const replyContext = {
          answerMarkdown: answerBuffer.trim(),
          thinkingMarkdown: thoughtBuffer.trim(),
        };

        if (currentMessageId !== null) {
          phase = 'footer';
          try {
            const finalContent: { content: string; thought?: string; footerText?: string } = {
              content: answerBuffer.trim(),
            };
            if (thoughtBuffer.trim()) finalContent.thought = thoughtBuffer.trim();
            if (footerParts.length > 0) finalContent.footerText = `⚙️ ${footerParts.join(' · ')}`;

            logger.info(`[TRACE finalize] content.len=${finalContent.content.length} thought.len=${(finalContent.thought || '').length} thought.preview="${(finalContent.thought || '').slice(0, 80).replace(/\n/g, '\\n')}" hasSendRich=${!!reply.sendRich} hasEditRich=${!!reply.editRich}`);

            // The streaming draft is now a REAL persisted message (sendRichDraft
            // uses sendRichMessage), so finalize by EDITING it in place with the
            // final content (thought folded into a details block + footer).
            // Only send a brand-new message if no edit primitive is available
            // (e.g. plain-text fallback or a legacy non-rich reply object).
            if (reply.editRich) {
              await reply.editRich!(currentMessageId, finalContent);
            } else if (reply.sendRich) {
              currentMessageId = await reply.sendRich!(finalContent);
            } else {
              // Plain text fallback
              const finalText = thoughtBuffer.trim()
                ? `🧠 Thinking Process\n\n${thoughtBuffer.trim()}\n\n${answerBuffer.trim()}`
                : answerBuffer.trim();
              await reply.edit!(currentMessageId, finalText);
            }
            if (answerBuffer.trim()) messageCache.set(currentMessageId!, answerBuffer.trim(), replyContext, chatId, modelToUse, session.conversationId);
          } catch (e) {
            logger.warn(`[messageLoop] Finalize failed: ${e}`);
            try {
              const finalContent: { content: string; thought?: string; footerText?: string } = {
                content: answerBuffer.trim(),
              };
              if (thoughtBuffer.trim()) finalContent.thought = thoughtBuffer.trim();
              if (footerParts.length > 0) finalContent.footerText = `⚙️ ${footerParts.join(' · ')}`;
              if (reply.editRich) {
                await reply.editRich!(currentMessageId, finalContent);
              } else {
                currentMessageId = await reply.sendRich!(finalContent);
              }
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim(), replyContext, chatId, modelToUse, session.conversationId);
            } catch (e2) {
              logger.warn(`[messageLoop] editRich/sendRich fallback failed: ${e2}`);
            }
          }
        } else if (answerBuffer.trim()) {
          // No draft was ever created (e.g. model outputs all at once).
          try {
            const finalContent: { content: string; thought?: string; footerText?: string } = {
              content: answerBuffer.trim(),
            };
            if (thoughtBuffer.trim()) finalContent.thought = thoughtBuffer.trim();
            if (footerParts.length > 0) finalContent.footerText = `⚙️ ${footerParts.join(' · ')}`;
            currentMessageId = await reply.sendRich!(finalContent);
            if (answerBuffer.trim()) messageCache.set(currentMessageId!, answerBuffer.trim(), replyContext, chatId, modelToUse, session.conversationId);
          } catch (e) {
            logger.warn(`[messageLoop] sendRich (no-draft path) failed: ${e}`);
            try {
              currentMessageId = await reply.send!(answerBuffer.trim());
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim(), replyContext, chatId, modelToUse, session.conversationId);
            } catch (e2) {
              logger.warn(`[messageLoop] send fallback failed: ${e2}`);
            }
          }
        }

        if (finalResult.conversationId) {
          await detectAndSendNewArtifacts(session, finalResult.conversationId, turnStartTime);
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
        if (finalResult.isTimeout || signal.aborted || didTimeout) errorReason = 'Execution cancelled or timed out';

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
        const failingChannel = getChannelModel(modelToUse);
        const channelHint = (!failingChannel || failingChannel === 'agy')
          ? 'Please verify that your local `agy` CLI is logged in and configured properly.'
          : `Please check that the ${failingChannel} backend service is reachable and configured correctly.`;
        const errorHtml = isFriendlyUpstreamMsg
          ? `${escapeHtml(stderrStr.trim())}`
          : `${ICONS.error} <b>${errorReason}</b> (exit code: ${finalResult.exitCode}). ${signal.aborted || finalResult.isTimeout || didTimeout ? 'Task was cancelled or timed out (possibly by the system watchdog or the user).' : (lastErrorMessage ? `\n\n${escapeHtml(lastErrorMessage)}` : channelHint)}${detailMsg}`;
        if (currentMessageId) {
          try {
            await reply.edit(currentMessageId, errorHtml);
          } catch (e) {
            await reply.send(errorHtml);
          }
        } else {
          await reply.send(errorHtml);
        }
      }



  } catch (e: any) {
    logger.error(`[messageLoop] Error running prompt: ${e?.message || e}`);
    if (signal.aborted) {
      await reply.send(`${ICONS.cancel} Task cancelled by the user.`);
    } else {
      await reply.send(`${ICONS.error} Error: ${e?.message || String(e)}`);
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

/**
 * Error code mapping for better error detection and user-friendly messages
 */
const ERROR_CODE_MAP: Record<string, {
    type: string;
    message: string;
    suggestion: string;
}> = {
    // Rate Limit
    "429": { type: "rate_limit", message: "Rate limit exceeded (throttled)", suggestion: "Wait 1-2 minutes and retry, or switch models" },
    "quota": { type: "rate_limit", message: "Quota exhausted", suggestion: "Quota used up, wait for recovery or downgrade model" },
    "exhausted": { type: "rate_limit", message: "Resources exhausted", suggestion: "Please retry later" },
    "rate_limit": { type: "rate_limit", message: "Rate limit exceeded", suggestion: "Lower call frequency or downgrade model" },
    "rate_limit_exceeded": { type: "rate_limit", message: "Rate limit exceeded", suggestion: "Lower call frequency or downgrade model" },

    // Connection
    "ECONNREFUSED": { type: "connection", message: "Connection refused", suggestion: "Backend not started, check service status" },
    "ECONNRESET": { type: "connection", message: "Connection reset", suggestion: "Unstable network, please retry later" },
    "ENETUNREACH": { type: "connection", message: "Network unreachable", suggestion: "Check network connection" },
    "ETIMEDOUT": { type: "connection", message: "Connection timed out", suggestion: "Increase timeout or check network" },
    "socket hang up": { type: "connection", message: "Connection hung up", suggestion: "Unstable network, please retry later" },
    "connection refused": { type: "connection", message: "Connection refused", suggestion: "Check backend service status" },

    // Authentication
    "401": { type: "auth", message: "Authentication failed (invalid token)", suggestion: "Check the token in the config file" },
    "403": { type: "auth", message: "Access forbidden (no permission)", suggestion: "Check if the bot token is correct" },
    "invalid token": { type: "auth", message: "Invalid token", suggestion: "Reconfigure the bot token" },
    "unauthorized": { type: "auth", message: "Unauthorized (401)", suggestion: "Check if the bot token is correct" },
    "authentication failed": { type: "auth", message: "Authentication failed", suggestion: "Check if the bot token is correct" },

    // Timeout
    "timeout": { type: "timeout", message: "Request timed out", suggestion: "Increase timeout or check network" },
    "client timeout": { type: "timeout", message: "Client timed out", suggestion: "Increase timeout" },
    "upstream timeout": { type: "timeout", message: "Upstream timed out", suggestion: "Increase timeout" },

    // Backend Unavailable
    "backend_unavailable": { type: "backend", message: "Backend unavailable", suggestion: "Backend under maintenance, please retry later" },

    // Unknown
    "unknown": { type: "unknown", message: "Unknown error", suggestion: "Please retry later or downgrade model" },
};

/**
 * Error severity levels
 */
const ERROR_SEVERITY: Record<string, "critical" | "warning" | "info"> = {
    // Critical - immediate attention needed
    "ECONNREFUSED": "critical",
    "401": "critical",
    "403": "critical",
    "invalid_token": "critical",

    // Warning - can retry
    "429": "warning",
    "quota": "warning",
    "ETIMEDOUT": "warning",
    "ECONNRESET": "warning",

    // Info - normal errors
    "backend_unavailable": "info",
    "unknown": "info",
};

/**
 * Extract error channel from error message
 */
function extractErrorChannel(reason: string): string | undefined {
    const lowerReason = reason.toLowerCase();
    if (lowerReason.includes('agy')) return 'agy (local)';
    if (lowerReason.includes('deepseek')) return 'deepseek-api (proxy)';
    if (lowerReason.includes('web2api')) return 'web2api (proxy)';
    if (lowerReason.includes('opencode')) return 'opencode (local)';
    return undefined;
}

/**
 * Parse error message and extract key information
 */
function parseErrorMessage(reason: string): {
    type: string;
    code: string;
    channel: string | undefined;
    message: string;
    suggestion: string;
} {
    const text = reason.trim();
    const lowerText = text.toLowerCase();

    // Find error type
    let errorType = 'unknown';
    let errorCode = '';

    // Check for specific error codes
    for (const [code, info] of Object.entries(ERROR_CODE_MAP)) {
        if (lowerText.includes(code) || lowerText.includes(info.type)) {
            errorType = info.type;
            errorCode = code;
            break;
        }
    }

    // Extract error code from message
    if (!errorCode && lowerText.match(/\d{3}/)) {
        const match = lowerText.match(/(\d{3})/);
        if (match) {
            errorCode = match[1];
            errorType = 'unknown'; // Don't assume type without mapping
        }
    }

    // Extract channel
    const channel = extractErrorChannel(reason);

    // Build suggestion
    const suggestion = ERROR_CODE_MAP[errorCode]?.suggestion ||
        (ERROR_SEVERITY[errorCode] === 'critical'
            ? 'Please retry later or downgrade the model'
            : 'Please retry later');

    return {
        type: errorType,
        code: errorCode,
        channel,
        message: text,
        suggestion,
    };
}

// ── Model registry & fallback helpers ──────────────────────────────────────
//
// Model order is resolved dynamically from config sources (priority chain):
//   1. config.json orderedModels (user override)
//   2. config.json modelsConfig.tiers (user tiered config)
//   3. models.json defaultOrder (developer-maintained fallback)
//
// The fallback chain is built per session by slicing this order starting at the
// user's current model and wrapping around — so a user on a mid-tier model
// first tries weaker models, then loops back to the strongest ones.
//
// Three "channels" exist:
//   • agy       — official Antigravity CLI models (require OAuth / API key)
//   • deepseek  — local deepseek-api proxy
//   • web2api   — free Gemini web frontend via reverse proxy (no auth needed)
//
// The channel is detected at runtime by getChannelModel() using model-name
// prefixes, so cross-channel fallback is fully automatic.

