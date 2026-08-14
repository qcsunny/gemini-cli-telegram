/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectWatchlistMarketData,
  formatWatchlistSnapshotTable,
  generateDailyBriefing,
} from './dailyBriefing.js';
import * as watchlistService from './watchlist.js';
import { marketService } from './quote.js';
import * as inlineHandler from '../../channels/telegram/commands/inlineHandler.js';
import type { StockQuote } from '../types.js';

describe('dailyBriefing service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockQuote: StockQuote = {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    price: 130.5,
    change: 3.5,
    changePercent: 2.75,
    market: 'NASDAQ',
    currency: 'USD',
  };

  it('should format watchlist snapshot table cleanly', () => {
    const table = formatWatchlistSnapshotTable([mockQuote]);
    expect(table).toContain('NVDA');
    expect(table).toContain('$130.50');
    expect(table).toContain('+2.75%');
  });

  it('should return empty guidance if watchlist is empty', async () => {
    vi.spyOn(watchlistService, 'getUserWatchlist').mockResolvedValueOnce([]);

    const res = await generateDailyBriefing(12345);
    expect(res.markdown).toContain('您的自选股列表为空');
    expect(res.watchlistQuotes).toHaveLength(0);
  });

  it('should collect quotes and generate AI briefing using fallback chain', async () => {
    vi.spyOn(watchlistService, 'getUserWatchlist').mockResolvedValueOnce(['NVDA']);
    vi.spyOn(marketService, 'getQuote').mockResolvedValue(mockQuote);
    vi.spyOn(inlineHandler, 'runModelWithFallbackChain').mockResolvedValueOnce({
      result: { output: '## 📅 自选股每日 AI 复盘简报\n\n今日英伟达领涨大盘。' } as any,
      modelUsed: 'Gemini 3.7 Flash (High)',
      isFallback: false,
    });

    const res = await generateDailyBriefing(12345);
    expect(res.markdown).toContain('自选股每日 AI 复盘简报');
    expect(res.markdown).toContain('今日英伟达领涨大盘');
    expect(res.watchlistQuotes).toHaveLength(1);
    expect(res.modelUsed).toBe('Gemini 3.7 Flash (High)');
  });
});
