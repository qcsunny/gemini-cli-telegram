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
  getSymbolMarketSegment,
} from './dailyBriefing.js';
import * as watchlistService from './watchlist.js';
import { marketService } from './quote.js';
import * as inlineHandler from '../../channels/telegram/commands/inlineHandler.js';
import type { StockQuote } from '../types.js';

describe('dailyBriefing service - market segment detection', () => {
  it('should accurately classify symbols into market segments', () => {
    expect(getSymbolMarketSegment('600519')).toBe('cn');
    expect(getSymbolMarketSegment('000001.SZ')).toBe('cn');
    expect(getSymbolMarketSegment('00700')).toBe('hk');
    expect(getSymbolMarketSegment('09988.HK')).toBe('hk');
    expect(getSymbolMarketSegment('NVDA')).toBe('us');
    expect(getSymbolMarketSegment('AAPL')).toBe('us');
    expect(getSymbolMarketSegment('BTC')).toBe('crypto');
  });
});

describe('dailyBriefing service - briefing generation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockNvdaQuote: StockQuote = {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    price: 130.5,
    change: 3.5,
    changePercent: 2.75,
    market: 'NASDAQ',
    currency: 'USD',
  };

  const mockMoutaiQuote: StockQuote = {
    symbol: '600519',
    name: '贵州茅台',
    price: 1600.0,
    change: -10.0,
    changePercent: -0.62,
    market: 'SSE',
    currency: 'CNY',
  };

  it('should format watchlist snapshot table with sector tags', () => {
    const table = formatWatchlistSnapshotTable([mockNvdaQuote, mockMoutaiQuote]);
    expect(table).toContain('[美股]');
    expect(table).toContain('NVDA');
    expect(table).toContain('[A股]');
    expect(table).toContain('600519');
  });

  it('should filter watchlist data by market segment', async () => {
    vi.spyOn(watchlistService, 'getUserWatchlist').mockResolvedValueOnce(['NVDA', '600519']);
    vi.spyOn(marketService, 'getQuote').mockImplementation(async (sym) => {
      if (sym === 'NVDA') return mockNvdaQuote;
      if (sym === '600519') return mockMoutaiQuote;
      return null;
    });

    const cnData = await collectWatchlistMarketData(12345, 'cn');
    expect(cnData.symbols).toEqual(['600519']);
    expect(cnData.watchlistQuotes).toHaveLength(1);

    const usData = await collectWatchlistMarketData(12345, 'us');
    expect(usData.symbols).toEqual(['NVDA']);
    expect(usData.watchlistQuotes).toHaveLength(1);
  });

  it('should generate AI briefing with segment focus', async () => {
    vi.spyOn(watchlistService, 'getUserWatchlist').mockResolvedValueOnce(['600519']);
    vi.spyOn(marketService, 'getQuote').mockResolvedValue(mockMoutaiQuote);
    vi.spyOn(inlineHandler, 'runModelWithFallbackChain').mockResolvedValueOnce({
      result: { output: '## 📅 🇨🇳 A 股市场 AI 复盘简报\n\n今日白酒板块缩量震荡。' } as any,
      modelUsed: 'Gemini 3.7 Flash (High)',
      isFallback: false,
    });

    const res = await generateDailyBriefing(12345, { segment: 'cn' });
    expect(res.markdown).toContain('A 股市场 AI 复盘简报');
    expect(res.segment).toBe('cn');
    expect(res.watchlistQuotes).toHaveLength(1);
  });
});
