/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file dailyBriefing.ts
 * @description Generates automated daily market reviews & AI-driven stock watchlist briefings with sector/market awareness.
 */

import { getUserWatchlist } from './watchlist.js';
import { marketService } from './quote.js';
import type { StockQuote } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getDefaultModel } from '../../config/userConfig.js';
import { runModelWithFallbackChain } from '../../channels/telegram/commands/inlineHandler.js';

export type MarketSegment = 'all' | 'cn' | 'hk' | 'us' | 'crypto';

export interface DailyBriefingResult {
  markdown: string;
  watchlistQuotes: StockQuote[];
  macroQuotes: Record<string, StockQuote | null>;
  segment: MarketSegment;
  modelUsed?: string;
}

const MACRO_INDICES_BY_SEGMENT: Record<MarketSegment, Array<{ symbol: string; name: string }>> = {
  cn: [
    { symbol: '000001', name: '上证指数' },
    { symbol: '399001', name: '深证成指' },
    { symbol: '399006', name: '创业板指' },
  ],
  hk: [
    { symbol: '^HSI', name: '恒生指数' },
    { symbol: '00700', name: '腾讯控股' },
    { symbol: '09988', name: '阿里巴巴' },
  ],
  us: [
    { symbol: '^GSPC', name: '标普500' },
    { symbol: '^IXIC', name: '纳斯达克' },
    { symbol: '^DJI', name: '道琼斯工业' },
  ],
  crypto: [
    { symbol: 'BTC', name: 'Bitcoin' },
    { symbol: 'ETH', name: 'Ethereum' },
    { symbol: 'SOL', name: 'Solana' },
  ],
  all: [
    { symbol: '000001', name: '上证指数' },
    { symbol: '^HSI', name: '恒生指数' },
    { symbol: '^GSPC', name: '标普500' },
    { symbol: '^IXIC', name: '纳斯达克' },
  ],
};

const SEGMENT_NAMES: Record<MarketSegment, string> = {
  cn: '🇨🇳 A 股市场',
  hk: '🇭🇰 港股市场',
  us: '🇺🇸 美股市场',
  crypto: '🪙 加密资产',
  all: '🌐 全市场自选',
};

/**
 * Classifies a stock symbol into its respective market segment.
 */
export function getSymbolMarketSegment(symbol: string, quote?: StockQuote | null): MarketSegment {
  const clean = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (quote?.market === 'SSE' || quote?.market === 'SZSE' || /^\d{6}(\.(SS|SZ|SH))?$/i.test(clean)) {
    return 'cn';
  }
  if (quote?.market === 'HKEX' || /^\d{5}(\.HK)?$/i.test(clean) || clean.endsWith('.HK')) {
    return 'hk';
  }
  if (quote?.market === 'CRYPTO' || ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'USDT'].includes(clean)) {
    return 'crypto';
  }
  return 'us';
}

/**
 * Builds the quantitative briefing data table and financial context for AI analysis.
 */
export async function collectWatchlistMarketData(
  userId: number,
  segment: MarketSegment = 'all'
): Promise<{
  symbols: string[];
  watchlistQuotes: StockQuote[];
  macroQuotes: Record<string, StockQuote | null>;
  segment: MarketSegment;
}> {
  const allSymbols = await getUserWatchlist(userId);
  if (allSymbols.length === 0) {
    return { symbols: [], watchlistQuotes: [], macroQuotes: {}, segment };
  }

  // Concurrently fetch all watchlist quotes
  const quotePromises = allSymbols.map(sym => marketService.getQuote(sym).catch(() => null));
  const fetchedQuotes = await Promise.all(quotePromises);
  const validQuotes = fetchedQuotes.filter((q): q is StockQuote => q !== null);

  // Filter quotes by segment if not 'all'
  const watchlistQuotes = segment === 'all'
    ? validQuotes
    : validQuotes.filter(q => getSymbolMarketSegment(q.symbol, q) === segment);

  const symbols = watchlistQuotes.map(q => q.symbol);

  // Concurrently fetch macro indices for the specified segment
  const macroIndices = MACRO_INDICES_BY_SEGMENT[segment] || MACRO_INDICES_BY_SEGMENT.all;
  const macroQuotes: Record<string, StockQuote | null> = {};
  await Promise.all(
    macroIndices.map(async idx => {
      try {
        const q = await marketService.getQuote(idx.symbol);
        macroQuotes[idx.name] = q;
      } catch {
        macroQuotes[idx.name] = null;
      }
    })
  );

  return { symbols, watchlistQuotes, macroQuotes, segment };
}

/**
 * Formats a clean markdown snapshot table for the watchlist quotes.
 */
export function formatWatchlistSnapshotTable(quotes: StockQuote[]): string {
  if (quotes.length === 0) return '_暂无匹配板块的自选股行情数据_';

  const rows = quotes.map(q => {
    const sign = q.changePercent >= 0 ? '+' : '';
    const emoji = q.changePercent > 0 ? '🟢' : q.changePercent < 0 ? '🔴' : '⚪';
    const currSym = q.currency === 'CNY' ? '¥' : q.currency === 'HKD' ? 'HK$' : '$';
    const seg = getSymbolMarketSegment(q.symbol, q);
    const segTag = seg === 'cn' ? '[A股]' : seg === 'hk' ? '[港股]' : seg === 'us' ? '[美股]' : '[Crypto]';
    return `${emoji} \`${segTag}\` **${q.symbol}** (${q.name || q.symbol}): ${currSym}${q.price.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`;
  });

  return rows.join('\n');
}

/**
 * Generates an AI-driven daily market briefing for the specified user's watchlist and market segment.
 */
export async function generateDailyBriefing(
  userId: number,
  options?: {
    model?: string;
    segment?: MarketSegment;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  }
): Promise<DailyBriefingResult> {
  const segment = options?.segment || 'all';
  const { symbols, watchlistQuotes, macroQuotes } = await collectWatchlistMarketData(userId, segment);
  const segmentName = SEGMENT_NAMES[segment] || '自选股';

  if (symbols.length === 0) {
    const emptyMsg = segment === 'all'
      ? '💡 **您的自选股列表为空**\n\n请使用 `/watchlist add <股票代码...>` 添加关注的标的。'
      : `💡 **您的自选股中暂无 ${segmentName} 标的**\n\n请使用 \`/watchlist add <股票代码...>\` 添加属于该板块的股票（如 A股 600519、美股 NVDA、港股 00700）。`;
    return {
      markdown: emptyMsg,
      watchlistQuotes: [],
      macroQuotes: {},
      segment,
    };
  }

  // Construct structured JSON payload for prompt
  const payload = {
    date: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    marketSegment: segmentName,
    macroMarket: Object.entries(macroQuotes).map(([name, q]) => ({
      name,
      symbol: q?.symbol,
      price: q?.price,
      changePercent: q ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : 'N/A',
    })),
    watchlist: watchlistQuotes.map(q => ({
      symbol: q.symbol,
      name: q.name,
      marketSegment: getSymbolMarketSegment(q.symbol, q),
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

  const segmentPromptFocus =
    segment === 'cn' ? '针对 A 股盘后复盘：重点剖析行业轮动、主力资金流向与政策消息面驱动。' :
    segment === 'hk' ? '针对港股市场：重点关注南向资金、科技蓝筹与外围宏观联动。' :
    segment === 'us' ? '针对美股市场：结合美股大盘趋势、美联储宏观利率预期与龙头科技股/财报表现进行归因。' :
    '针对全市场综合复盘：分板块（A股 / 港股 / 美股）结构化总结并归因。';

  const prompt = `你是一位资深专业的买方投资研究总监与价值投资专家。请基于以下提供的当日【${segmentName}】数据，为用户出具一份专业、清晰、洞察深刻的 AI 盘后/盘前复盘简报。

【输入数据】
${JSON.stringify(payload, null, 2)}

【专精分析重心】
${segmentPromptFocus}

【输出格式与内容要求】
请严格按照以下清晰的 Markdown 结构输出，语言生动专业、重点突出，杜绝空话套话：

## 📅 ${segmentName} AI 复盘简报 (${payload.date})

### 📊 一、 大盘风向与整体情绪
- 概括主要指数表现与整体市场风险偏好（风险偏好上升/防御为主/震荡分化）。

### 📈 二、 自选股全景表现与涨跌动因剖析
- 汇总自选标的当日整体中位数与涨跌分布。
- **重点剖析领涨/领跌前列标的**：结合当日涨跌幅、估值与行业背景，深度归因异动逻辑（资金面、业绩预期、行业政策等）。

### ⚠️ 三、 关键估值与红旗/风险提示
- 提示是否存在短期涨幅过大溢价、估值偏高（PE/PB）、机构评级分歧或潜在业绩承压的标的。

### 🎯 四、 后续跟踪与操作策略关注
- 提炼 2~3 条务实、可落地的观察要点（如下阶段财报披露节点、关键支撑/压力位、仓位配置建议）。

注意：输出内容专业客观，排版美观精炼。`;

  const initialModel = options?.model || getDefaultModel() || 'Gemini 3.7 Flash (High)';
  logger.info(`[DailyBriefing] Generating ${segment} briefing for user ${userId} (${symbols.length} symbols) using model ${initialModel}`);

  const runResult = await runModelWithFallbackChain(
    prompt,
    initialModel,
    {},
    options?.signal,
    undefined,
    options?.onChunk
  );

  const responseText = runResult.result?.output?.trim();
  if (!responseText) {
    const snapshot = formatWatchlistSnapshotTable(watchlistQuotes);
    return {
      markdown: `## 📊 ${segmentName} 行情快报 (${payload.date})\n\n${snapshot}\n\n_注：AI 深度复盘分析生成超时，已为您呈现基础行情快照。_`,
      watchlistQuotes,
      macroQuotes,
      segment,
      modelUsed: runResult.modelUsed,
    };
  }

  return {
    markdown: responseText,
    watchlistQuotes,
    macroQuotes,
    segment,
    modelUsed: runResult.modelUsed,
  };
}
