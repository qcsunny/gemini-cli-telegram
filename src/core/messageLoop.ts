/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import type { DaemonSession, ChannelReply, MessageFormatter, MultimodalInput, StructuredMessage } from './types.js';
import { logger } from '../utils/logger.js';
import { ICONS } from '../channels/telegram/ui.js';
import { markdownToHtml } from '../channels/telegram/formatter.js';
import { runAgyPrint, getModelCapabilities, extractThoughtAndContent } from '../agy/agyCli.js';
import { setConversation } from '../agy/conversationStore.js';
import { formatFooterMarker } from '../utils/pricing.js';
import { messageCache } from '../utils/messageCache.js';

const DEBOUNCE_INTERVAL_MS = 1000;

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
  let thinkingMessageId: number | null = null;
  let currentMessageId: number | null = null;
  let lastEditTime = 0;
  let isFinished = false;
  let isDone = false;
  let activeUpdatePromise: Promise<any> = Promise.resolve();

  const capabilities = getModelCapabilities(session.model);
  const isRichSingleMessage = capabilities.supportsThinkingSummary;

  // Stream editing helper
  const updateMessageStream = async (isFinal = false) => {
    if (isFinished && !isFinal) return;
    const now = Date.now();
    if (!isFinal && now - lastEditTime < DEBOUNCE_INTERVAL_MS) {
      return;
    }
    lastEditTime = now;

    activeUpdatePromise = activeUpdatePromise.then(async () => {
      if (isFinished && !isFinal) return;
      try {
        if (isRichSingleMessage) {
          const structuredMsg: StructuredMessage = {
            content: answerBuffer,
            thought: thoughtBuffer,
          };

          if (!structuredMsg.content.trim() && !structuredMsg.thought?.trim()) {
            logger.debug(`[DEBUG-STAGE-6] structuredMsg is empty, skipping update.`);
            return;
          }

          const truncatedContent = formatter.truncateForEdit(structuredMsg.content);
          const truncatedThought = structuredMsg.thought ? formatter.truncateForEdit(structuredMsg.thought) : undefined;
          
          const structuredTruncMsg: StructuredMessage = {
            content: truncatedContent,
            thought: truncatedThought,
          };

          if (!currentMessageId) {
            logger.debug(`[DEBUG-STAGE-6] Sending first draft with structuredMsg`);
            currentMessageId = await reply.sendRichDraft!(structuredTruncMsg);
            logger.debug(`[DEBUG-STAGE-6] First draft sent, currentMessageId=${currentMessageId}`);
          } else {
            if (reply.editRichDraft) {
              logger.debug(`[DEBUG-STAGE-6] Editing active draft ${currentMessageId} with structuredMsg`);
              await reply.editRichDraft(currentMessageId, structuredTruncMsg);
            } else {
              logger.debug(`[DEBUG-STAGE-6] editRichDraft missing!`);
            }
          }
        } else {
          const thoughtTrimmed = thoughtBuffer.trim();
          if (thoughtTrimmed) {
            const prefix = isFinal
              ? '🧠 思考过程 (Thinking Process)\n\n'
              : '🧠 正在思考... (Thinking...)\n\n';
            const formattedThought = prefix + thoughtTrimmed;
            const truncatedThought = formatter.truncateForEdit(formattedThought);
            if (truncatedThought.trim()) {
              if (!thinkingMessageId) {
                thinkingMessageId = await reply.sendPlain(truncatedThought);
              } else {
                await reply.editPlain(thinkingMessageId, truncatedThought);
              }
            }
          }

          if (answerBuffer.trim()) {
            const truncatedContent = formatter.truncateForEdit(answerBuffer);
            if (truncatedContent.trim()) {
              if (!currentMessageId) {
                currentMessageId = await reply.sendPlain(truncatedContent);
              } else {
                await reply.editPlain(currentMessageId, truncatedContent);
              }
            }
          }
        }
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

      let modelToUse = session.model;
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      let lastResult: any = null;

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

        try {
          logger.info(`[messageLoop] Attempt ${attempts}: Running prompt with model="${modelToUse}"`);
          turnStartTime = Date.now();
          const result = await runAgyPrint({
            prompt: finalPrompt,
            cwd,
            conversationId: session.conversationId,
            model: modelToUse,
            proxy: session.proxy,
            signal,
            onSpawn: (pid) => { session.childPid = pid; },
            onEvent: (event) => {
              if (event.type === 'thought') {
                thoughtEventCount++;
              } else if (event.type === 'text') {
                textEventCount++;
              }

              logger.debug(`[EVENT] type="${event.type}" content.length=${event.content?.length || 0} content_preview="${(event.content || '').slice(0, 100).replace(/\n/g, '\\n')}"`);


              if (event.type === 'thought') {
                thoughtBuffer += event.content || '';
              } else if (event.type === 'text') {
                answerBuffer += event.content || '';
              } else if (event.type === 'done') {
                isDone = true;
                logger.debug(`[EVENT STATS] thought event count=${thoughtEventCount} text event count=${textEventCount}`);
              }

              logger.debug(`[BUFFER] thoughtBuffer.length=${thoughtBuffer.length} answerBuffer.length=${answerBuffer.length}`);

              updateMessageStream(isDone).catch(err => {
                logger.warn(`[messageLoop] Error in updateMessageStream: ${err}`);
              });
            }
          });

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
          throw e;
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
        answerBuffer = parsed.content;
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


      // 5. Final full rendering of response text (supports RichText and structure-aware multi-chunk partitioning)
      if (thinkingMessageId) {
        try {
          await reply.delete(thinkingMessageId);
        } catch (e) {
          logger.warn(`[messageLoop] Failed to delete temporary thinking message: ${e}`);
        }
      }

      const bodyHtmlChunks: string[] = [];

      if (answerBuffer.trim()) {
        const parts = answerBuffer.split(/\s*---(?:split|spilt)---\s*/gi).filter(p => p.trim());
        for (const part of parts) {
          const partHtml = markdownToHtml({ content: part });
          const chunks = formatter.chunkText('___RAW_HTML___' + partHtml);
          bodyHtmlChunks.push(...chunks);
        }
      }

      const thoughtAndStatsHtmlChunks: string[] = [];
      const footerMarker = formatFooterMarker(
        modelToUse || 'Gemini 3.5 Flash (Medium)',
        finalPrompt,
        answerBuffer,
        finalResult.usage
      );
      const footerHtml = markdownToHtml(footerMarker);

      if (thoughtBuffer.trim()) {
        const thoughtHtml = markdownToHtml({
          content: '',
          thought: thoughtBuffer.trim(),
          geminiTime: finalResult.thinkingTime
        });
        const combinedHtml = thoughtHtml + '\n\n' + footerHtml;
        const chunks = formatter.chunkText('___RAW_HTML___' + combinedHtml);
        thoughtAndStatsHtmlChunks.push(...chunks);
      } else {
        const chunks = formatter.chunkText('___RAW_HTML___' + footerHtml);
        thoughtAndStatsHtmlChunks.push(...chunks);
      }

      const finalHtmlMessages = [
        ...bodyHtmlChunks,
        ...thoughtAndStatsHtmlChunks
      ];

      if (finalResult.exitCode === 0 && finalHtmlMessages.length > 0) {
        if (currentMessageId) {
          try {
            await reply.edit(currentMessageId, finalHtmlMessages[0]);
            if (answerBuffer.trim()) {
              messageCache.set(currentMessageId, answerBuffer.trim());
            }
          } catch (e) {
            logger.warn(`[messageLoop] Failed to edit first chunk: ${e}`);
          }
          for (let i = 1; i < finalHtmlMessages.length; i++) {
            const msgId = await reply.send(finalHtmlMessages[i]);
            if (msgId && answerBuffer.trim()) {
              messageCache.set(msgId, answerBuffer.trim());
            }
          }
        } else {
          for (const msgText of finalHtmlMessages) {
            const msgId = await reply.send(msgText);
            if (msgId && answerBuffer.trim()) {
              messageCache.set(msgId, answerBuffer.trim());
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
        
        const isAuthError = stderrStr.includes('authentication failed') || stdoutStr.includes('authentication failed') || stdoutStr.includes('not signed in') || stdoutStr.includes('Authentication required');
        const isTerminated = stderrStr.includes('terminated due to error') || stdoutStr.includes('terminated due to error');
        
        let errorReason = '执行失败';
        if (isAuthError) errorReason = '认证已过期或未登录 (Authentication expired or not logged in)';
        if (isTerminated) errorReason = '代理进程异常终止 (Agent execution terminated due to error)';
        if (finalResult.isTimeout) errorReason = '执行被用户或系统超时取消 (Timeout/Aborted)';

        let detailMsg = '';
        const escapeHtml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        if (stdoutStr.includes('Welcome to the Antigravity CLI') || stdoutStr.includes('not signed in') || stdoutStr.includes('Authentication required')) {
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

        const errorHtml = `${ICONS.error} <b>${errorReason}</b>（退出代码: ${finalResult.exitCode}）。请确认您的本地 \`agy\` CLI 已正确登录并配置网络。${detailMsg}`;
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
