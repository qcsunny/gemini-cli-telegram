/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineQueryResults.ts
 * @description Inline query answering (extracted from inlineHandler.ts):
 * parses the @bot query, runs stock/invest/model lookups and answers with a
 * cached-result plus generation-results card list.
 */


import type { Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { StockQuote } from '../../../stock/types.js';
import type { SessionOptions } from '../../../core/types.js';
import { parseInlineModelAndPrompt, fuzzyMatchModels, getFallbackModelSuggestions, MAX_MODEL_SUGGESTIONS } from './inlineModelMatch.js';
import { getEffectiveModelOrder, displayModelName } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { marketCache } from '../../../stock/cache.js';
import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';
import { buildStockBlocks } from './stockHandler.js';
import { ICONS } from '../ui.js';
import { pendingResults, pendingStockRequests, recentInlineQueries, compareContexts, MAX_COMPARE_MODELS, type InlineHandlerOptions } from './inlineContext.js';
import { buildInputRichMessage, THUMBNAILS, type InlineArticle } from './inlineShared.js';
import { escapeHtmlText } from './inlineGeneration.js';

export async function handleInlineQuery(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  options: InlineHandlerOptions,
): Promise<void> {
  const fromId = ctx.from?.id;
  const inlineQuery = ctx.inlineQuery;
  logger.info(`🔥 [INLINE_QUERY TRIGGERED] fromId=${fromId} rawQuery="${inlineQuery?.query}"`);
  if (!inlineQuery || !fromId) return;

  if (options.allowedUsers && options.allowedUsers.length > 0 && !options.allowedUsers.includes(fromId)) {
    const unauthorizedResult = {
      type: 'article' as const,
      id: 'unauthorized',
      title: '⚠️ Unauthorized access',
      description: 'Your Telegram ID is not in the allowed whitelist.',
      thumbnail_url: THUMBNAILS.warning,
      input_message_content: {
        message_text: `${ICONS.warning} <b>Unauthorized access</b>\n\nYour Telegram ID (<code>${fromId}</code>) is not authorized to use this AI Bot's Inline mode.`,
        parse_mode: 'HTML' as const,
      },
    };
    await ctx.answerInlineQuery([unauthorizedResult], { cache_time: 10, is_personal: true }).catch(() => {});
    return;
  }

  const rawQuery = inlineQuery.query;
  const activeSession = sessionManager.getOrCreate
    ? await sessionManager.getOrCreate(fromId, defaultOptions)
    : sessionManager.getSession(fromId);
  const sessionModel = activeSession?.config?.getModel();
  const activeModel = sessionModel || defaultOptions.model || '';
  const allProjects = sessionManager.getProjectsInConfigOrder();
  const { model: modelToUse, prompt: parsedPrompt, family, families, projectUsed, task } = parseInlineModelAndPrompt(rawQuery, activeModel, allProjects);
  let prompt = parsedPrompt;

  // Reuse private chat session CWD logic; if query is explicitly /invest or ticker, target "价值投资分析专家"
  let targetProjectPath = projectUsed?.path;
  if (!targetProjectPath) {
    const isInvestQuery = rawQuery.trim().toLowerCase().startsWith('/invest') || rawQuery.trim().startsWith('$');
    if (isInvestQuery) {
      const investProj = allProjects.find((p) => p.name === '价值投资分析专家' || p.path?.endsWith('value-invest-analysis'));
      targetProjectPath = investProj?.path;
    }
    targetProjectPath = targetProjectPath || activeSession?.currentProject?.path || defaultOptions.cwd;
  }

  // Phase 4b: /invest <symbol> — mark the query so the deterministic
  // value-invest-analysis script runs AFTER the user clicks (chosen_inline_result),
  // keeping the inline popup instant. The model then receives real scored data
  // instead of having to fetch it itself.
  let isInvest = false;
  let investSymbol: string | undefined;
  let investSymbols: string[] | undefined;
  const investMatch = rawQuery.trim().match(/^\/invest\s+(对比|compare|vs)?\s*([\s\S]*)$/i);
  if (investMatch && task !== 'compare') {
    const mode = (investMatch[1] || '').toLowerCase();
    const argStr = (investMatch[2] || '').trim();
    if (mode === '对比' || mode === 'compare' || mode === 'vs') {
      const symbols = argStr.split(/[,\s，、]+/).map((s) => s.replace(/^\$/, '').trim()).filter(Boolean);
      if (symbols.length >= 2) {
        isInvest = true;
        investSymbols = symbols;
        logger.info(`[InlineInvest] Marked /invest comparison for ${symbols.join(', ')} (will prefetch on click)`);
      } else {
        investSymbol = argStr;
        isInvest = true;
        logger.info(`[InlineInvest] Marked /invest query for ${investSymbol} (will prefetch on click)`);
      }
    } else {
      investSymbol = investMatch[2]!.replace(/^\$/, '');
      isInvest = true;
      logger.info(`[InlineInvest] Marked /invest query for ${investSymbol} (will prefetch on click)`);
    }
  }

  // Phase 4 Inline Mode: Stock / Crypto Ticker ($NVDA, $英伟达, $600519, $BTC)
  // Instant 0ms placeholder popup card -> asynchronously loads quote & updates in-place via chosen_inline_result!
  const tickerMatch = rawQuery.trim().match(/^\$([\u4e00-\u9fa5A-Za-z0-9-]{1,20})$/);
  logger.info(`[InlineStockCheck] rawQuery="${rawQuery}" match=${!!tickerMatch}`);
  if (tickerMatch) {
    const queryStr = tickerMatch[1];
    logger.info(`[InlineStockCheck] Query string extracted: "${queryStr}"`);
    const resultId = `stockreq-${Date.now()}-${fromId}`;

    // Instant 0ms synchronous check in cache
    const cleanSym = queryStr.toUpperCase().replace(/^\$/, '').trim();
    const cached = marketCache.get<StockQuote>(`quote:${cleanSym}`);

    let title = `📈 查询股票行情: $${queryStr}`;
    let description = `点击获取 $${queryStr} 最新价格、涨跌幅及华尔街机构评级`;
    let quoteText = `📈 **正在查询 $${queryStr} 实时行情...**\n\n_🚀 数据加载中，请稍候…_`;
    let webAppUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(cleanSym)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

    if (cached) {
      title = `${cached.change >= 0 ? '📈' : '📉'} ${cached.name} ($${cached.symbol})`;
      const currencySymbol = cached.currency === 'CNY' ? '¥' : cached.currency === 'HKD' ? 'HK$' : '$';
      const sign = cached.change >= 0 ? '+' : '';
      description = `${currencySymbol}${cached.price.toFixed(2)} (${sign}${cached.changePercent.toFixed(2)}%) · ${cached.market} ${cached.recommendations ? '· ' + cached.recommendations.consensusText : ''}`;
      const tvSymbol = buildTradingViewSymbol(cached.symbol, cached.market);
      webAppUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;
    }

    // Store pending stock request to update when user clicks
    pendingStockRequests.set(resultId, { queryStr, webAppUrl, createdAt: Date.now() });

    const stockResultCard: InlineArticle = {
      type: 'article' as const,
      id: resultId,
      title,
      description,
      thumbnail_url: THUMBNAILS.sparkles,
      input_message_content: {
        rich_message: cached
          ? { blocks: buildStockBlocks(cached) }
          : { markdown: quoteText },
      },
        reply_markup: {
        inline_keyboard: [
          [
            { text: '📊 View details', url: webAppUrl },
            { text: '📈 K-line chart', url: webAppUrl }
          ],
        ],
      },
    };

    // 0ms instant response to Telegram -> GUARANTEES floating popup window never times out!
    await ctx.answerInlineQuery([stockResultCard], { cache_time: 5, is_personal: true }).catch((e) => {
      logger.error(`[InlineStock] answerInlineQuery error: ${e}`);
    });
    return;
  }

  if (!prompt && task !== 'image') {
    const projectHelpList = allProjects.slice(0, 5).map((p, idx) => `• <code>/p${idx + 1} ask</code> — ${escapeHtmlText(p.name)}`).join('\n');
    const results: InlineArticle[] = [
      {
        type: 'article' as const,
        id: 'help-main',
        title: `🤖 Ask AI — Gemini / DeepSeek / OpenCode`,
        description: `Type a question to ask AI (model: ${displayModelName(modelToUse)})`,
        thumbnail_url: THUMBNAILS.bot,
        input_message_content: {
          message_text: `<b>🤖 AI Inline — @static32bot</b>\n\nType a question after @static32bot to get an AI answer using ${displayModelName(modelToUse)}.\n\n<b>📈 Stock Ticker query:</b>\n• Start with <code>$</code> to check stocks: <code>@static32bot $NVDA</code>, <code>@static32bot $英伟达</code>, <code>@static32bot $600519</code>\n\n<b>Model switches (@keyword):</b>\n• <code>@flash ask</code> — list all Flash models\n• <code>@pro ask</code> — list all Pro models\n• <code>@deep ask</code> — list all DeepSeek models\n• <code>@think ask</code> — list all Thinking models\n\n<b>Project switches (/pN):</b>\n${projectHelpList || "• inherits the bot's currently bound project"}`,
          parse_mode: 'HTML' as const,
        },
      },
      {
        type: 'article' as const,
        id: 'help-flash',
        title: '⚡ @static32bot @flash ask',
        description: 'List all Flash-family models',
        thumbnail_url: THUMBNAILS.sparkles,
        input_message_content: {
          message_text: `⚡ <b>Model search</b>\n\nUse any <code>@keyword</code> prefix to list matching models:\n<code>@static32bot @flash What is quantum computing?</code>\n<code>@static32bot @think Analyze this</code>\n\nPick any matching model from the floating cards.`,
          parse_mode: 'HTML' as const,
        },
      },
      {
        type: 'article' as const,
        id: 'help-pro',
        title: '🧠 @static32bot @pro ask',
        description: 'List all Pro-family models',
        thumbnail_url: THUMBNAILS.thinking,
        input_message_content: {
          message_text: `🧠 <b>Pro family</b>\n\nUse <code>@pro</code> prefix to list all Pro models:\n<code>@static32bot @pro Please explain in detail...</code>\n\nPick any Pro-family model from the floating cards.`,
          parse_mode: 'HTML' as const,
        },
      },
      {
        type: 'article' as const,
        id: 'help-deepseek',
        title: '🔍 @static32bot @deep ask',
        description: 'List all DeepSeek models',
        thumbnail_url: THUMBNAILS.sparkles,
        input_message_content: {
          message_text: `🔍 <b>DeepSeek family</b>\n\nUse <code>@deep</code> or <code>@deepseek</code> prefix:\n<code>@static32bot @deep your question</code>\n\nPick any DeepSeek-family model from the floating cards.`,
          parse_mode: 'HTML' as const,
        },
      },
      {
        type: 'article' as const,
        id: 'help-task',
        title: '🎯 Task prefixes: translate / summarize / image / compare',
        description: '/translate /summarize /img /v one-tap',
        thumbnail_url: THUMBNAILS.sparkles,
        input_message_content: {
          message_text: `🎯 <b>Task prefixes</b>\n\nAdd a prefix before your question to instantly trigger a dedicated mode, and mix it with search prefixes (e.g. <code>@flash /summarize ...</code>):\n\n🌐 <code>/translate content</code> — translate between Chinese & English\n📋 <code>/summarize content</code> — summarize key points\n🖼️ <code>/img prompt</code> — generate image (embedded in place)\n⚖️ <code>/v question</code> — multi-model comparison (pick 2-3 models step by step)`,
          parse_mode: 'HTML' as const,
        },
      },
    ];
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => {});
    return;
  }

  // Store prompt info (no model startup — zero latency)
  logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} task=${task || 'chat'} project="${projectUsed?.name || 'default'}" prompt="${prompt.slice(0, 40)}..."`);

  // Model suggestion cards: when a family keyword (@think/@flash/...) was
  // given, list every model in that family so the user can pick one from the
  // floating cards. Otherwise fuzzy-match the query against all models; if no
  // keyword matches, fall back to the fixed popular suggestions.
  let suggestionCandidates: string[] = [];
  if (task !== 'image') {
    const availableModels = getEffectiveModelOrder();
    if (families.length > 0) {
      // Match models containing ALL keywords first (intersection)
      let matched = availableModels.filter((m) => {
        const lower = m.toLowerCase();
        return families.every((tag) => lower.includes(tag));
      });
      // Fallback to union if intersection is empty
      if (matched.length === 0) {
        matched = availableModels.filter((m) => {
          const lower = m.toLowerCase();
          return families.some((tag) => lower.includes(tag));
        });
      }
      suggestionCandidates = matched;
    } else {
      suggestionCandidates = fuzzyMatchModels(prompt, availableModels, MAX_MODEL_SUGGESTIONS);
      if (suggestionCandidates.length === 0) {
        suggestionCandidates = getFallbackModelSuggestions().filter((m) => availableModels.includes(m));
      }
    }
    suggestionCandidates = suggestionCandidates.filter((m) => m !== modelToUse);
    if (families.length === 0) suggestionCandidates = suggestionCandidates.slice(0, MAX_MODEL_SUGGESTIONS);
  }

  // Family mode: show ONLY one card per matching model (no primary/ask card).
  // The user picks a card and that model answers the prompt directly.
  const familyMode = !!family && suggestionCandidates.length > 0;
  const resultId = `ai-${Date.now()}-${fromId}`;

  if (task === 'compare') {
    let candidates = getEffectiveModelOrder();
    if (families.length > 0 && suggestionCandidates.length > 0) {
      candidates = suggestionCandidates;
    }
    const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
    compareContexts.set(resultId, {
      resultId,
      inlineMessageId: '',
      fromId,
      prompt,
      projectPath: targetProjectPath,
      candidates,
      currentPage: 0,
      selectedIdx: [],
      createdAt: Date.now(),
    });
    const results: InlineArticle[] = [{
      type: 'article' as const,
      id: resultId,
      title: '⚖️ Click to select models to compare',
      description: `Compare the same question with 2-${MAX_COMPARE_MODELS} models in parallel`,
      thumbnail_url: THUMBNAILS.sparkles,
      input_message_content: {
        rich_message: buildInputRichMessage(`**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n_After clicking, select up to ${MAX_COMPARE_MODELS} models for parallel comparison._`),          },
        reply_markup: {
        inline_keyboard: [[{ text: '⏹ Stop', callback_data: `inline_stop:${resultId}` }]],
      },
    }];
    logger.info(`[InlineQuery] Compare mode: sending picker card for "${prompt.slice(0, 40)}..."`);
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
    return;
  }

  if (!familyMode) {
     pendingResults.set(resultId, { ownerId: fromId, prompt, model: modelToUse, projectPath: targetProjectPath, task, createdAt: Date.now(), lastActiveTime: Date.now(), isInvest, investSymbol, investSymbols });
     recentInlineQueries.set(resultId, { prompt, model: modelToUse, task, isInvest, investSymbol, investSymbols, createdAt: Date.now() });
  }

  try {
    const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
    const taskLabel = task === 'image'
      ? '🖼️ **Image generation mode**'
      : task === 'translate' ? '🌐 **Translate mode**'
      : task === 'summarize' ? '📋 **Summarize mode**'
      : task === 'read' ? '📖 **Smart link reading mode**'
      : task === 'compare' ? '⚖️ **Multi-model comparison mode**'
      : undefined;

    if (familyMode) {
      const now = Date.now();
      const results = suggestionCandidates.map((candidateModel, idx) => {
        const candidateId = `m-${now}-${idx}`;
         pendingResults.set(candidateId, { ownerId: fromId, prompt, model: candidateModel, projectPath: targetProjectPath, task, createdAt: now, lastActiveTime: now });
         recentInlineQueries.set(candidateId, { prompt, model: candidateModel, task, createdAt: now });
        return {
          type: 'article' as const,
          id: candidateId,
          title: `🧠 ${displayModelName(candidateModel)}`,
          description: `Answer with ${displayModelName(candidateModel)}`,
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            rich_message: buildInputRichMessage(`${taskLabel ? taskLabel + '\n\n' : ''}**🧠 Target model:** \`${displayModelName(candidateModel)}\`\n\n**💬 Question:** ${displayPrompt}\n\n_🚀 Reasoning in progress; answer updates in place._`),
          },
          // An inline keyboard is REQUIRED for Telegram to return
          // inline_message_id on chosen_inline_result, which is the handle used
          // to stream/update the message in-place (BUGFIX: removed 1056263).
          reply_markup: {
            inline_keyboard: [[
              { text: '⏹ Stop', callback_data: `inline_stop:${candidateId}` }
            ]],
          },
        };
      });

      logger.info(`[InlineQuery] Family mode "${family}": sending ${results.length} model card(s) ids=${results.map((r) => r.id).join(',')}`);
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
      return;
    }

    const initTitle = task === 'image'
      ? `🖼️ Click to generate image [${displayModelName(modelToUse)}]`
      : task === 'translate' ? `🌐 Click to translate [${displayModelName(modelToUse)}]`
      : task === 'summarize' ? `📋 Click to summarize [${displayModelName(modelToUse)}]`
      : task === 'read' ? `📖 Click to read & analyze link [${displayModelName(modelToUse)}]`
      : task === 'compare' ? '⚖️ Click to select models to compare'
      : `🤔 Ask ${displayModelName(modelToUse)}`;
    let initMarkdown: string;
    if (task === 'image') {
      initMarkdown = `**🎨 Image generation mode**\n\n**💬 Prompt:** ${displayPrompt}\n\n_🚀 Generating images; updates in place._`;
    } else {
      const modelLine = `**🧠 Target model:** \`${displayModelName(modelToUse)}\`\n`;
      initMarkdown = `${taskLabel ? taskLabel + '\n\n' : ''}✨ **AI inference engine started**\n\n${modelLine}**💬 Question:** ${displayPrompt}\n\n_🚀 Reasoning in progress; answer updates in place._`;
    }

    const suggestionCards: InlineArticle[] = [];
    {
      const candidates = suggestionCandidates.filter((m) => m !== modelToUse);
      const now = Date.now();
      candidates.forEach((candidateModel, idx) => {
        const candidateId = `m-${now}-${idx}`;
         pendingResults.set(candidateId, { ownerId: fromId, prompt, model: candidateModel, projectPath: targetProjectPath, task, createdAt: now, lastActiveTime: now, isInvest, investSymbol, investSymbols });
         recentInlineQueries.set(candidateId, { prompt, model: candidateModel, task, isInvest, investSymbol, investSymbols, createdAt: now });
        suggestionCards.push({
          type: 'article' as const,
          id: candidateId,
          title: `🧠 Answer with ${displayModelName(candidateModel)}`,
          description: `Switch to model ${displayModelName(candidateModel)}`,
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            rich_message: buildInputRichMessage(`**🧠 Model switch:** \`${displayModelName(candidateModel)}\`\n\n**💬 Question:** ${displayPrompt}\n\n_🚀 Reasoning in progress; answer updates in place._`),
          },
          reply_markup: {
            inline_keyboard: [[
              { text: '⏹ Stop', callback_data: `inline_stop:${candidateId}` }
            ]],
          },
        });
      });
    }

    const results: InlineArticle[] = [
      {
        type: 'article' as const,
        id: resultId,
        title: initTitle,
        description: `${task === 'image' ? 'Generate image' : `Click to send, ${prompt.slice(0, 40)}...`} — AI ${task === 'image' ? 'image' : 'answer'} will auto-update`,
        thumbnail_url: task === 'image' ? THUMBNAILS.sparkles : THUMBNAILS.thinking,
        input_message_content: {
          rich_message: buildInputRichMessage(initMarkdown),
        },
        // An inline keyboard is REQUIRED for Telegram to return
        // inline_message_id on chosen_inline_result, which is the handle used
        // to stream/update the message in-place (BUGFIX: removed 1056263).
        reply_markup: {
          inline_keyboard: [[
            { text: '⏹ Stop', callback_data: `inline_stop:${resultId}` }
          ]],
        },
      },
      ...suggestionCards,
    ];

    logger.info(`[InlineQuery] Sending ${results.length} result(s) family="${family || ''}" primary="${modelToUse}" suggestions=${suggestionCandidates.length} ids=${results.map((r) => r.id).join(',')}`);
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
  } catch (e) {
    logger.error(`Error answering inline query: ${e}`);
    pendingResults.delete(resultId);
  }
}