/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineCompare.ts
 * @description /v multi-model comparison feature (extracted from
 * inlineHandler.ts): picker rendering/keyboard and the parallel generation
 * runner that streams per-model progress and flushes a paginated comparison.
 */

import type { Context } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from '@grammyjs/types/markup.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type { TokenUsage } from '../../../utils/pricing.js';
import { getDefaultModels } from '../../../config/userConfig.js';
import { loadModelsConfig } from '../../../core/modelRegistry.js';
import { markdownToRichBlocks } from '../formatter/blocks.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { logger } from '../../../utils/logger.js';
import {
  touchPendingResult,
  setInlinePages,
  regenerateContexts,
  MAX_COMPARE_MODELS,
  COMPARE_MODELS_PER_PAGE,
  type CompareContext,
  type InlinePage,
} from './inlineContext.js';
import { runModelWithFallbackChain, editInlineMessage } from './inlineShared.js';
import type { InlineStreamQueue } from './inlineStreamQueue.js';

/**
 * Compare display name: hide the backend prefix (Web2API:/OpenCode:) only in
 * the inline compare UI. DeepSeek is kept because it is a model family name,
 * not a backend. This intentionally does NOT use displayModelName globally.
 */
export function compareModelName(model: string): string {
  return model.replace(/^(?:Web2API|OpenCode)\s*:\s*/i, '');
}

/** Renders the compare picker (selection screen) markdown for a /v result. */
export function renderComparePicker(cmp: CompareContext): string {
  const displayPrompt = cmp.prompt.length > 300 ? cmp.prompt.slice(0, 300) + '...' : cmp.prompt;
  const picked = cmp.selectedIdx.map((idx, i) => `**${i + 1}.** ${compareModelName(cmp.candidates[idx])}`).join('\n');
  const pickedBlock = picked ? `\n✅ **Selected models:**\n${picked}\n` : '';

  if (cmp.currentPage === 0) {
    return `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${pickedBlock}_Click "▶️ Browse/select models" to expand the full model list, or click "🚀 Default group compare"._`;
  }

  const countText = cmp.selectedIdx.length === 0
    ? '1. Please pick model 1'
    : cmp.selectedIdx.length === 1
      ? '2. Please pick model 2 (or tap "Start comparison")'
      : '3. Please pick model 3 (optional, tap "Start comparison")';
  return `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${pickedBlock}${countText}\n\n_Tap the model buttons below to select up to ${MAX_COMPARE_MODELS} models, then tap "🚀 Start comparison"._`;
}

/** Builds the picker keyboard for a /v selection screen. */
export function buildCompareKeyboard(cmp: CompareContext): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  // Add selected models display (compact, no buttons)
  if (cmp.selectedIdx.length > 0) {
    rows.push([{ text: `Selected ${cmp.selectedIdx.length}/${MAX_COMPARE_MODELS}: ${cmp.selectedIdx.map(i => compareModelName(cmp.candidates[i]).slice(0, 15)).join(' · ')}`, callback_data: 'inline_noop' }]);
  }

  if (cmp.currentPage === 0) {
    // Cover mode: ZERO model buttons on page 0 for maximum privacy
    const configDefaults = loadModelsConfig()?.compareDefaults;
    const compareGroup = getDefaultModels()?.compareGroup ?? [];
    const labelModels = configDefaults && configDefaults.length >= 2
      ? configDefaults
      : compareGroup.length > 0 ? [cmp.candidates[0], ...compareGroup].filter(Boolean) : [];
    const defaultLabel = labelModels.length > 0
      ? `🚀 Default group compare (${labelModels.map(m => compareModelName(m).split(' ')[0].split('：')[0]).join(' + ')})`
      : '🚀 Default group compare';
    rows.push([{ text: defaultLabel, callback_data: `inline_cmp_default:${cmp.resultId}` }]);
    rows.push([{ text: '▶️ Browse/select models (full list)', callback_data: `inline_cmp_page:${cmp.resultId}:1` }]);
    if (cmp.selectedIdx.length >= 2) {
      rows.push([{ text: '🚀 Start comparison', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
    }
    if (cmp.selectedIdx.length > 0) {
      rows.push([{ text: '♻️ Clear selection', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
    }
    return { inline_keyboard: rows };
  }

  // Model list pages (currentPage >= 1)
  const listPageIndex = cmp.currentPage - 1;
  const startIdx = listPageIndex * COMPARE_MODELS_PER_PAGE;
  const endIdx = Math.min(startIdx + COMPARE_MODELS_PER_PAGE, cmp.candidates.length);
  const totalListPages = Math.ceil(cmp.candidates.length / COMPARE_MODELS_PER_PAGE);

  let row: InlineKeyboardButton[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    if (cmp.selectedIdx.includes(i)) continue;
    const model = cmp.candidates[i];
    const display = compareModelName(model).length > 20 ? compareModelName(model).slice(0, 20) + '…' : compareModelName(model);
    row.push({ text: display, callback_data: `inline_cmp_pick:${cmp.resultId}:${i}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);

  // Pagination navigation bar
  const navRow: InlineKeyboardButton[] = [];
  if (listPageIndex > 0) {
    navRow.push({ text: '◀️ Prev', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage - 1}` });
  } else {
    navRow.push({ text: '◀️ First', callback_data: `inline_cmp_page:${cmp.resultId}:0` });
  }
  navRow.push({ text: `${listPageIndex + 1}/${totalListPages}`, callback_data: 'inline_noop' });
  if (startIdx + COMPARE_MODELS_PER_PAGE < cmp.candidates.length) {
    navRow.push({ text: 'Next ▶️', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage + 1}` });
  }
  rows.push(navRow);

  rows.push([{ text: '♻️ Clear selection', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
  if (cmp.selectedIdx.length >= 2) {
    rows.push([{ text: '🚀 Start comparison', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
  }

  return { inline_keyboard: rows };
}

interface CompareGenerationContext {
  resultId: string;
  inlineMessageId: string;
  fromId: number;
  prompt: string;
  projectPath?: string;
  models: string[];
  ctrl: AbortController;
  streamQueue: InlineStreamQueue;
}

/**
 * Runs a /v multi-model comparison: all selected models answer the same
 * prompt in parallel (each with its own fresh conversation), streaming a
 * per-model progress card, then flushing a paginated comparison (one page
 * per model) that reuses the standard inline_page machinery.
 */
export async function runCompareGeneration(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  gctx: CompareGenerationContext,
): Promise<void> {
  const { resultId, inlineMessageId, fromId, prompt, projectPath, models, ctrl, streamQueue } = gctx;
  const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

  const statuses: {
    model: string;
    done: boolean;
    output?: string;
    error?: string;
    usage?: TokenUsage;
  }[] = models.map((m) => ({ model: m, done: false }));
  let startedAt = Date.now();

  const renderStatus = (): string => {
    const lines = statuses.map((s, i) => {
      const num = ['1.', '2.', '3.'][i] ?? `${i + 1}.`;
      if (s.error) return `${num} \`${compareModelName(s.model)}\`\n❌ Generation failed`;
      if (s.done) return `${num} \`${compareModelName(s.model)}\`\n✅ Done`;
      return `${num} \`${compareModelName(s.model)}\`\n⏳ Thinking...`;
    }).join('\n\n');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    return `**⚖️ Multi-model comparison in progress...**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${lines}\n\n_⏱️ elapsed ${elapsed}s, will update in place when complete._`;
  };

  // Parallel execution, one runModelWithFallbackChain per model.
  const runs = models.map(async (model, i) => {
    let out = '';
    const onChunk = (chunk: string) => {
      out += chunk;
      touchPendingResult(resultId);
      void out;
    };
    const { result, modelUsed, isFallback } = await runModelWithFallbackChain(
      prompt,
      model,
      defaultOptions,
      ctrl.signal,
      projectPath,
      onChunk,
    );
    if (result?.output) {
      statuses[i] = {
        model: `${compareModelName(modelUsed)}${isFallback ? ' (downgraded)' : ''}`,
        done: true,
        output: result.output,
        usage: result.usage ?? undefined,
      };
    } else {
      statuses[i] = { model, done: true, error: ctrl.signal.aborted ? 'Stopped' : 'no output' };
    }
    streamQueue.enqueueStream(renderStatus());
  });

  try {
    // Initial progress card so the user sees parallel execution start.
    streamQueue.enqueueStream(renderStatus());
    await Promise.all(runs);
  } catch (e) {
    logger.warn(`[InlineResult] Compare generation error: ${e}`);
  }

  const doneModels = statuses.filter((s) => s.output);
  const failedModels = statuses.filter((s) => !s.output);

  if (doneModels.length === 0) {
    const wasStopped = ctrl.signal.aborted;
    const failText = wasStopped
      ? `**💬 Question:** ${displayPrompt}\n\n⏹ **Comparison stopped**\nTask was manually stopped.`
      : `**💬 Question:** ${displayPrompt}\n\n⚠️ **Comparison failed**\nAll models returned no valid output, please retry.`;
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: { markdown: failText },
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 Re-compare', callback_data: `inline_regenerate:${resultId}` }]],
      },
    }).catch(() => {});
    return;
  }

  // Build paginated comparison: one page per successfully answered model.
  const header = `**⚖️ Multi-model comparison**\n\n**💬 Question:** ${displayPrompt}\n\n`;
  const pageItems: InlinePage[] = doneModels.map((s, i) => {
    const clean = stripWholeMessageCodeFence(s.output || '');
    const num = ['1.', '2.', '3.'][i] ?? `${i + 1}.`;
    const modelLine = `**${num} ${compareModelName(s.model)}**\n\n`;
    const summaryTitle = `💡 Click to expand full answer of ${s.model.split(' ')[0] || s.model} (${compareModelName(s.model)})`;
    const bodyMarkdown = `> [details] ${summaryTitle}\n> \n` + clean.split('\n').map(line => `> ${line}`).join('\n');
    const footer = `\n\n_⏱️ ${((Date.now() - startedAt) / 1000).toFixed(1)}s_`;
    const fullMd = `${header}${modelLine}${bodyMarkdown}${footer}`;
    const blocks = markdownToRichBlocks(fullMd);
    return { markdown: fullMd, blocks: blocks.length > 0 ? blocks : undefined };
  });

  setInlinePages(resultId, pageItems);
  const pageCount = pageItems.length;

  const allSucceeded = failedModels.length === 0;
  const doneStr = doneModels.map((s) => compareModelName(s.model)).join(', ');
  const failNote = failedModels.length > 0 ? `\n\n_⚠️ Failed: ${failedModels.map((s) => compareModelName(s.model)).join(', ')}_` : '';

  // First page + pagination keyboard + regenerate.
  const footerText = `${allSucceeded ? 'Comparison complete' : 'Partially complete'}: ${doneStr}${failNote}`;
  const firstPage = `${pageItems[0].markdown}\n\n_${footerText}_`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '◀️ Prev', callback_data: 'inline_noop' },
        { text: `1/${pageCount}`, callback_data: 'inline_noop' },
        { text: 'Next ▶️', callback_data: `inline_page:${resultId}:1` },
      ].filter((b) => b.text !== '◀️ Prev'),
      [{ text: '🔄 Re-compare', callback_data: `inline_regenerate:${resultId}` }],
    ],
  };

  regenerateContexts.set(resultId, {
    prompt,
    model: models[0],
    projectPath,
    fromId,
    inlineMessageId,
    task: 'compare',
    createdAt: Date.now(),
  });

  const success = await streamQueue.flushFinal(firstPage, replyMarkup, pageItems[0].blocks);
  if (success) {
    logger.info(`[InlineResult] Compare flushed ${doneModels.length}/${models.length} models: ${doneStr}`);
  }
}
