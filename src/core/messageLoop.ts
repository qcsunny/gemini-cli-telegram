/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import type { DaemonSession, ChannelReply, MessageFormatter, MultimodalInput } from './types.js';
import { logger } from '../utils/logger.js';
import { ICONS } from '../channels/telegram/ui.js';
import { runAgyPrint, extractThoughtAndContent } from '../agy/agyCli.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker, parseFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';

const DEBOUNCE_INTERVAL_MS = 1000;

/**
 * Overall guard for a single model run. The underlying web2api/http request has
 * its own socket timeout, but if a response hangs before that fires (e.g. an
 * upstream stall with no bytes sent), the Promise would never resolve and the
 * user would see a silent "no reply". This wrapper guarantees the call always
 * settles, surfacing a clear error instead of hanging forever.
 */
/**
 * Hard cap on a single model run (wall-clock from start, NEVER reset by
 * activity). A streamed reply that runs longer than this is killed. 15 min is
 * ~180k Chinese chars at 200 char/s — far beyond any daily need; longer means
 * the model is stuck in a loop.
 */
const MODEL_RUN_HARD_TIMEOUT_MS = 900_000;
/**
 * Inactivity guard: if there has been NO streamed output for this long, the run
 * is treated as a genuine upstream stall and killed. Reset on every streamed
 * chunk so an actively-streaming (even slow) reply is never killed.
 */
const MODEL_RUN_INACTIVITY_MS = 600_000;

/**
 * Overall guard for a single model run. Two independent timers race the run:
 *  - a HARD total cap (never reset), and
 *  - an INACTIVITY timer that resets on each streamed chunk/event.
 * `onActivity` lets the caller report progress to reset the inactivity timer.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  modelLabel: string,
  onActivity?: () => void,
): Promise<{ result: T; resetInactivity: () => void }> {
  let hardTimer: NodeJS.Timeout | undefined;
  let inactTimer: NodeJS.Timeout | undefined;
  let reject: (reason?: any) => void;

  const fire = (msg: string) => {
    if (reject) reject(new Error(msg));
  };

  // Hard total cap — set once, never reset.
  hardTimer = setTimeout(() => {
    fire(`模型 \`${modelLabel}\` 单次运行超过 ${MODEL_RUN_HARD_TIMEOUT_MS / 60000} 分钟被强制终止（疑似模型陷入死循环或上游挂起）。请稍后重试，或拆分问题。`);
  }, MODEL_RUN_HARD_TIMEOUT_MS);

  // Inactivity timer — reset on activity.
  const armInactivity = () => {
    if (inactTimer) clearTimeout(inactTimer);
    inactTimer = setTimeout(() => {
      fire(`模型 \`${modelLabel}\` 在 ${MODEL_RUN_INACTIVITY_MS / 60000} 分钟内无输出（疑似上游服务挂起）。请稍后重试，或切换到其它模型。`);
    }, MODEL_RUN_INACTIVITY_MS);
  };
  armInactivity();

  const timeout: Promise<never> = new Promise((_reject) => {
    reject = _reject;
  });

  const activity = () => {
    if (onActivity) onActivity();
    armInactivity();
  };

  try {
    const result = await Promise.race([promise, timeout]);
    return { result, resetInactivity: activity };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (inactTimer) clearTimeout(inactTimer);
  }
}

/**
 * Web2API (Gemini web2api) frequently returns the whole answer wrapped in a
 * single fenced code block (e.g. ```markdown ... ```). The markdown renderer
 * treats a fenced block as literal code, so headings / bold / tables inside are
 * lost. If the ENTIRE content is wrapped in exactly one fence (language
 * `markdown` or empty), strip the fence so the inner markdown renders normally.
 * Content containing multiple or inline code blocks is left untouched.
 */
function stripWholeMessageCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/.exec(trimmed);
  if (!fenceMatch) return text;
  const lang = (fenceMatch[1] || '').toLowerCase();
  // Only strip when it's a markdown/empty fence wrapping the whole message.
  if (lang && lang !== 'markdown' && lang !== 'md') return text;
  const inner = fenceMatch[2];
  // If inner content contains ``` delimiters, this is a nested fence:
  // keep the outer fence and render as code block.
  if (/^```/m.test(inner.trim())) return text;
  return inner;
}

/**
 * Gemini (web2api) sometimes emits a fenced code block whose opening/closing
 * ``` delimiter is glued to preceding text on the same line (e.g.
 * "示例）：```python"). The markdown parser only recognizes a fence when the
 * ``` sits on its own line, so a mid-line delimiter is rendered as literal
 * text and the trailing content after the (unterminated) block is lost.
 * Insert a newline so every ``` delimiter starts its own line.
 */
function normalizeCodeFences(text: string): string {
  // Opening fence glued to preceding text: "示例）：```python" -> put it on its own line
  let out = text.replace(/([^\n`])```([a-zA-Z0-9_+-]*)/g, '$1\n```$2');
  // Closing fence glued to preceding text: "code```" -> put it on its own line
  out = out.replace(/([^\n`])```/g, '$1\n```');
  return out;
}

/**
 * Defense-in-depth: if a web-search / extensions result card leaks past the
 * server filter, strip blocks that look like Gemini's search-result JSON
 * ({"heading":..,"actions":{"open_url":..}}) so they are never rendered as a
 * code block in Telegram.
 */
function stripSearchResultPayloads(text: string): string {
  return text
    .replace(/```(?:json)?\s*\{[^{}]*"open_url"[^{}]*\}\s*```/g, '')
    .replace(/\{[^{}]*"heading"[^{}]*"subheading"[^{}]*\}/g, '')
    .replace(/\{\s*"actions"\s*:\s*\{[^{}]*"open_url"[^{}]*\}\s*\}/g, '');
}


async function detectAndSendNewArtifacts(
  session: DaemonSession,
  conversationId: string,
  turnStartTime: number,
): Promise<void> {
  if (!session.sendMedia || !conversationId) return;

  const baseDir =
    process.env['ANTIGRAVITY_USER_DIR'] ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli');

  const artifactDir = path.join(baseDir, 'brain', conversationId);
  try {
    const files = await fs.readdir(artifactDir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.startsWith('.') || file === 'scratch' || file === '.system_generated' || file === '.user_uploaded') {
        continue;
      }
      const filePath = path.join(artifactDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      // Only detect files created or modified since the current turn started
      // We subtract 2000ms (2s) to handle any clock skew or system clock resolution issues
      if (stat.mtimeMs >= turnStartTime - 2000) {
        const ext = path.extname(file).toLowerCase();
        let mediaType: 'photo' | 'video' | 'audio' | 'voice' | 'document' = 'document';
        if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
          mediaType = 'photo';
        } else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) {
          mediaType = 'video';
        } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
          mediaType = 'audio';
        }

        logger.info(`[messageLoop] Automatically sending generated artifact file to Telegram: ${file} (type: ${mediaType})`);
        try {
          await session.sendMedia(filePath, mediaType, `🎨 Generated: ${file}`);
        } catch (e) {
          logger.error(`[messageLoop] Failed to send media ${file}: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`[messageLoop] Error detecting new artifacts: ${e}`);
  }
}



function normalizeText(text: string): string {
  const { content } = extractThoughtAndContent(text);
  let clean = content.replace(/\r\n/g, '\n');
  clean = clean.replace(/[*_`#>\-+=()[\]]/g, '');
  return clean.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function readThoughtFromTranscript(
  conversationId: string,
  answerBuffer: string,
  turnStartTime: number
): Promise<{ thought: string; source: string } | null> {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return null;
  }
  const startTime = Date.now();
  const baseDir =
    process.env['ANTIGRAVITY_USER_DIR'] ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli');

  const filePath = path.join(
    baseDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  let attempts = 0;
  const maxAttempts = 50; // 50 * 100ms = 5 seconds total

  // Normalize the expected answer buffer for accurate validation
  const normAnswer = normalizeText(answerBuffer);
  const answerPrefix = normAnswer.slice(0, 100);

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.trim().split('\n');
      
      let foundStep: any = null;
      let matchedReason = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'PLANNER_RESPONSE' && parsed.status === 'DONE') {
            // Check 1: Recency verification — skip entries that predate this turn
            const createdAtTime = new Date(parsed.created_at).getTime();
            if (!isNaN(createdAtTime)) {
              if (createdAtTime < turnStartTime) {
                matchedReason = 'Entry predates turn start';
                continue;
              }
            }

            // Check 2: Content consistency validation on isolated answer body
            if (answerPrefix) {
              const normContent = normalizeText(parsed.content || '');
              if (!normContent.includes(answerPrefix)) {
                matchedReason = `Content mismatch: prefix "${answerPrefix.slice(0, 20)}..." not in content`;
                continue;
              }
            }

            foundStep = parsed;
            matchedReason = 'Matched successfully';
            break;
          }
        } catch {
          // ignore corrupted/partially written lines during poll
        }
      }

      if (foundStep) {
        const stats = await fs.stat(filePath);
        const latency = Date.now() - startTime;
        
        // Priority 1: parsed.thinking (native Gemini reasoning tokens)
        if (foundStep.thinking && typeof foundStep.thinking === 'string' && foundStep.thinking.trim()) {
          const thought = foundStep.thinking.trim();
          logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=thinking, length=${thought.length}, hasNewlines=${thought.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
          return { thought, source: 'thinking' };
        }

        // Priority 2: parsed.content extracted thought
        if (foundStep.content && typeof foundStep.content === 'string') {
          const { thought } = extractThoughtAndContent(foundStep.content);
          if (thought.trim()) {
            const recovered = thought.trim();
            logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=content:extracted, length=${recovered.length}, hasNewlines=${recovered.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
            return { thought: recovered, source: 'content:extracted' };
          }
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.debug(`[messageLoop] Error polling transcript: ${err.message || err}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const latency = Date.now() - startTime;
  logger.warn(`[messageLoop] [TRANSCRIPT] Timeout waiting for transcript: conversationId=${conversationId}, filePath=${filePath}, waitCount=${attempts}, latency=${latency}ms`);
  return null;
}

/**
 * Channel-agnostic message processing loop using local agy CLI wrapper.
 * Streams output to the channel in real-time, manages session mappings,
 * and handles autonomous Autopilot loops entirely on the Node side.
 */
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
    await reply.send(`${ICONS.cancel} 任务已被取消。`);
    return;
  }

  // 1. Prepare prompt and resolve local multimedia file paths
  let finalPrompt = input.text || '';
  if (input.media && input.media.length > 0) {
    const mediaLines = input.media.map(item => {
      return `[本地关联文件 - 类型: ${item.type}, 物理路径: "${item.path}", 原始文件名: "${item.fileName || '未知'}"]`;
    });
    finalPrompt = `${mediaLines.join('\n')}\n\n${finalPrompt}`;
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
    const content: { content: string; thought?: string } = {
      content: answerBuffer.trim(),
    };
    if (thoughtBuffer.trim()) content.thought = thoughtBuffer.trim();

    if (currentMessageId === null || currentMessageId === 0) {
      const resId = await reply.sendRichDraft!(content);
      if (typeof resId === 'number' && resId > 0) currentMessageId = resId;
    } else if (phase === 'footer') {
      currentMessageId = await reply.sendRich!(content);
    } else {
      await reply.sendRichDraft!(content);
    }
  };

  // Stream editing helper — append-only.
  const updateMessageStream = async (isFinal = false) => {
    if (isFinished && !isFinal) return;
    const now = Date.now();
    if (!isFinal && now - lastEditTime < DEBOUNCE_INTERVAL_MS) return;
    lastEditTime = now;

    activeUpdatePromise = activeUpdatePromise.then(async () => {
      if (isFinished && !isFinal) return;
      try {
        if (!hasRichPrimitives) {
          // Non-rich fallback: plain text (thinking then body), single message path.
          let text = '';
          if (thoughtBuffer.trim()) {
            const prefix = isFinal ? '🧠 思考过程 (Thinking Process)\n\n' : '🧠 正在思考... (Thinking...)\n\n';
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

      // Build the ordered fallback chain starting from the session's model.
      // Uses buildChannelAwareChain which traverses ORDERED_MODELS in a circular chain.
      const chain = buildChannelAwareChain(session.model || ORDERED_MODELS[0]);

      // Retry policy (per the agreed design):
      //   • Each model is attempted up to RETRIES_PER_MODEL times.
      //   • On exhausting a model's retries, downgrade to the next-weaker
      //     model in the fallback chain (starting from the session's model).
      //   • The chain is walked in a CIRCULAR fashion: after reaching the
      //     weakest model, it wraps back to the strongest. This handles
      //     temporary failures (rate limits, transient errors) where a model
      //     may recover after a brief cooldown.
      //   • Total budget is chain.length * RETRIES_PER_MODEL.
      const RETRIES_PER_MODEL = 3;
      const maxAttempts = chain.length * RETRIES_PER_MODEL;

      let modelToUse = chain[0];
      let chainIdx = 0;          // index into `chain`
      let failsForModel = 0;     // consecutive failures on the current model
      let attempts = 0;
      let success = false;
      let lastResult: any = null;
      let lastErrorMessage = '';

      const escReason = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 200);

      // Step to the next model in the chain, walking CIRCULAR with
      // NO wrap-around. Returns true if we moved to a weaker model (caller
      // continues), or false if we are already at the LAST model in the chain
      // (the one that sits right before the starting model in the loop) — in
      // which case there is no further downgrade and the caller terminates.
      const advanceModel = async (reason: string): Promise<boolean> => {
        const prevModel = modelToUse;
        if (chainIdx + 1 >= chain.length) {
          logger.warn(`[messageLoop] Model "${prevModel}" failed (${reason}). No further fallback available — terminating (attempt ${attempts}/${maxAttempts}).`);
          return false;
        }
        chainIdx++;
        modelToUse = chain[chainIdx];
        failsForModel = 0;
        const prevCh = getChannelModel(prevModel);
        const nextCh = getChannelModel(modelToUse);
        const switchedChannel = prevCh && nextCh && prevCh !== nextCh;
        const logTag = switchedChannel ? `[messageLoop] 🔀 Channel switch ${prevCh}→${nextCh}` : '[messageLoop]';
        logger.warn(`${logTag} Model "${prevModel}" failed (${reason}). Downgrading to "${modelToUse}" (attempt ${attempts}/${maxAttempts}).`);
        const switchNote = switchedChannel ? `（切换至 ${nextCh} 通道）` : '';
        await reply.send(`${ICONS.warning} ⚠️ 当前模型 \`${prevModel}\` 调用失败（${escReason(reason)}），正在自动降级至 \`${modelToUse}\`${switchNote} 重试...`);
        return true;
      };

      let thoughtEventCount = 0;
      let textEventCount = 0;

      let turnStartTime = 0;

      while (attempts < maxAttempts && !success) {
        attempts++;
        // Reset per-attempt buffers AND the single-draft streaming state so a
        // new attempt starts from a clean slate (otherwise a failed attempt's
        // partial blocks would leak into the next attempt's message).
        thoughtBuffer = '';
        answerBuffer = '';
        isDone = false;
        currentMessageId = null;
        phase = 'thinking';
        thoughtEventCount = 0;
        textEventCount = 0;

        let rawStreamBuffer = '';

        try {
          logger.info(`[messageLoop] Attempt ${attempts}/${maxAttempts}: Running prompt with model="${modelToUse}" (model retry ${failsForModel + 1}/${RETRIES_PER_MODEL})`);
          turnStartTime = Date.now();
          let resetInactivity: (() => void) | undefined;
          const { result } = await withTimeout(runAgyPrint({
            prompt: finalPrompt,
            cwd,
            conversationId: session.conversationId,
            model: modelToUse,
            proxy: session.proxy,
            signal,
            onActivity: () => { if (resetInactivity) resetInactivity(); },
            onSpawn: (pid) => { session.childPid = pid; },
            onEvent: (event) => {
              // Any streamed event counts as progress: reset both the model-run
              // inactivity timer and the bot's stuck-session watchdog (_busySince)
              // so a slow-but-active long reply is never killed mid-stream.
              if (resetInactivity) resetInactivity();
              session._busySince = Date.now();
              if (event.type === 'thought') {
                thoughtEventCount++;
              } else if (event.type === 'text') {
                textEventCount++;
              }

              logger.debug(`[EVENT] type="${event.type}" content.length=${event.content?.length || 0} content_preview="${(event.content || '').slice(0, 100).replace(/\n/g, '\\n')}"`);

              if (event.type === 'thought') {
                thoughtBuffer += event.content || '';
              } else if (event.type === 'text') {
                rawStreamBuffer += event.content || '';
                const parsed = extractThoughtAndContent(rawStreamBuffer);
                if (parsed.thought) {
                  thoughtBuffer = parsed.thought;
                  answerBuffer = parsed.content;
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
          }), modelToUse || session.model || 'unknown');

          lastResult = result;

          if (result.exitCode === 0) {
            success = true;
            // If we had to fall back, persist the change to disk and update session
            if (modelToUse && modelToUse !== session.model) {
              logger.info(`[messageLoop] Successfully downgraded to model "${modelToUse}". Updating session.`);
              session.model = modelToUse;
              await setConversation(chatId, result.conversationId || session.conversationId || '', cwd, modelToUse);
            }
            break;
          }

          const stderr = result.stderr || '';
          const output = result.output || answerBuffer;

          // ANY non-success is eligible for a retry/downgrade (rate-limit,
          // auth error, process termination, hard timeout, generic error).
          const reason = isRateLimitOrUnavailableError(stderr, output)
            ? '频控或上游不可用'
            : (stderr.trim() || output.trim() || '未知错误');
          failsForModel++;
          if (failsForModel < RETRIES_PER_MODEL) continue; // retry same model
          if (await advanceModel(reason)) continue;          // downgrade to next
          break;                                            // last model failed → terminate
        } catch (e: any) {
          logger.error(`[messageLoop] Attempt ${attempts} error: ${e?.message || e}`);
          if (signal.aborted) throw e;

          // ANY thrown error is eligible for a retry/downgrade (including
          // hard-timeout / inactivity kills from withTimeout, auth errors,
          // process termination, and generic failures) — not just rate-limits.
          const errMsg = e?.message || String(e);
          lastErrorMessage = errMsg;
          const reason = isRateLimitOrUnavailableError(errMsg, '')
            ? '频控或上游不可用'
            : errMsg;
          failsForModel++;
          if (failsForModel < RETRIES_PER_MODEL) continue; // retry same model
          if (await advanceModel(reason)) continue;          // downgrade to next
          break;                                            // last model failed → terminate
        }
      }

      const finalResult = lastResult || { conversationId: '', output: answerBuffer, exitCode: 1 };

      // 4. Save and persist the updated conversation ID
      if (finalResult.conversationId) {
        session.conversationId = finalResult.conversationId;
        await setConversation(chatId, finalResult.conversationId, cwd, session.model);
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

      // Aggressive stray thought-tag cleanup: if any unpaired <thought> / <thought-gemini>
      // tags survived the extractThoughtAndContent step (e.g. an upstream interrupt
      // mid-tag while body text was already streaming), strip them here so they never
      // leak as literal text into the user-facing final message.
      answerBuffer = answerBuffer
        .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
        .replace(/<thought-gemini[^>]*>[\s\S]*?<\/thought-gemini>/gi, '')
        .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
        .replace(/<\/?thought[^>]*>/gi, '')
        .replace(/<\/?thought-gemini[^>]*>/gi, '')
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

      const footerText = formatFooterMarker(
        modelToUse || 'Gemini 3.5 Flash (Medium)',
        finalPrompt,
        answerBuffer + (thoughtBuffer.trim() ? '\n' + thoughtBuffer.trim() : ''),
        finalResult.usage,
      );

      if (finalResult.exitCode === 0) {
        const footerParts = parseFooterMarker(footerText);

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

            // Use sendRich to finalize the message
            if (reply.sendRich) {
              currentMessageId = await reply.sendRich!(finalContent);
            } else {
              // Plain text fallback
              const finalText = thoughtBuffer.trim()
                ? `🧠 思考过程 (Thinking Process)\n\n${thoughtBuffer.trim()}\n\n${answerBuffer.trim()}`
                : answerBuffer.trim();
              await reply.edit!(currentMessageId, finalText);
            }
            if (answerBuffer.trim()) messageCache.set(currentMessageId!, answerBuffer.trim(), replyContext);
          } catch (e) {
            logger.warn(`[messageLoop] Finalize failed: ${e}`);
            try {
              const finalContent: { content: string; thought?: string; footerText?: string } = {
                content: answerBuffer.trim(),
              };
              if (thoughtBuffer.trim()) finalContent.thought = thoughtBuffer.trim();
              if (footerParts.length > 0) finalContent.footerText = `⚙️ ${footerParts.join(' · ')}`;
              currentMessageId = await reply.sendRich!(finalContent);
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim(), replyContext);
            } catch (e2) {
              logger.warn(`[messageLoop] sendRich fallback failed: ${e2}`);
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
            if (answerBuffer.trim()) messageCache.set(currentMessageId!, answerBuffer.trim(), replyContext);
          } catch (e) {
            logger.warn(`[messageLoop] sendRich (no-draft path) failed: ${e}`);
            try {
              currentMessageId = await reply.send!(answerBuffer.trim());
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim(), replyContext);
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

        let errorReason = '执行失败';
        if (isAuthError) errorReason = '认证已过期或未登录 (Authentication expired or not logged in)';
        if (isTerminated) errorReason = '代理进程异常终止 (Agent execution terminated due to error)';
        if (finalResult.isTimeout || signal.aborted) errorReason = '执行被取消或超时 (Cancelled/Timeout)';

        let detailMsg = '';
        const escapeHtml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        if (isFriendlyUpstreamMsg) {
          detailMsg = `\n\n${escapeHtml(stderrStr.trim())}`;
        } else if (stdoutStr.includes('Welcome to the Antigravity CLI') || stdoutStr.includes('not signed in') || stdoutStr.includes('Authentication required')) {
          detailMsg = `\n\n<b>提示</b>: 检测到本地 agy CLI 处于未登录状态，登录交互信息：\n<pre>Welcome to the Antigravity CLI. You are currently not signed in. Select login method: > 1. Google OAuth</pre>\n请通过 SSH 登录服务器运行 <code>agy auth login</code> 完成重新登录。`;
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
            detailMsg = `\n\n<b>错误详情</b>:\n<pre>${uniqueLines.map(escapeHtml).join('\n')}</pre>`;
          }
        }

        const errorHtml = isFriendlyUpstreamMsg
          ? `${escapeHtml(stderrStr.trim())}`
          : `${ICONS.error} <b>${errorReason}</b>（退出代码: ${finalResult.exitCode}）。${signal.aborted || finalResult.isTimeout ? '任务已被取消或超时（可能是系统看门狗或用户主动停止）。' : (lastErrorMessage ? `\n\n${escapeHtml(lastErrorMessage)}` : '请确认您的本地 \`agy\` CLI 已正确登录并配置网络。')}${detailMsg}`;
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
      await reply.send(`${ICONS.cancel} 任务已被用户取消。`);
    } else {
      await reply.send(`${ICONS.error} 发生错误: ${e?.message || String(e)}`);
    }
  } finally {
    session.busy = false;
    session._busySince = undefined;
    session.childPid = undefined;
  }
}

export const ORDERED_MODELS = [
  // ── Tier 1: 极强推理 (Ultra Reasoning) ──
  'Claude Opus 4.6 (Thinking)',
  'DeepSeek: Pro Thinking',

  // ── Tier 2: 高级推理 (Advanced Reasoning) ──
  'Claude Sonnet 4.6 (Thinking)',
  'Web2API: Gemini 3.1 Pro Enhanced',
  'Gemini 3.1 Pro (High)',
  'Web2API: Gemini 3.1 Pro',
  'DeepSeek: Pro',
  'Gemini 3.1 Pro (Low)',

  // ── Tier 3: 通用智能 (General Capabilities) ──
  'Gemini 3.6 Flash (High)',
  'Web2API: Gemini 3.5 Flash Thinking',
  'DeepSeek: Flash Thinking Search',
  'Gemini 3.6 Flash (Medium)',
  'DeepSeek: Flash Thinking',
  'Web2API: Gemini 3.5 Flash Thinking Lite',
  'Gemini 3.6 Flash (Low)',
  'GPT-OSS 120B (Medium)',
  'Web2API: Gemini 3.5 Flash',

  // ── Tier 4: 快速轻量 (Speed & Light) ──
  'Gemini 3.5 Flash (High)',
  'DeepSeek: Flash Search',
  'Gemini 3.5 Flash (Medium)',
  'DeepSeek: Flash',
  'Web2API: Gemini Auto',
  'Gemini 3.5 Flash (Low)',
  'Web2API: Gemini Flash Lite'
];

function buildChannelAwareChain(startModel: string): string[] {
  const idx = ORDERED_MODELS.indexOf(startModel);
  if (idx === -1) {
    return [startModel, ...ORDERED_MODELS];
  }
  const chain: string[] = [];
  for (let i = idx; i < ORDERED_MODELS.length; i++) {
    chain.push(ORDERED_MODELS[i]);
  }
  for (let i = 0; i < idx; i++) {
    chain.push(ORDERED_MODELS[i]);
  }
  return chain;
}

function getChannelModel(model: string): string | null {
  if (model.startsWith('Web2API:')) return 'web2api';
  if (model.startsWith('DeepSeek:')) return 'deepseek';
  return 'agy';
}

function isRateLimitOrUnavailableError(stderr: string, output: string): boolean {
  const lowerStderr = stderr.toLowerCase();
  const lowerOutput = output.toLowerCase();
  
  const keywords = [
    '429',
    'quota',
    'exhausted',
    'rate_limit',
    'rate limit',
    'limit exceeded',
    'resource_exhausted',
    'unavailable',
    'overloaded',
    'capacity',
  ];

  return keywords.some(keyword => lowerStderr.includes(keyword) || lowerOutput.includes(keyword));
}
