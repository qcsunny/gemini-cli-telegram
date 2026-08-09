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

export function registerStockHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('stock', async (ctx) => {
    const rawArgs = ctx.match;
    const symbol = typeof rawArgs === 'string' ? rawArgs.trim().toUpperCase().replace(/^\$/, '') : '';

    if (!symbol) {
      await ctx.reply(
        `${ICONS.info} <b>Stock Quote Usage:</b>\n\n<code>/stock NVDA</code>\n<code>/stock AAPL</code>\n<code>/stock BTC</code>\n\nOr use inline query: <code>@bot $NVDA</code>`,
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
      const delayBadge = quote.isDelayed ? '<i>(Delayed ~15m)</i>' : '<i>(Real-time)</i>';

      const blocksPayload = [
        {
          type: 'paragraph',
          text: [
            `${icon} <b>${quote.name}</b>\n\n代号：`,
            { type: 'cashtag', text: [`$${quote.symbol}`], cashtag: quote.symbol },
            `\n\n<b>当前价格：</b>$${quote.price.toFixed(2)}\n<b>涨跌：</b>${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n\n<b>市场：</b>${quote.market}\n<b>数据时间：</b>${new Date(quote.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${delayBadge}`
          ]
        }
      ];

      const webAppUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(
        quote.market === 'CRYPTO' ? `BINANCE:${quote.symbol}USDT` : `NASDAQ:${quote.symbol}`
      )}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

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
