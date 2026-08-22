/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineCallbackActions.ts
 * @description Inline callback_query actions (extracted from inlineHandler.ts):
 * regenerate, stop, page navigation, compare selection/pager and the
 * full-document attachment flow for inline result cards.
 */


import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { getDefaultModels, getTuningConfig } from '../../../config/userConfig.js';
import { InlineStreamQueue } from './inlineStreamQueue.js';
import { getEffectiveModelOrder, loadModelsConfig, displayModelName } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { userControllers, fullInlineOutputs, inlineOwnerMatches, regenerateContexts, compareContexts, MAX_COMPARE_MODELS, COMPARE_MODELS_PER_PAGE, touchPendingResult, inlinePages, type CompareContext } from './inlineContext.js';
import { editInlineMessage, buildInlineStreamingBlocks } from './inlineShared.js';
import { renderComparePicker, buildCompareKeyboard, runCompareGeneration, compareModelName } from './inlineCompare.js';
import { runInlineGeneration } from './inlineGeneration.js';

export async function handleInlineCallbackQuery(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  next: () => Promise<void> | void,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  if (!data || !inlineMessageId || !data.startsWith('inline_')) {
    await next();
    return;
  }

  if (data === 'inline_thinking') {
    await ctx.answerCallbackQuery({
      text: '🧠 AI is computing in full; the answer will update in place when complete, please wait...',
      show_alert: true,
    }).catch(() => {});
    return;
  }

  if (data.startsWith('inline_stop:')) {
    const resultId = data.slice('inline_stop:'.length);
    if (!inlineOwnerMatches(resultId, ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    const ctrl = userControllers.get(resultId);
    if (!ctrl) {
      await ctx.answerCallbackQuery({ text: '⚠️ This task is already complete or stopped.', show_alert: true }).catch(() => {});
      return;
    }
    ctrl.abort();
    await ctx.answerCallbackQuery({ text: '⏹ Stop requested, stopping...', show_alert: true }).catch(() => {});
    return;
  }

  if (data.startsWith('inline_full_doc:')) {
    const resultId = data.slice('inline_full_doc:'.length);
    const fullData = fullInlineOutputs.get(resultId);
    if (!fullData) {
      await ctx.answerCallbackQuery({ text: '❌ 完整回答已过期，请重新生成。', show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.from?.id === undefined) return;
    // Inline cards cannot host documents; deliver the full answer as a
    // Markdown file to the user's private chat (private chat id == user id).
    const mdDoc = `# 💬 Question\n\n${fullData.prompt}\n\n# 🤖 Answer (${fullData.model})\n\n${fullData.output}`;
    try {
      await ctx.api.sendDocument(
        ctx.from.id,
        new InputFile(Buffer.from(mdDoc, 'utf8'), `full_answer_${resultId}.md`),
        { caption: `📄 完整回答（${fullData.output.length} 字符）· ${fullData.model}` },
      );
      await ctx.answerCallbackQuery({ text: '📄 完整回答已发送到私聊', show_alert: false }).catch(() => {});
    } catch (e) {
      logger.warn(`[InlineFullDoc] sendDocument failed for userId=${ctx.from.id}: ${e}`);
      await ctx.answerCallbackQuery({
        text: '⚠️ 请先在私聊中给本 bot 发送任意消息，再点击此按钮。',
        show_alert: true,
      }).catch(() => {});
    }
    return;
  }

  if (data.startsWith('inline_regenerate:')) {
    const resultId = data.slice('inline_regenerate:'.length);
    const regen = regenerateContexts.get(resultId);
    if (!regen || (ctx.from?.id !== undefined && regen.fromId !== ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized or expired action.', show_alert: true }).catch(() => {});
      return;
    }
    if (!regen) {
      await ctx.answerCallbackQuery({ text: '❌ Session expired, please ask again.', show_alert: true }).catch(() => {});
      return;
    }

    if (regen.task === 'compare') {
      const candidates = getEffectiveModelOrder();
      const cmp: CompareContext = {
        resultId,
        inlineMessageId,
        fromId: regen.fromId,
        prompt: regen.prompt,
        projectPath: regen.projectPath,
        candidates,
        currentPage: 0,
        selectedIdx: [],
        createdAt: Date.now(),
      };
      compareContexts.set(resultId, cmp);
      await ctx.answerCallbackQuery({ text: '⚖️ Please reselect comparison models', show_alert: false }).catch(() => {});
      await editInlineMessage(ctx.api, {
        inline_message_id: inlineMessageId,
        rich_message: { markdown: renderComparePicker(cmp) },
        reply_markup: buildCompareKeyboard(cmp),
      }).catch((e: Error) => logger.warn(`[InlineResult] Compare regenerate edit failed: ${e}`));
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔄 正在重新生成，请稍候...' }).catch(() => {});

    // Immediately edit the message text to show loading feedback so the user knows it's actively thinking!
    if (regen.task !== 'image') {
      const displayPrompt = regen.prompt.length > 300 ? regen.prompt.slice(0, 300) + '...' : regen.prompt;
      const initMarkdown = `✨ **AI 推理引擎重新启动中**\n\n**🧠 目标模型：** \`${displayModelName(regen.model)}\`\n\n**💬 问题：**\n> ${displayPrompt}\n\n_🚀 正在重新深度推演，完成后自动刷新…_`;
      await editInlineMessage(ctx.api, {
        inline_message_id: inlineMessageId,
        rich_message: { markdown: initMarkdown },
        reply_markup: {
          inline_keyboard: [[{ text: '⏹ Stop', callback_data: `inline_stop:${resultId}` }]],
        },
      }).catch((e: Error) => logger.warn(`[InlineResult] Regenerate initial edit failed: ${e}`));
    }

    const ctrl = new AbortController();
    userControllers.set(resultId, ctrl);
    const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
    let accumulatedText = '';
    let accumulatedThought = '';
    let activeModelName = regen.model;
    const inlineThinkingStreaming = getTuningConfig().inlineThinkingStreaming;
    const onModelStart = (modelName: string) => {
      accumulatedText = '';
      accumulatedThought = '';
      activeModelName = modelName;
    };
    const onChunk = (chunk: string) => {
      accumulatedText += chunk;
      touchPendingResult(resultId);
      // Image task message becomes a photo after first run — text streaming
      // edits would fail ("no text in message to edit"), so skip them.
      if (regen.task === 'image') return;
      if (accumulatedText.trim().length > 0) {
        const displayPrompt = regen.prompt.length > 300 ? regen.prompt.slice(0, 300) + '...' : regen.prompt;
        const streamMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${displayModelName(activeModelName)}):**\n\n${accumulatedText}\n\n_✍️ Streaming live update..._`;
        streamQueue.enqueueStream(streamMarkdown);
      }
    };
    const onEvent = (event: { type: 'thought' | 'text' | 'done'; content?: string }) => {
      touchPendingResult(resultId);
      if (inlineThinkingStreaming && event.type === 'thought' && event.content) accumulatedThought += event.content;
      if (regen.task !== 'image' && (event.type === 'thought' || event.type === 'text')) {
        const frameMarkdown = `${accumulatedThought}\n\n${accumulatedText}`.trim() || 'Thinking...';
        streamQueue.enqueueBlocks(frameMarkdown, buildInlineStreamingBlocks({
          prompt: regen.prompt,
          model: activeModelName,
          thought: accumulatedThought,
          content: accumulatedText,
        }));
      }
    };
    try {
      await runInlineGeneration(ctx, sessionManager, defaultOptions, {
        resultId,
        inlineMessageId,
        fromId: regen.fromId,
        prompt: regen.prompt,
        model: regen.model,
        projectPath: regen.projectPath,
        task: regen.task,
        ctrl,
        streamQueue,
        onModelStart,
        onChunk,
        onEvent,
        getPartialOutput: () => accumulatedText,
        inlineThinkingStreaming,
      });
    } catch (e) {
      logger.warn(`[InlineResult] Regenerate failed: ${e}`);
    } finally {
      userControllers.delete(resultId);
    }
    return;
  }

  if (data === 'inline_noop') {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  if (data.startsWith('inline_page:')) {
    const [resultId, pageIdxStr] = data.slice('inline_page:'.length).split(':');
    const pageIdx = parseInt(pageIdxStr, 10);
    const pages = inlinePages.get(resultId);
    const owner = regenerateContexts.get(resultId)?.fromId;
    if (owner !== undefined && ctx.from?.id !== undefined && owner !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    logger.info(`[InlinePage] userId=${ctx.from?.id} resultId=${resultId} pageIdx=${pageIdx} pagesFound=${pages ? pages.length : 'null'} inlineMsgId=${inlineMessageId ?? 'null'}`);
    if (!pages || Number.isNaN(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) {
      logger.warn(`[InlinePage] EXPIRED or invalid: resultId=${resultId} pages=${pages ? pages.length : 'null'} pageIdx=${pageIdx}`);
      await ctx.answerCallbackQuery({ text: '❌ Pagination expired.', show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const targetPage = pages[pageIdx];
    const richMessagePayload = targetPage.blocks && targetPage.blocks.length > 0
      ? { blocks: targetPage.blocks }
      : { markdown: targetPage.markdown || '' };
    logger.info(`[InlinePage] Editing to page ${pageIdx + 1}/${pages.length} for resultId=${resultId} payloadType=${targetPage.blocks ? 'blocks' : 'markdown'}`);
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: richMessagePayload,
      reply_markup: {
        inline_keyboard: [
          [
            ...(pageIdx > 0 ? [{ text: '◀️ Prev', callback_data: `inline_page:${resultId}:${pageIdx - 1}` }] : []),
            { text: `${pageIdx + 1}/${pages.length}`, callback_data: 'inline_noop' },
            ...(pageIdx < pages.length - 1 ? [{ text: 'Next ▶️', callback_data: `inline_page:${resultId}:${pageIdx + 1}` }] : []),
          ],
          [{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }],
        ],
      },
    }).catch((e: Error) => logger.warn(`[InlinePage] Page edit failed: ${e}`));
    return;
  }

  if (data.startsWith('inline_cmp_pick:')) {
    const [resultId, idxStr] = data.slice('inline_cmp_pick:'.length).split(':');
    const idx = parseInt(idxStr, 10);
    const cmp = compareContexts.get(resultId);
    if (!cmp || Number.isNaN(idx) || idx < 0 || idx >= cmp.candidates.length) {
      await ctx.answerCallbackQuery({ text: '❌ Selection expired, please start a new /v query.', show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.from?.id !== undefined && cmp.fromId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    if (cmp.selectedIdx.includes(idx)) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (cmp.selectedIdx.length >= MAX_COMPARE_MODELS) {
      await ctx.answerCallbackQuery({ text: `⚠️ Select up to ${MAX_COMPARE_MODELS} models, then tap "🚀 Start comparison".`, show_alert: true }).catch(() => {});
      return;
    }
    cmp.selectedIdx.push(idx);
    await ctx.answerCallbackQuery({ text: `✅ Selected ${compareModelName(cmp.candidates[idx])}`, show_alert: true }).catch(() => {});
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: { markdown: renderComparePicker(cmp) },
      reply_markup: buildCompareKeyboard(cmp),
    }).catch((e: Error) => logger.warn(`[InlineResult] Compare pick edit failed: ${e}`));
    return;
  }

  if (data.startsWith('inline_cmp_reset:')) {
    const resultId = data.slice('inline_cmp_reset:'.length);
    const cmp = compareContexts.get(resultId);
    if (!cmp) {
      await ctx.answerCallbackQuery({ text: '❌ Session expired.', show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.from?.id !== undefined && cmp.fromId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    cmp.selectedIdx = [];
    await ctx.answerCallbackQuery().catch(() => {});
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: { markdown: renderComparePicker(cmp) },
      reply_markup: buildCompareKeyboard(cmp),
    }).catch((e: Error) => logger.warn(`[InlineResult] Compare reset edit failed: ${e}`));
    return;
  }

  if (data.startsWith('inline_cmp_page:')) {
    const [resultId, pageStr] = data.slice('inline_cmp_page:'.length).split(':');
    const pageIdx = parseInt(pageStr, 10);
    let cmp = compareContexts.get(resultId);
    // Auto-rebuild if bot restarted and context was lost in memory
    if (!cmp) {
      await ctx.answerCallbackQuery({ text: 'Comparison expired after bot restart.', show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.from?.id !== undefined && cmp.fromId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    if (Number.isNaN(pageIdx) || pageIdx < 0 || pageIdx >= Math.ceil(cmp.candidates.length / COMPARE_MODELS_PER_PAGE)) {
      await ctx.answerCallbackQuery({ text: '❌ Page out of range.', show_alert: true }).catch(() => {});
      return;
    }
    cmp.currentPage = pageIdx;
    await ctx.answerCallbackQuery().catch(() => {});
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: { markdown: renderComparePicker(cmp) },
      reply_markup: buildCompareKeyboard(cmp),
    }).catch((e: Error) => logger.warn(`[InlineResult] Compare page edit failed: ${e}`));
    return;
  }

  if (data.startsWith('inline_cmp_default:')) {
    const resultId = data.slice('inline_cmp_default:'.length);
    let cmp = compareContexts.get(resultId);
    // Auto-rebuild if bot restarted and context was lost in memory
    if (!cmp) {
      await ctx.answerCallbackQuery({ text: 'Comparison expired after bot restart.', show_alert: true }).catch(() => {});
      return;
    }
    const activeCmp = cmp!;
    if (ctx.from?.id !== undefined && activeCmp.fromId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    const configDefaults = loadModelsConfig()?.compareDefaults || [];
    const selectedIndices: number[] = [];
    
    // 1. Try mapping the compareDefaults from config
    for (const modelName of configDefaults) {
      const idx = activeCmp.candidates.indexOf(modelName);
      if (idx !== -1) {
        selectedIndices.push(idx);
      }
    }
    
    // 2. Fall back to the default group if config yielded less than 2 valid models
    if (selectedIndices.length < 2) {
      selectedIndices.length = 0; // reset
      const defaultGroup = [
        activeCmp.candidates[0], // First model (Opus)
        ...(getDefaultModels()?.compareGroup ?? []),
      ];
      for (const modelName of defaultGroup) {
        if (!modelName) continue;
        const idx = activeCmp.candidates.indexOf(modelName);
        if (idx !== -1) {
          selectedIndices.push(idx);
        }
      }
    }
    
    // 3. Fall back to index-based first N models if still less than 2 models
    if (selectedIndices.length >= 2) {
      activeCmp.selectedIdx = selectedIndices.slice(0, MAX_COMPARE_MODELS);
    } else {
      activeCmp.selectedIdx = Array.from({ length: MAX_COMPARE_MODELS }, (_, i) => i).filter(i => i < activeCmp.candidates.length);
      if (activeCmp.selectedIdx.length < 2) {
        activeCmp.selectedIdx = activeCmp.candidates.map((_, i) => i).slice(0, MAX_COMPARE_MODELS);
      }
    }
    const models = activeCmp.selectedIdx.map((idx: number) => activeCmp.candidates[idx]);
    await ctx.answerCallbackQuery({ text: '🚀 Starting default top-tier comparison...' }).catch(() => {});
    const ctrl = new AbortController();
    userControllers.set(resultId, ctrl);
    const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
    try {
      await runCompareGeneration(ctx, sessionManager, defaultOptions, {
        resultId,
        inlineMessageId,
        fromId: activeCmp.fromId,
        prompt: activeCmp.prompt,
        projectPath: activeCmp.projectPath,
        models,
        ctrl,
        streamQueue,
      });
    } catch (e) {
      logger.warn(`[InlineResult] Compare default generation failed: ${e}`);
    } finally {
      userControllers.delete(resultId);
      compareContexts.delete(resultId);
    }
    return;
  }

  if (data.startsWith('inline_cmp_start:')) {
    const resultId = data.slice('inline_cmp_start:'.length);
    const cmp = compareContexts.get(resultId);
    if (!cmp || cmp.selectedIdx.length < 2) {
      await ctx.answerCallbackQuery({ text: '❌ Select at least 2 models to compare.', show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.from?.id !== undefined && cmp.fromId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized action.', show_alert: true }).catch(() => {});
      return;
    }
    const models = cmp.selectedIdx.map((idx: number) => cmp.candidates[idx]);
    await ctx.answerCallbackQuery({ text: '⚖️ Starting multi-model comparison...' }).catch(() => {});
    const ctrl = new AbortController();
    userControllers.set(resultId, ctrl);
    const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
    try {
      await runCompareGeneration(ctx, sessionManager, defaultOptions, {
        resultId,
        inlineMessageId,
        fromId: cmp.fromId,
        prompt: cmp.prompt,
        projectPath: cmp.projectPath,
        models,
        ctrl,
        streamQueue,
      });
    } catch (e) {
      logger.warn(`[InlineResult] Compare generation failed: ${e}`);
    } finally {
      userControllers.delete(resultId);
      compareContexts.delete(resultId);
    }
    return;
  }
}