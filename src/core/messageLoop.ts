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
import { logger } from '../utils/logger.js';
import { ICONS, escapeHtml } from '../channels/telegram/ui.js';
import { runAgyPrint, extractThoughtAndContent } from '../agy/agyCli.js';
import { readThoughtFromTranscript } from './messageLoop/transcript.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker, parseFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';
import { getTuningConfig } from '../config/userConfig.js';
import { getEffectiveModelOrder, getChannelModel, buildChannelAwareChain } from './modelRegistry.js';
import { isBackendAvailable, markBackendFailed, markBackendHealthy, isConnectionError, isRateLimitOrUnavailableError } from './backendHealth.js';

import { withTimeout } from './messageLoop/threading.js';
import { stripWholeMessageCodeFence, normalizeCodeFences, stripSearchResultPayloads } from './messageLoop/textUtils.js';
import { detectAndSendNewArtifacts } from './messageLoop/artifact.js';

// Read tuning defaults once at import time; callers use getTuningConfig() for runtime values.
const tuning = getTuningConfig();
const DEBOUNCE_INTERVAL_MS = tuning.debounceIntervalMs;

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

      // Build the circular fallback chain starting from the session's current model.
      // buildChannelAwareChain walks the effective model list (config or hardcoded):
      // starting at the session model, it appends all weaker models, then wraps
      // around to the strongest models (those above the session model) to form a
      // complete circular chain.
      const chain = buildChannelAwareChain(session.model || getEffectiveModelOrder()[0]);

      // Retry policy (per the agreed design):
      //   • Each model is attempted up to retriesPerModel times (configurable via tuning).
      //   • On exhausting a model's retries, downgrade to the next-weaker
      //     model in the fallback chain (starting from the session's model).
      //   • The chain is walked in a CIRCULAR fashion: after reaching the
      //     weakest model, it wraps back to the strongest. This handles
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

      const escReason = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 200);

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
          // Lazy health check: skip this model if its backend is in cooldown.
          {
            const channel = getChannelModel(modelToUse);
            if (!isBackendAvailable(channel)) {
              logger.info(`[messageLoop] Skipping model "${modelToUse}" — backend "${channel}" is in cooldown`);
              if (await advanceModel(`后端 ${channel} 暂时不可用`)) continue;
              break;
            }
          }

          logger.info(`[messageLoop] Attempt ${attempts}/${maxAttempts}: Running prompt with model="${modelToUse}" (model retry ${failsForModel + 1}/${retriesPerModel})`);
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
            markBackendHealthy(getChannelModel(modelToUse));
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

          // Backend health: mark backend failed on connection-level errors
          if (isConnectionError(result.stderr) || isConnectionError(result.output)) {
            markBackendFailed(getChannelModel(modelToUse));
          }

          // ANY non-success is eligible for a retry/downgrade (rate-limit,
          // auth error, process termination, hard timeout, generic error).
          const reason = isRateLimitOrUnavailableError(stderr, output)
            ? '频控或上游不可用'
            : (stderr.trim() || output.trim() || '未知错误');
          failsForModel++;
          if (failsForModel < retriesPerModel) continue; // retry same model
          if (await advanceModel(reason)) continue;          // downgrade to next
          break;                                            // last model failed → terminate
        } catch (e: any) {
          logger.error(`[messageLoop] Attempt ${attempts} error: ${e?.message || e}`);
          if (signal.aborted) throw e;

          // Backend health: mark backend failed on connection-level errors
          if (isConnectionError(e)) {
            markBackendFailed(getChannelModel(modelToUse));
          }

          // ANY thrown error is eligible for a retry/downgrade (including
          // hard-timeout / inactivity kills from withTimeout, auth errors,
          // process termination, and generic failures) — not just rate-limits.
          const errMsg = e?.message || String(e);
          lastErrorMessage = errMsg;
          const reason = isRateLimitOrUnavailableError(errMsg, '')
            ? '频控或上游不可用'
            : errMsg;
          failsForModel++;
          if (failsForModel < retriesPerModel) continue; // retry same model
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

// Re-export from modelRegistry for backward compatibility
export { clearModelOrderCache } from './modelRegistry.js';
