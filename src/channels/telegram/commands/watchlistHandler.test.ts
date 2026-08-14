/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWatchlistKeyboard,
  renderWatchlistCard,
  registerWatchlistCommands,
} from './watchlistHandler.js';
import * as watchlistService from '../../../stock/service/watchlist.js';
import * as dailyBriefing from '../../../stock/service/dailyBriefing.js';

describe('watchlistHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should build watchlist keyboard with action and deletion buttons', () => {
    const kb = buildWatchlistKeyboard(['NVDA', 'AAPL']);
    expect(kb).toBeDefined();
  });

  it('should render empty card if user has no watchlist symbols', async () => {
    vi.spyOn(dailyBriefing, 'collectWatchlistMarketData').mockResolvedValueOnce({
      symbols: [],
      watchlistQuotes: [],
      macroQuotes: {},
    });

    const card = await renderWatchlistCard(12345);
    expect(card.text).toContain('您的自选股监控池为空');
  });

  it('should render watchlist card with quotes and action buttons', async () => {
    vi.spyOn(dailyBriefing, 'collectWatchlistMarketData').mockResolvedValueOnce({
      symbols: ['NVDA'],
      watchlistQuotes: [
        {
          symbol: 'NVDA',
          name: 'NVIDIA Corporation',
          price: 130.5,
          change: 3.5,
          changePercent: 2.75,
          market: 'NASDAQ',
          currency: 'USD',
        },
      ],
      macroQuotes: {},
    });

    const card = await renderWatchlistCard(12345);
    expect(card.text).toContain('我的自选股实时监控池 (1 只标的)');
    expect(card.text).toContain('NVDA');
  });

  it('should register watchlist commands on the bot', () => {
    const bot = {
      command: vi.fn(),
      callbackQuery: vi.fn(),
    } as any;

    registerWatchlistCommands(bot);
    expect(bot.command).toHaveBeenCalledWith(['watchlist', 'wl'], expect.any(Function));
    expect(bot.callbackQuery).toHaveBeenCalledWith(/^wl_/, expect.any(Function));
  });
});
