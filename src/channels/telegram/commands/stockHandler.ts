/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file stockHandler.ts
 * @description Telegram command handler for `/stock <symbol>` and stock details formatting.
 */

import type { Bot } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type { StockQuote, StockFinancial } from '../../../stock/types.js';
import { marketService } from '../../../stock/service/quote.js';
import { getStockMarketApiKey } from '../../../config/userConfig.js';
import { fetchRecentFinancials } from '../../../stock/provider/fmp.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';

export function buildStockBlocks(quote: StockQuote): Array<Record<string, any>> {
  const sign = quote.change >= 0 ? '+' : '';
  const icon = quote.change >= 0 ? '📈' : '📉';
  const delayBadge = quote.isDelayed ? '(Delayed ~15m)' : '(Real-time)';

  const perf = quote.performance;
  const fmtPerf = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    const s = val >= 0 ? '+' : '';
    return `${s}${val.toFixed(2)}%`;
  };
  const fmtPrice = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    return `${quote.currency === 'CNY' ? '¥' : quote.currency === 'HKD' ? 'HK$' : '$'}${val.toFixed(2)}`;
  };
  const fmtVol = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `${(val / 1e3).toFixed(2)}K`;
    return `${val}`;
  };
  const fmtCap = (val: number) => {
    if (val >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    return `${val.toFixed(0)}`;
  };

  const rec = quote.recommendations;
  const recSection = rec ? [
    { type: 'bold', text: ['🏦 华尔街/机构评级建议：'] },
    `\n• 综合评级：${rec.consensusText}` +
    `\n• 建议买入比例：${rec.buyProbability}%  (买入:${rec.buy+rec.strongBuy}家)` +
    `\n• 建议持有比例：${rec.holdProbability}%  (持有:${rec.hold}家)` +
    `\n• 建议卖出比例：${rec.sellProbability}%  (卖出:${rec.sell+rec.strongSell}家)` +
    (rec.targetPriceMean ? `\n• 机构目标均价：$${rec.targetPriceMean} (最高:$${rec.targetPriceHigh} / 最低:$${rec.targetPriceLow})\n\n` : '\n\n')
  ] : [];

  const mkCell = (label: string, value: string): Array<Record<string, any>> => [
    { text: { type: 'bold', text: [label] }, align: 'left', valign: 'middle' },
    { text: value, align: 'center', valign: 'middle' },
  ];

  const perfCells: Array<Array<Record<string, any>>> = [];
  if (perf) {
    perfCells.push(mkCell('近1个月', fmtPerf(perf.change1M)));
    perfCells.push(mkCell('近3个月', fmtPerf(perf.change3M)));
    perfCells.push(mkCell('近6个月', fmtPerf(perf.change6M)));
    perfCells.push(mkCell('近1年', fmtPerf(perf.change1Y)));
    perfCells.push(mkCell('今年以来 (YTD)', fmtPerf(perf.changeYTD)));
  }

  const quoteCells: Array<Array<Record<string, any>>> = [];
  const addRow = (label: string, value?: string) => {
    if (value !== undefined && value !== '--') quoteCells.push(mkCell(label, value));
  };
  addRow('今开', quote.open !== undefined ? fmtPrice(quote.open) : undefined);
  addRow('昨收', quote.previousClose !== undefined ? fmtPrice(quote.previousClose) : undefined);
  addRow('最高', quote.high !== undefined ? fmtPrice(quote.high) : undefined);
  addRow('最低', quote.low !== undefined ? fmtPrice(quote.low) : undefined);
  addRow('成交量', quote.volume !== undefined ? fmtVol(quote.volume) : undefined);
  addRow('日振幅', (quote.high !== undefined && quote.low !== undefined && quote.previousClose) ? `${((quote.high - quote.low) / quote.previousClose * 100).toFixed(2)}%` : undefined);
  addRow('总市值', quote.marketCap ? `$${fmtCap(quote.marketCap)}` : undefined);
  addRow('市盈率 (PE)', quote.pe !== undefined ? quote.pe.toFixed(2) : undefined);
  addRow('市净率 (PB)', quote.pb !== undefined ? quote.pb.toFixed(2) : undefined);
  addRow('换手率', quote.turnoverRate !== undefined ? `${quote.turnoverRate.toFixed(2)}%` : undefined);
  addRow('52周最高', quote.high52 && quote.low52 ? fmtPrice(quote.high52) : undefined);
  addRow('52周最低', quote.high52 && quote.low52 ? fmtPrice(quote.low52) : undefined);

  return [
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: [`${icon} ${quote.name}`] },
        '\n\n代号：',
        { type: 'cashtag', text: [`$${quote.symbol}`], cashtag: quote.symbol },
        '\n\n',
        { type: 'bold', text: ['当前价格：'] },
        `${quote.currency === 'CNY' ? '¥' : quote.currency === 'HKD' ? 'HK$' : '$'}${quote.price.toFixed(2)}\n`,
        { type: 'bold', text: ['当日涨跌：'] },
        `${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n\n`,
        ...recSection,
      ]
    },
    ...(perfCells.length ? [
      { type: 'paragraph', text: [{ type: 'bold', text: ['📊 阶段涨跌表现：'] }] },
      { type: 'table', cells: perfCells, is_bordered: true, is_striped: true },
    ] : []),
    ...(quoteCells.length ? [
      { type: 'paragraph', text: [{ type: 'bold', text: ['📋 当日行情：'] }] },
      { type: 'table', cells: quoteCells, is_bordered: true, is_striped: true },
    ] : []),
    ...(quote.financials?.length ? buildFinancialBlocks(quote.financials, quote.currency) : []),
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: ['市场：'] },
        `${quote.market}\n`,
        { type: 'bold', text: ['数据时间：'] },
        `${new Date(quote.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} `,
        { type: 'italic', text: [delayBadge] },
      ]
    }
  ];
}

/**
 * Builds the "近期财报" section as a list of collapsible details blocks — one
 * per reported quarter — to avoid making the stock card too long.
 */
export function buildFinancialBlocks(
  financials: StockFinancial[],
  currency?: string,
): Array<Record<string, any>> {
  const cur = currency === 'CNY' ? '¥' : currency === 'HKD' ? 'HK$' : '$';
  const fmtAmount = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    if (val >= 1e9) return `${cur}${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${cur}${(val / 1e6).toFixed(2)}M`;
    return `${cur}${val.toFixed(0)}`;
  };
  const mkCell = (label: string, value: string): Array<Record<string, any>> => [
    { text: { type: 'bold', text: [label] }, align: 'left', valign: 'middle' },
    { text: value, align: 'center', valign: 'middle' },
  ];

  const detailsBlocks: Array<Record<string, any>> = [];
  for (const f of financials) {
    const margin = f.revenue ? ((f.netIncome / f.revenue) * 100).toFixed(2) : undefined;
    const cells: Array<Array<Record<string, any>>> = [];
    cells.push(mkCell('报告期', `${f.period}（${f.date}）`));
    cells.push(mkCell('营收', fmtAmount(f.revenue)));
    cells.push(mkCell('毛利', fmtAmount(f.grossProfit)));
    cells.push(mkCell('营业利润', fmtAmount(f.operatingIncome)));
    cells.push(mkCell('净利润', fmtAmount(f.netIncome)));
    cells.push(mkCell('净利率', margin ? `${margin}%` : '--'));
    cells.push(mkCell('每股收益 (EPS)', f.epsDiluted !== undefined ? f.epsDiluted.toFixed(2) : '--'));
    detailsBlocks.push({
      type: 'details',
      summary: `📊 ${f.period} · 营收 ${fmtAmount(f.revenue)} · 净利 ${fmtAmount(f.netIncome)}`,
      blocks: [
        { type: 'table', cells, is_bordered: true, is_striped: true },
      ],
    });
  }

  return [
    { type: 'paragraph', text: [{ type: 'bold', text: ['📅 近期财报（最近' + String(financials.length) + '个季度）：'] }] },
    ...detailsBlocks,
  ];
}

export async function ensureQuotePerformance(quote: StockQuote): Promise<StockQuote> {
  if (quote.performance) return quote;
  try {
    const candles = await marketService.getCandles(quote.symbol, '1d', '1y');
    if (candles && candles.data) {
      const { calculatePerformance } = await import('../../../stock/utils/performance.js');
      quote.performance = calculatePerformance(quote.price, candles.data);
      let high52 = -Infinity;
      let low52 = Infinity;
      for (const point of candles.data) {
        if (point.high > high52) high52 = point.high;
        if (point.low < low52) low52 = point.low;
      }
      if (high52 !== -Infinity) quote.high52 = high52;
      if (low52 !== Infinity) quote.low52 = low52;
    }
  } catch (err) {
    logger.warn(`[ensureQuotePerformance] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}

/**
 * Enriches a quote with recent quarterly financials (FMP) when an API key is
 * configured. No-op when the key is missing or data already present.
 */
export async function ensureQuoteFinancials(quote: StockQuote): Promise<StockQuote> {
  if (quote.financials) return quote;
  const apiKey = getStockMarketApiKey();
  if (!apiKey) return quote;
  try {
    const financials = await fetchRecentFinancials(quote.symbol, apiKey);
    if (financials) quote.financials = financials;
  } catch (err) {
    logger.warn(`[ensureQuoteFinancials] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}

export function registerStockHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('stock', async (ctx) => {
    const rawArgs = ctx.match;
    const symbol = typeof rawArgs === 'string' ? rawArgs.trim().replace(/^\$/, '') : '';

    if (!symbol) {
      await ctx.reply(
        `${ICONS.info} <b>Stock Quote Usage:</b>\n\n<code>/stock NVDA</code>\n<code>/stock 600519</code>\n<code>/stock 00700</code>\n<code>/stock BTC</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      const quote = await marketService.getQuote(symbol);
      if (!quote) {
        await ctx.reply(`${ICONS.warning} ⚠️ <b>Symbol not found:</b> ${symbol}\n\nPlease check the symbol and try again.`);
        return;
      }

      await ensureQuotePerformance(quote);

      const apiKey = getStockMarketApiKey();
      if (apiKey && !quote.financials) {
        const financials = await fetchRecentFinancials(quote.symbol, apiKey);
        if (financials) quote.financials = financials;
      }

      const blocksPayload = buildStockBlocks(quote);

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const detailUrl = `https://www.tradingview.com/symbols/${tvSymbol.replace(':', '-')}/`;
      const chartUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await ctx.api.sendRichMessage(ctx.chat.id, { blocks: blocksPayload as any }, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', web_app: { url: detailUrl } },
              { text: '📈 K线图', web_app: { url: chartUrl } }
            ]
          ]
        }
      });
    } catch (err) {
      logger.error(`Failed to handle /stock command for ${symbol}: ${err}`);
      await ctx.reply(`${ICONS.error} <b>Error fetching market quote for ${symbol}</b>`);
    }
  });
}
