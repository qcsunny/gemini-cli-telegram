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
import { marketService } from '../../../stock/service/quote.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';

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

      const sign = quote.change >= 0 ? '+' : '';
      const icon = quote.change >= 0 ? '📈' : '📉';
      const delayBadge = quote.isDelayed ? '(Delayed ~15m)' : '(Real-time)';

      const perf = quote.performance;
      const fmtPerf = (val?: number) => {
        if (val === undefined || isNaN(val)) return '--';
        const s = val >= 0 ? '+' : '';
        return `${s}${val.toFixed(2)}%`;
      };

      const blocksPayload = [
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
            { type: 'bold', text: ['📊 阶段涨跌表现：'] },
            `\n• 近1个月：${fmtPerf(perf?.change1M)}  |  近3个月：${fmtPerf(perf?.change3M)}` +
            `\n• 近6个月：${fmtPerf(perf?.change6M)}  |  近1年：${fmtPerf(perf?.change1Y)}` +
            `\n• 今年以来 (YTD)：${fmtPerf(perf?.changeYTD)}\n\n`,
            { type: 'bold', text: ['市场：'] },
            `${quote.market}\n`,
            { type: 'bold', text: ['数据时间：'] },
            `${new Date(quote.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} `,
            { type: 'italic', text: [delayBadge] },
          ]
        }
      ];

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
