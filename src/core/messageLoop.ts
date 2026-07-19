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
import { markdownToRichBlocksDelta } from '../channels/telegram/formatter.js';
import { runAgyPrint, extractThoughtAndContent, getModelCapabilities } from '../agy/agyCli.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker, parseFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';
import type { RichBlock } from '../channels/telegram/richMessage.js';

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
  const fenceMatch = /^```([a-zA-Z0-9_-]*)\n([\s\S]*)\n```$/.exec(trimmed);
  if (!fenceMatch) return text;
  const lang = (fenceMatch[1] || '').toLowerCase();
  // Only strip when it's a markdown/empty fence wrapping the whole message.
  if (lang && lang !== 'markdown' && lang !== 'md') return text;
  return fenceMatch[2];
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

  const capabilities = getModelCapabilities(session.model);
  const parseMode = session.settings?.telegram?.parseMode || 'RichText';
  // Rich append-only path: requires the new block-streaming primitives.
  const isRichSingleMessage = !!reply.sendRichDraftBlocks && (capabilities.supportsThinkingSummary || parseMode === 'RichText');

  // ── Single-draft append-only state machine ────────────────────────────────
  // Exactly ONE RichBlock[] is the source of truth for the whole reply. Block
  // order is FIXED: [thinkingBlock?, ...bodyBlocks, footerBlock?]. We only ever
  // PUSH to the end of the body region; we never reorder, rebuild, or replace
  // the array. Telegram has no native "append", so growing the message means
  // resending the whole current array under the same draft_id / message_id —
  // idempotent and safe against retries, duplicates and out-of-order chunks.
  type Phase = 'thinking' | 'body' | 'footer';
  let phase: Phase = 'thinking';
  let blocks: RichBlock[] = [];
  let thinkingBlockIndex = -1;
  let footerBlockIndex = -1;
  let convertedBodyLen = 0;

  const buildThinkingBlock = (text: string, isStreaming: boolean): RichBlock => ({
    type: 'details',
    summary: isStreaming ? '🧠 正在思考... (Thinking...)' : '🧠 思考过程 (Thinking Process)',
    is_open: isStreaming || undefined,
    blocks: [{ type: 'paragraph', text: text }],
  });

  // Render the whole authoritative array to the wire (draft while streaming,
  // real message once finalized). Never called with a partial/reordered array.
  const flushBlocks = async () => {
    if (currentMessageId === null || currentMessageId === 0) {
      const resId = await reply.sendRichDraftBlocks!(0, blocks);
      if (typeof resId === 'number' && resId > 0) currentMessageId = resId;
    } else if (phase === 'footer') {
      // Finalized: promote draft to a real persisted message carrying the SAME
      // blocks array (no rebuild, no second message, no coverage).
      const realId = await reply.editRichBlocks!(currentMessageId, blocks);
      if (typeof realId === 'number' && realId > 0) currentMessageId = realId;
    } else {
      await reply.sendRichDraftBlocks!(currentMessageId, blocks);
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
        if (!isRichSingleMessage) {
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

        // ── Rich append-only path ──
        if (phase === 'thinking') {
          // Thinking block created once; only its text grows. While still
          // thinking we have no body yet, so the array is just [thinking].
          if (thinkingBlockIndex < 0 && thoughtBuffer.trim()) {
            blocks.push(buildThinkingBlock(thoughtBuffer.trim(), true));
            thinkingBlockIndex = blocks.length - 1;
          } else if (thinkingBlockIndex >= 0) {
            blocks[thinkingBlockIndex] = buildThinkingBlock(thoughtBuffer.trim(), true);
          }
          if (blocks.length > 0) await flushBlocks();
          return;
        }

        // phase === 'body' (or footer): append new body blocks before footer.
        const delta = markdownToRichBlocksDelta(convertedBodyLen === 0 ? '' : answerBuffer.slice(0, convertedBodyLen), answerBuffer);
        if (delta.length > 0) {
          if (footerBlockIndex >= 0) {
            blocks.splice(footerBlockIndex, 0, ...delta);
            footerBlockIndex += delta.length;
          } else {
            blocks.push(...delta);
          }
          convertedBodyLen = answerBuffer.length;
          await flushBlocks();
        }
      } catch (e) {
        logger.warn(`[messageLoop] Failed to update streaming blocks: ${e}`);
      }
    });

    await activeUpdatePromise;
  };

    const cwd = session.currentProject?.path || process.cwd();

    try {
      session.busy = true;
      session._busySince = Date.now();
      session.turnCount++;

      let modelToUse = session.model;
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      let lastResult: any = null;
      let lastErrorMessage = '';

      let thoughtEventCount = 0;
      let textEventCount = 0;

      let turnStartTime = 0;

      while (attempts < maxAttempts && !success) {
        attempts++;
        thoughtBuffer = '';
        answerBuffer = '';
        isDone = false;
        thoughtEventCount = 0;
        textEventCount = 0;

        let rawStreamBuffer = '';

        try {
          logger.info(`[messageLoop] Attempt ${attempts}: Running prompt with model="${modelToUse}"`);
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
                // Transition from thinking → body: only when body text starts arriving
                if (phase === 'thinking' && answerBuffer.trim()) {
                  phase = 'body';
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

          if (isRateLimitOrUnavailableError(stderr, output)) {
            const nextModel = modelToUse ? getFallbackModel(modelToUse) : null;
            if (nextModel && attempts < maxAttempts) {
              logger.warn(`[messageLoop] Model "${modelToUse}" hit rate limit/unavailable. Stderr: "${stderr}". Output: "${output}". Falling back to "${nextModel}" (Attempt ${attempts}/${maxAttempts}).`);
              
              await reply.send(`${ICONS.warning} ⚠️ 当前模型 \`${modelToUse}\` 遭遇频控或不可用，正在自动降级至 \`${nextModel}\` 重试...`);
              
              currentMessageId = null; // Fresh message for next model stream
              modelToUse = nextModel;
              continue;
            }
          }

          break; // Non-fallback error, or max attempts reached
        } catch (e: any) {
          logger.error(`[messageLoop] Attempt ${attempts} error: ${e?.message || e}`);
          if (signal.aborted) throw e;

          const errMsg = e?.message || String(e);
          if (isRateLimitOrUnavailableError(errMsg, '')) {
            const nextModel = modelToUse ? getFallbackModel(modelToUse) : null;
            if (nextModel && attempts < maxAttempts) {
              logger.warn(`[messageLoop] Model "${modelToUse}" threw rate-limit/unavailable error. Falling back to "${nextModel}" (Attempt ${attempts}/${maxAttempts}).`);
              await reply.send(`${ICONS.warning} ⚠️ 当前模型 \`${modelToUse}\` 出现调用异常，正在自动降级至 \`${nextModel}\` 重试...`);
              currentMessageId = null;
              modelToUse = nextModel;
              continue;
            }
          }
          // Capture the error so the final render block can surface a clear,
          // user-facing message instead of leaving the chat silently unanswered.
          lastErrorMessage = errMsg;
          break;
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


      // 5. Append-only finalize of the SAME single draft (no rebuild, no second
      //    message, no coverage). The authoritative `blocks` array is finalized
      //    in place: (a) close the thinking block if still open, (b) convert any
      //    remaining body markdown not yet pushed, (c) append exactly one footer
      //    block. Order is [thinking, ...body, footer] and never changes.

      // (a) Close / fill the thinking block (native `details`, collapsed).
      if (thoughtBuffer.trim()) {
        const closedThinking: RichBlock = {
          type: 'details',
          summary: '🧠 思考过程 (Thinking Process)',
          blocks: [{ type: 'paragraph', text: thoughtBuffer.trim() }],
        };
        if (thinkingBlockIndex >= 0) {
          blocks[thinkingBlockIndex] = closedThinking;
        } else {
          blocks.unshift(closedThinking);
          thinkingBlockIndex = 0;
          footerBlockIndex = footerBlockIndex >= 0 ? footerBlockIndex + 1 : -1;
        }
      }

      // (a2) Strip blockquote blocks → plain paragraphs to avoid details+blockquote nesting.
      // Also hoist the first heading block above the thinking block when thought is present.
      {
        // Replace any blockquote blocks already accumulated with plain paragraphs
        for (let bi = 0; bi < blocks.length; bi++) {
          const blk = blocks[bi] as any;
          if (blk.type === 'blockquote') {
            // Flatten its inner blocks into paragraphs in-place
            const inner: RichBlock[] = (blk.blocks || []).map((b: any) => ({ type: 'paragraph', text: b.text }));
            blocks.splice(bi, 1, ...inner);
            bi += inner.length - 1;
          }
        }

        // Hoist leading heading above thinking block
        if (thinkingBlockIndex >= 0) {
          // Find first non-thinking, non-footer heading after thinkingBlockIndex
          const firstBodyHeadingIdx = blocks.findIndex(
            (b, i) => i !== thinkingBlockIndex && (b as any).type === 'heading'
          );
          if (firstBodyHeadingIdx > thinkingBlockIndex) {
            // Move it before thinkingBlock
            const [headingBlock] = blocks.splice(firstBodyHeadingIdx, 1);
            blocks.unshift(headingBlock);
            thinkingBlockIndex = 1; // was 0, now shifted by heading
            if (footerBlockIndex >= 0) footerBlockIndex++;
          }
        }
      }

      // (b) Convert any leftover body markdown (the delta not yet streamed).
      if (answerBuffer.trim()) {
        const remaining = markdownToRichBlocksDelta(
          convertedBodyLen === 0 ? '' : answerBuffer.slice(0, convertedBodyLen),
          answerBuffer,
        );
        if (remaining.length > 0) {
          if (footerBlockIndex >= 0) blocks.splice(footerBlockIndex, 0, ...remaining);
          else blocks.push(...remaining);
          convertedBodyLen = answerBuffer.length;
        }
      }

      // (c) Append exactly one footer block (stats line). If thinking was
      // recovered but the body is empty, the message is still a single draft.
      const footerMarker = formatFooterMarker(
        modelToUse || 'Gemini 3.5 Flash (Medium)',
        finalPrompt,
        answerBuffer + (thoughtBuffer.trim() ? '\n' + thoughtBuffer.trim() : ''),
        finalResult.usage,
      );
      if (finalResult.exitCode === 0) {
        const footerParts = parseFooterMarker(footerMarker);
        if (footerParts.length > 0) {
          if (footerBlockIndex >= 0) {
            blocks[footerBlockIndex] = { type: 'footer', text: `⚙️ ${footerParts.join(' · ')}` };
          } else {
            blocks.push({ type: 'footer', text: `⚙️ ${footerParts.join(' · ')}` });
            footerBlockIndex = blocks.length - 1;
          }
        }

        // Atomically commit the single draft → one real persisted message.
        if (isRichSingleMessage) {
          if (currentMessageId !== null && blocks.length > 0) {
            phase = 'footer';
            try {
              await reply.editRichBlocks!(currentMessageId, blocks);
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim());
            } catch (e) {
              logger.warn(`[messageLoop] Failed to commit final blocks, falling back to sendRich: ${e}`);
              try {
                const footerText = footerParts.length > 0 ? `⚙️ ${footerParts.join(' · ')}` : undefined;
                currentMessageId = await reply.sendRich!({ content: answerBuffer.trim(), thought: thoughtBuffer.trim(), footerText });
                if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim());
              } catch (e2) {
                logger.warn(`[messageLoop] sendRich fallback failed: ${e2}`);
              }
            }
          } else if (blocks.length > 0) {
            // No draft was ever created (e.g. extremely fast completion): send once.
            try {
              const footerText = footerParts.length > 0 ? `⚙️ ${footerParts.join(' · ')}` : undefined;
              currentMessageId = await reply.sendRich!({ content: answerBuffer.trim(), thought: thoughtBuffer.trim(), footerText });
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim());
            } catch (e) {
              logger.warn(`[messageLoop] sendRich failed: ${e}`);
            }
          }
        } else if (answerBuffer.trim()) {
          // Plain-text fallback finalize (no rich primitives available).
          const finalText = thoughtBuffer.trim()
            ? `🧠 思考过程 (Thinking Process)\n\n${thoughtBuffer.trim()}\n\n${answerBuffer.trim()}`
            : answerBuffer.trim();
          try {
            if (currentMessageId !== null) {
              await reply.edit!(currentMessageId, finalText);
              messageCache.set(currentMessageId, answerBuffer.trim());
            } else {
              currentMessageId = await reply.send!(finalText);
              if (answerBuffer.trim()) messageCache.set(currentMessageId, answerBuffer.trim());
            }
          } catch (e) {
            logger.warn(`[messageLoop] Plain finalize failed: ${e}`);
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

    // 6. Handle Autopilot autonomous loops
    if (session.autopilot?.active) {
      const config = session.autopilot;
      
      // Check if maximum iterations reached
      if (config.currentIteration >= config.maxIterations) {
        session.autopilot.active = false;
        await reply.send(`${ICONS.warning} [Autopilot] 已达到最大自主迭代次数限制 (${config.maxIterations} 次)，自主循环已停止。`);
        return;
      }

      // Check for stop keywords in AI response
      const lowercaseOutput = answerBuffer.toLowerCase();
      const triggeredStop = config.stopKeywords.find(kw => lowercaseOutput.includes(kw.toLowerCase()));
      if (triggeredStop) {
        session.autopilot.active = false;
        await reply.send(`${ICONS.success} [Autopilot] 检测到终止关键字 "${triggeredStop}"，自主循环优雅结束。`);
        return;
      }

      // Proceed with next iteration
      config.currentIteration++;
      const nextIterationStatusMsg = await reply.send(
        `${ICONS.processing} *[Autopilot 自主迭代 ${config.currentIteration}/${config.maxIterations}]*\n` +
        `正在评估并开始执行下一阶段目标: \`"${config.goal}"\` ...`
      );

      // Auto-trigger next processMessage step recursively
      const nextPrompt = `请继续推进您的工作并执行下一步。当前总目标是："${config.goal}"。\n` +
        `如果您觉得已经完美达成该目标，或者已经无法继续前行，请务必在您的回答中包含 "TASK_COMPLETE" 关键字以结束本轮循环。`;

      // Delay slightly for better UX feel
      await new Promise(r => setTimeout(r, 1500));
      await reply.delete(nextIterationStatusMsg);

      await processMessage(
        session,
        { text: nextPrompt },
        reply,
        formatter
      );
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

const FALLBACK_MAP: Record<string, string> = {
  'Claude Opus 4.6 (Thinking)': 'Claude Sonnet 4.6 (Thinking)',
  'Claude Sonnet 4.6 (Thinking)': 'Gemini 3.1 Pro (High)',
  'GPT-OSS 120B (Medium)': 'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (High)': 'Gemini 3.5 Flash (High)',
  'Gemini 3.1 Pro (Low)': 'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash (Low)',
  'Gemini 3.5 Flash (Low)': 'Web2API: Gemini Auto',
  'Web2API: Gemini 3.5 Flash Thinking': 'Web2API: Gemini 3.5 Flash Thinking Lite',
  'Web2API: Gemini 3.5 Flash Thinking Lite': 'Web2API: Gemini 3.1 Pro',
  'Web2API: Gemini 3.1 Pro': 'Web2API: Gemini 3.5 Flash',
  'Web2API: Gemini 3.5 Flash': 'Web2API: Gemini Flash Lite',
  'Web2API: Gemini Flash Lite': 'Web2API: Gemini Auto',
};

export function getFallbackModel(currentModel: string): string | null {
  return FALLBACK_MAP[currentModel] ?? null;
}

export function isRateLimitOrUnavailableError(stderr: string, output: string): boolean {
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
