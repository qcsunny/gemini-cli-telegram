/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineChosenResult.ts
 * @description Chosen-inline-result finalization (extracted from inlineHandler.ts):
 * when the user picks an inline card, starts the model fallback-chain
 * generation and streams the answer into the in-place inline message.
 */


import type { Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { getTuningConfig } from '../../../config/userConfig.js';
import { InlineStreamQueue } from './inlineStreamQueue.js';
import { displayModelName } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { marketService } from '../../../stock/service/quote.js';
import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';
import { buildStockBlocks, ensureQuoteFinancials, ensureQuotePerformance, ensureQuoteProfile } from './stockHandler.js';
import { fetchInvestAnalysis, fetchInvestAnalyses, buildInvestPrompt, buildComparePrompt, getInvestProjectPath } from './investDataFetcher.js';
import { pendingResults, userControllers, pendingStockRequests, recentInlineQueries, compareContexts, touchPendingResult, type PendingResult } from './inlineContext.js';
import { editInlineMessage, buildInputRichMessage, buildInlineStreamingBlocks } from './inlineShared.js';
import { renderComparePicker, buildCompareKeyboard } from './inlineCompare.js';
import { runInlineGeneration } from './inlineGeneration.js';

export async function handleChosenInlineResult(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): Promise<void> {
  const chosen = ctx.chosenInlineResult;
  logger.info(`🔥 [CHOSEN_INLINE_RESULT DETECTED] result_id=${chosen?.result_id} inline_message_id=${chosen?.inline_message_id} fromId=${chosen?.from?.id}`);

  if (!chosen?.inline_message_id) {
    logger.warn(`[ChosenInline] Missing inline_message_id for result_id=${chosen?.result_id}`);
    return;
  }

  const stockReq = pendingStockRequests.get(chosen.result_id);
  if (stockReq) {
    pendingStockRequests.delete(chosen.result_id);
    logger.info(`[ChosenInlineStock] Fetching live stock data for "${stockReq.queryStr}"`);
    const quote = await marketService.getQuote(stockReq.queryStr);
    if (quote) {
      await ensureQuotePerformance(quote);
      await ensureQuoteFinancials(quote);
      await ensureQuoteProfile(quote);

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const webAppUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await editInlineMessage(ctx.api, {
        inline_message_id: chosen.inline_message_id,
        rich_message: {
          blocks: buildStockBlocks(quote),
        },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', url: webAppUrl },
              { text: '📈 K线图', url: webAppUrl }
            ],
          ],
        },
      }).catch((e: Error) => logger.warn(`[ChosenInlineStock] Edit message failed: ${e}`));
    }
    return;
  }

  const cmp = compareContexts.get(chosen.result_id);
  if (cmp) {
    cmp.inlineMessageId = chosen.inline_message_id;
    logger.info(`[ChosenInline] Compare mode selected: userId=${chosen.from.id} resultId=${chosen.result_id} candidates=${cmp.candidates.length}`);
    await editInlineMessage(ctx.api, {
      inline_message_id: chosen.inline_message_id,
      rich_message: { markdown: renderComparePicker(cmp) },
      reply_markup: buildCompareKeyboard(cmp),
    }).catch((e: Error) => logger.warn(`[InlineResult] Compare picker initial edit failed: ${e}`));
    return;
  }

  let rebuilt: PendingResult | undefined;
  const rawPending = pendingResults.get(chosen.result_id);
  if (!rawPending) {
    // The user lingered on the result list past RESULTS_TTL and the entry
    // was evicted. Rebuild it from the last known query so the click still
    // starts the generation instead of leaving the card dead.
    const recent = recentInlineQueries.get(chosen.result_id);
    if (!recent) {
      logger.warn(`[ChosenInline] No pending result found for result_id=${chosen.result_id}`);
      return;
    }
    rebuilt = {
      ownerId: chosen.from.id,
      prompt: recent.prompt,
      model: recent.model,
      task: recent.task,
      createdAt: Date.now(),
      lastActiveTime: Date.now(),
      isInvest: recent.isInvest,
      investSymbol: recent.investSymbol,
      investSymbols: recent.investSymbols,
    };
    pendingResults.set(chosen.result_id, rebuilt);
    logger.info(`[ChosenInline] Rebuilt expired pending result from recent query for result_id=${chosen.result_id}`);
  }
  const pending: PendingResult = rawPending ?? rebuilt!;
  if (pending.ownerId !== chosen.from.id) {
    logger.warn(`[ChosenInline] Result owner mismatch resultId=${chosen.result_id} owner=${pending.ownerId} chooser=${chosen.from.id}`);
    return;
  }
  // Restart the TTL clock from the click so slow pre-steps (e.g. /invest
  // script prefetch up to 60s) are never aborted by the cleanup timer before
  // the first stream chunk arrives.
  touchPendingResult(chosen.result_id);

  // /invest: run the deterministic analysis script now (no inline-query 10s
  // deadline here), inject the scored data into the prompt, then hand it to
  // the model. Falls back to the plain prompt when the script fails.
  let finalPrompt = pending.prompt;
  if (pending.isInvest) {
    const investCwd = pending.projectPath || getInvestProjectPath();
    if (pending.investSymbols && pending.investSymbols.length >= 2) {
      logger.info(`[InlineInvest] Prefetching comparison for "${pending.investSymbols.join(', ')}" on click`);
      try {
        const fetchResults = await fetchInvestAnalyses(pending.investSymbols, investCwd);
        const okCount = fetchResults.filter((r) => r.ok).length;
        if (okCount > 0) {
          finalPrompt = buildComparePrompt(
            fetchResults,
            `请对以下 ${fetchResults.filter((r) => r.ok).map((r) => r.symbol ?? '?').join('、')} 做同行业深度对比分析，输出对比报告。`,
          );
          logger.info(`[InlineInvest] Enhanced prompt with comparison data for ${pending.investSymbols.join(', ')} (${okCount}/${fetchResults.length} ok)`);
        } else {
          logger.warn(`[InlineInvest] All comparison scripts failed for ${pending.investSymbols.join(', ')}, falling back to plain AI query`);
        }
      } catch (e) {
        logger.warn(`[InlineInvest] Comparison prefetch threw for ${pending.investSymbols.join(', ')}: ${e}`);
      }
    } else if (pending.investSymbol) {
      logger.info(`[InlineInvest] Prefetching analysis for "${pending.investSymbol}" on click`);
      try {
        const fetchResult = await fetchInvestAnalysis(pending.investSymbol, investCwd);
        if (fetchResult.ok && fetchResult.data) {
          finalPrompt = buildInvestPrompt(
            `请对 ${fetchResult.symbol ?? pending.investSymbol} 做深度价值投资分析。`,
            fetchResult.data,
          );
          logger.info(`[InlineInvest] Enhanced prompt with analysis data for ${pending.investSymbol} (${fetchResult.data.length} bytes)`);
        } else {
          logger.warn(`[InlineInvest] Script failed for ${pending.investSymbol}, falling back to plain AI query: ${fetchResult.error}`);
        }
      } catch (e) {
        logger.warn(`[InlineInvest] Prefetch threw for ${pending.investSymbol}: ${e}`);
      }
    }
  }

  // /read: parse URL content and inject into prompt
  if (pending.task === 'read') {
    const { extractFirstUrl, parseUrlContent } = await import('../../../tools/urlParser/urlParser.js');
    const url = extractFirstUrl(pending.prompt);
    if (url) {
      logger.info(`[InlineRead] Parsing URL "${url}" on click`);
      try {
        const parsed = await parseUrlContent(url);
        finalPrompt = `你是一位顶尖的技术研究员与专业文献分析师。请对以下抓取到的内容进行深度、结构化、清晰且精炼的精读与总结：\n\n【原文内容】\n${parsed.content}`;
        logger.info(`[InlineRead] Enhanced prompt with parsed URL content (${parsed.content.length} chars)`);
      } catch (e) {
        logger.warn(`[InlineRead] URL parse threw for ${url}: ${e}`);
      }
    }
  }

  userControllers.get(chosen.result_id)?.abort();
  const ctrl = new AbortController();
  userControllers.set(chosen.result_id, ctrl);

  logger.info(`[ChosenInline] userId=${chosen.from.id} resultId=${chosen.result_id} model=${pending.model} task=${pending.task || 'chat'} — starting model`);

  const streamQueue = new InlineStreamQueue(ctx.api, chosen.inline_message_id);

  // Immediately re-edit the freshly-sent inline card as a true RichMessage.
  // Telegram's `input_message_content.rich_message` in an inline result is
  // still rendered as plain/HTML text by several clients on first send, but
  // `editMessageText` + `rich_message` renders correctly everywhere, so push
  // the placeholder through the SAME streamQueue path used by streaming.
  // Blocks are built directly so the placeholder is a native RichMessage.
  const displayPrompt = pending.prompt.length > 300 ? pending.prompt.slice(0, 300) + '...' : pending.prompt;
  const modelStatusLine = `🤖 **${displayModelName(pending.model)}** · ⏳ 推理中`;
  const placeholderMarkdown = pending.task
    ? `${pending.task.toUpperCase()} ✨ **AI inference engine started**\n\n**💬 Question:** ${displayPrompt}\n\n${modelStatusLine}\n\n_🚀 Reasoning in progress; answer updates in place._`
    : `✨ **AI inference engine started**\n\n**💬 Question:** ${displayPrompt}\n\n${modelStatusLine}\n\n_🚀 Reasoning in progress; answer updates in place._`;
  streamQueue.setReplyMarkup({
    inline_keyboard: [[{ text: '⏹ Stop', callback_data: `inline_stop:${chosen.result_id}` }]],
  });
  const placeholderRich = buildInputRichMessage(placeholderMarkdown);
  streamQueue.setBlocks('blocks' in placeholderRich ? placeholderRich.blocks ?? null : null);
  streamQueue.enqueueStream(placeholderMarkdown);
  logger.info('[ChosenInline] Enqueued rich placeholder (blocks) through streamQueue path');

  let accumulatedText = '';
  let accumulatedThought = '';
  let activeModelName = pending.model;
  const inlineThinkingStreaming = getTuningConfig().inlineThinkingStreaming;

  const onModelStart = (modelName: string) => {
    accumulatedText = '';
    accumulatedThought = '';
    activeModelName = modelName;
  };

  const onChunk = (chunk: string) => {
    accumulatedText += chunk;
    // BUG-01: Refresh lastActiveTime on every chunk so the cleanup timer
    // never kills an actively-streaming long response.
    touchPendingResult(chosen.result_id);
    if (accumulatedText.trim().length > 0) {
      const displayPrompt = pending.prompt.length > 300 ? pending.prompt.slice(0, 300) + '...' : pending.prompt;
      const streamMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${displayModelName(activeModelName)}):**\n\n${accumulatedText}\n\n_✍️ Streaming live update..._`;
      streamQueue.enqueueStream(streamMarkdown);
    }
  };
  const onEvent = (event: { type: 'thought' | 'text' | 'done'; content?: string }) => {
    touchPendingResult(chosen.result_id);
    if (inlineThinkingStreaming && event.type === 'thought' && event.content) accumulatedThought += event.content;
    if (event.type === 'thought' || event.type === 'text') {
      const frameMarkdown = `${accumulatedThought}\n\n${accumulatedText}`.trim() || placeholderMarkdown;
      streamQueue.enqueueBlocks(frameMarkdown, buildInlineStreamingBlocks({
        prompt: pending.prompt,
        model: activeModelName,
        thought: accumulatedThought,
        content: accumulatedText,
      }));
    }
  };

  try {
    await runInlineGeneration(ctx, sessionManager, defaultOptions, {
      resultId: chosen.result_id,
      inlineMessageId: chosen.inline_message_id,
      fromId: chosen.from.id,
      prompt: finalPrompt,
      model: pending.model,
      projectPath: pending.projectPath,
      task: pending.task,
      ctrl,
      streamQueue,
      onModelStart,
      onChunk,
      onEvent,
      allowTools: !!pending.isInvest,
      getPartialOutput: () => accumulatedText,
      inlineThinkingStreaming,
    });
  } catch (e) {
    logger.warn(`[InlineResult] Failed to edit message: ${e}`);
  } finally {
    pendingResults.delete(chosen.result_id);
    userControllers.delete(chosen.result_id);
  }
}