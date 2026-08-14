/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file dailyBriefing.ts
 * @description Generates automated daily market reviews & AI-driven stock watchlist briefings.
 */

import { getUserWatchlist } from './watchlist.js';
import { marketService } from './quote.js';
import type { StockQuote } from '../types.js';
import { logger } from '../../utils/logger.js';
import { runModelWithFallbackChain } from '../../channels/telegram/commands/inlineHandler.js';
import { getDefaultModel } from '../../config/userConfig.js';

export interface DailyBriefingResult {
  markdown: string;
  watchlistQuotes: StockQuote[];
  macroQuotes: Record<string, StockQuote | null>;
  modelUsed?: string;
}

const MACRO_INDICES = [
  { symbol: '000001', name: '上证指数' },
  { symbol: '399001', name: '深证成指' },
  { symbol: '^HSI', name: '恒生指数' },
  { symbol: '^GSPC', name: '标普500' },
  { symbol: '^IXIC', name: '纳斯达克' },
];

/**
 * Builds the quantitative briefing data table and financial context for AI analysis.
 */
export async function collectWatchlistMarketData(userId: number): Promise<{
  symbols: string[];
  watchlistQuotes: StockQuote[];
  macroQuotes: Record<string, StockQuote | null>;
}> {
  const symbols = await getUserWatchlist(userId);
  if (symbols.length === 0) {
    return { symbols: [], watchlistQuotes: [], macroQuotes: {} };
  }

  // Concurrently fetch all watchlist quotes
  const quotePromises = symbols.map(sym => marketService.getQuote(sym).catch(() => null));
  const fetchedQuotes = await Promise.all(quotePromises);
  const watchlistQuotes = fetchedQuotes.filter((q): q is StockQuote => q !== null);

  // Concurrently fetch macro indices
  const macroQuotes: Record<string, StockQuote | null> = {};
  await Promise.all(
    MACRO_INDICES.map(async idx => {
      try {
        const q = await marketService.getQuote(idx.symbol);
        macroQuotes[idx.name] = q;
      } catch {
        macroQuotes[idx.name] = null;
      }
    })
  );

  return { symbols, watchlistQuotes, macroQuotes };
}

/**
 * Formats a clean markdown snapshot table for the watchlist quotes.
 */
export function formatWatchlistSnapshotTable(quotes: StockQuote[]): string {
  if (quotes.length === 0) return '_暂无自选股行情数据_';

  const rows = quotes.map(q => {
    const sign = q.changePercent >= 0 ? '+' : '';
    const emoji = q.changePercent > 0 ? '🟢' : q.changePercent < 0 ? '🔴' : '⚪';
    const currSym = q.currency === 'CNY' ? '¥' : q.currency === 'HKD' ? 'HK$' : '$';
    return `${emoji} **${q.symbol}** (${q.name || q.symbol}): ${currSym}${q.price.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`;
  });

  return rows.join('\n');
}

/**
 * Generates an AI-driven daily market briefing for the specified user's watchlist.
 */
export async function generateDailyBriefing(
  userId: number,
  options?: {
    model?: string;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  }
): Promise<DailyBriefingResult> {
  const { symbols, watchlistQuotes, macroQuotes } = await collectWatchlistMarketData(userId);

  if (symbols.length === 0) {
    return {
      markdown: '💡 **您的自选股列表为空**\n\n请使用 `/watchlist add <股票代码...>`（例如 `/watchlist add NVDA,AAPL,600519`）添加关注的标的后再生成复盘简报。',
      watchlistQuotes: [],
      macroQuotes: {},
    };
  }

  // Construct structured JSON payload for prompt
  const payload = {
    date: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    macroMarket: Object.entries(macroQuotes).map(([name, q]) => ({
      name,
      symbol: q?.symbol,
      price: q?.price,
      changePercent: q ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : 'N/A',
    })),
    watchlist: watchlistQuotes.map(q => ({
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      currency: q.currency,
      change: q.change,
      changePercent: `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`,
      open: q.open,
      high: q.high,
      low: q.low,
      volume: q.volume,
      pe: q.pe,
      marketCap: q.marketCap,
      performance: {
        '1M': q.performance?.change1M ? `${q.performance.change1M.toFixed(2)}%` : undefined,
        'YTD': q.performance?.changeYTD ? `${q.performance.changeYTD.toFixed(2)}%` : undefined,
      },
      rating: q.recommendations ? {
        consensus: q.recommendations.consensusText,
        buyPct: `${q.recommendations.buyProbability}%`,
        targetMean: q.recommendations.targetPriceMean,
      } : undefined,
    })),
  };

  const prompt = `你是一位资深专业的买方投资研究总监与价值投资专家。请基于以下提供的当日市场与自选股数据，为用户出具一份专业、清晰、洞察深刻的【自选股每日 AI 盘后/盘前复盘简报】。

【输入数据】
${JSON.stringify(payload, null, 2)}

【输出格式与内容要求】
请严格按照以下清晰的 Markdown 结构输出，语言生动专业、重点突出，杜绝空话套话：

## 📅 自选股每日 AI 复盘简报 (${payload.date})

### 📊 一、 大盘风向与市场情绪
- 概括主要指数表现与整体市场风险偏好（风险偏好上升/防御为主/震荡分化）。

### 📈 二、 自选股全景表现与涨跌动因剖析
- 汇总自选股当日整体中位数与涨跌分布。
- **重点剖析领涨/领跌前列标的**：结合当日涨跌幅、估值与行业背景，深度归因异动逻辑（资金面、业绩预期、行业政策等）。

### ⚠️ 三、 关键估值与红旗/风险提示
- 提示是否存在短期涨幅过大溢价、估值偏高（PE/PB）、机构评级分歧或潜在业绩承压的标的。

### 🎯 四、 后续跟踪与操作策略关注
- 提炼 2~3 条务实、可落地的观察要点（如下阶段财报披露节点、关键支撑/压力位、仓位配置建议）。

注意：输出内容专业客观，排版美观精炼。`;

  const initialModel = options?.model || 'Gemini 3.7 Flash (High)';
  logger.info(`[DailyBriefing] Generating briefing for user ${userId} (${symbols.length} symbols) using model ${initialModel}`);

  const runResult = await runModelWithFallbackChain({
    prompt,
    initialModel,
    signal: options?.signal,
    onChunk: options?.onChunk,
    customTimeoutMs: 60_000,
  });

  const responseText = runResult.result?.output?.trim();
  if (!responseText) {
    // Fallback if model fails: return snapshot table directly
    const snapshot = formatWatchlistSnapshotTable(watchlistQuotes);
    return {
      markdown: `## 📊 自选股每日行情快报 (${payload.date})\n\n${snapshot}\n\n_注：AI 深度复盘分析生成超时，已为您呈现基础行情快照。_`,
      watchlistQuotes,
      macroQuotes,
      modelUsed: runResult.modelUsed,
    };
  }

  return {
    markdown: responseText,
    watchlistQuotes,
    macroQuotes,
    modelUsed: runResult.modelUsed,
  };
}
