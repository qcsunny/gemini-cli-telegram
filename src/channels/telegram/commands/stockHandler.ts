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
import type { StockQuote } from '../../../stock/types.js';
import { marketService } from '../../../stock/service/quote.js';
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
        { type: 'bold', text: ['📊 阶段涨跌表现：'] },
        `\n• 近1个月：${fmtPerf(perf?.change1M)}  |  近3个月：${fmtPerf(perf?.change3M)}` +
        `\n• 近6个月：${fmtPerf(perf?.change6M)}  |  近1年：${fmtPerf(perf?.change1Y)}` +
        `\n• 今年以来 (YTD)：${fmtPerf(perf?.changeYTD)}\n\n`,
        { type: 'bold', text: ['📋 当日行情：'] },
        `\n• 今开：${quote.open !== undefined ? fmtPrice(quote.open) : '--'}` +
        `  |  昨收：${quote.previousClose !== undefined ? fmtPrice(quote.previousClose) : '--'}` +
        `\n• 最高：${quote.high !== undefined ? fmtPrice(quote.high) : '--'}` +
        `  |  最低：${quote.low !== undefined ? fmtPrice(quote.low) : '--'}` +
        `\n• 成交量：${quote.volume !== undefined ? fmtVol(quote.volume) : '--'}` +
        (quote.high52 && quote.low52 ? `\n• 52周最高：${fmtPrice(quote.high52)}  |  52周最低：${fmtPrice(quote.low52)}` : '') +
        ((quote.high !== undefined && quote.low !== undefined && quote.previousClose) ? `\n• 日振幅：${((quote.high - quote.low) / quote.previousClose * 100).toFixed(2)}%` : '') +
        (quote.marketCap ? `\n• 总市值：$${fmtCap(quote.marketCap)}` : '') +
        (quote.pe !== undefined ? `\n• 市盈率 (PE)：${quote.pe.toFixed(2)}` : '') +
        (quote.pb !== undefined ? `\n• 市净率 (PB)：${quote.pb.toFixed(2)}` : '') +
        (quote.turnoverRate !== undefined ? `\n• 换手率：${quote.turnoverRate.toFixed(2)}%` : '') +
        `\n\n`,
        { type: 'bold', text: ['市场：'] },
        `${quote.market}\n`,
        { type: 'bold', text: ['数据时间：'] },
        `${new Date(quote.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} `,
        { type: 'italic', text: [delayBadge] },
      ]
    }
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
      const blocksPayload = buildStockBlocks(quote);

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const webAppUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await ctx.api.sendRichMessage(ctx.chat.id, { blocks: blocksPayload as any }, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', web_app: { url: webAppUrl } },
              { text: '📈 K线图', web_app: { url: webAppUrl } }
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
