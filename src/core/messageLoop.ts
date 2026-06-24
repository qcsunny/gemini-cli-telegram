/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stripAnsi from 'strip-ansi';
import type { DaemonSession, ChannelReply, MessageFormatter, MultimodalInput } from './types.js';
import { logger } from '../utils/logger.js';
import { ICONS } from '../channels/telegram/ui.js';
import { runAgyPrint } from '../agy/agyCli.js';
import { setConversation } from '../agy/conversationStore.js';

const DEBOUNCE_INTERVAL_MS = 1000;

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
  let responseText = '';
  let currentMessageId: number | null = null;
  let lastEditTime = 0;
  let isFinished = false;
  let activeUpdatePromise: Promise<any> = Promise.resolve();

  // Stream editing helper
  const updateMessageStream = async (isFinal = false) => {
    if (isFinished && !isFinal) return;
    if (!responseText.trim()) return;
    const now = Date.now();
    if (!isFinal && now - lastEditTime < DEBOUNCE_INTERVAL_MS) {
      return;
    }
    lastEditTime = now;

    const truncated = formatter.truncateForEdit(responseText);
    if (!truncated.trim()) return;

    activeUpdatePromise = activeUpdatePromise.then(async () => {
      if (isFinished && !isFinal) return;
      try {
        if (!currentMessageId) {
          currentMessageId = await reply.sendPlain(truncated);
        } else {
          await reply.editPlain(currentMessageId, truncated);
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
    session.turnCount++;

    let modelToUse = session.model;
    let attempts = 0;
    const maxAttempts = 3;
    let success = false;
    let lastResult: any = null;

    while (attempts < maxAttempts && !success) {
      attempts++;
      responseText = ''; // Reset buffer for this attempt

      try {
        logger.info(`[messageLoop] Attempt ${attempts}: Running prompt with model="${modelToUse}"`);
        const result = await runAgyPrint({
          prompt: finalPrompt,
          cwd,
          conversationId: session.conversationId,
          model: modelToUse,
          proxy: session.proxy,
          signal,
          onChunk: (chunk) => {
            responseText += stripAnsi(chunk);
            updateMessageStream(false).catch(err => {
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
        const output = result.output || responseText;

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

    const finalResult = lastResult || { conversationId: '', output: responseText, exitCode: 1 };

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

    // 5. Final full rendering of response text (supports RichText and multi-chunk partitioning)
    const finalCleanText = stripAnsi(finalResult.output || responseText);
    if (finalCleanText.trim()) {
      const chunks = formatter.chunkText(finalCleanText);
      if (currentMessageId) {
        try {
          const firstChunk = chunks[0];
          if (firstChunk) {
            await reply.edit(currentMessageId, firstChunk);
          }
        } catch {
          // ignore editing errors
        }
        // Send subsequent chunks if output exceeds telegram message size limits
        for (let i = 1; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk) {
            await reply.send(chunk);
          }
        }
      } else {
        for (const chunk of chunks) {
          await reply.send(chunk);
        }
      }
    } else if (finalResult.exitCode !== 0) {
      await reply.send(`${ICONS.error} 执行失败（退出代码: ${finalResult.exitCode}）。请确认您的本地 \`agy\` CLI 已正确登录。`);
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
      const lowercaseOutput = finalCleanText.toLowerCase();
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
