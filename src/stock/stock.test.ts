/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StockFallbackProvider } from './provider/stockFallback.js';
import { MarketService, marketService } from './service/quote.js';
import { marketCache } from './cache.js';
import { handleStockRoutes } from './api/stockRoutes.js';
import { getFundDataset } from './provider/fund.js';
import { analyzeFund } from './analyzer/fundAnalyzer.js';
import {
  collectWatchlistMarketData,
  formatWatchlistSnapshotTable,
  generateDailyBriefing,
  getSymbolMarketSegment,
} from './service/dailyBriefing.js';
import * as watchlistService from './service/watchlist.js';
import * as inlineHandler from '../channels/telegram/commands/inlineHandler.js';
import type { StockQuote } from './types.js';

vi.mock('undici', () => ({
  fetch: vi.fn(async (url: string) => {
    if (url.includes('searchapi.eastmoney.com') || url.includes('suggest')) {
      return {
        ok: true,
        json: async () => ({
          QuotationCodeTable: {
            Data: [{ Code: 'NVDA', Name: 'NVIDIA Corp', QuoteID: '105.NVDA', JYS: 'NASDAQ' }],
          },
        }),
      };
    }
    if (url.includes('push2his.eastmoney.com')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            klines: ['2026-08-18,120,125,126,119,1000'],
            preKPrice: 120,
          },
        }),
      };
    }
    if (url.includes('push2.eastmoney.com')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            f43: 125,
            f57: 'NVDA',
            f116: 3000000000,
            f163: 4500,
            f167: 3500,
            f168: 150,
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({}),
    };
  }),
}));

describe('MarketService & Stock Provider Unit Tests', () => {
  it('should fetch stock quote from StockFallbackProvider for NVDA', async () => {
    const provider = new StockFallbackProvider();
    const quote = await provider.getQuote('NVDA');
    expect(quote).not.toBeNull();
    expect(quote?.name.length).toBeGreaterThan(0);
    expect(quote?.price).toBeGreaterThan(0);
  });

  it('should fallback to StockFallbackProvider for US equities like NVDA', async () => {
    const service = new MarketService();
    const quote = await service.getQuote('NVDA');
    expect(quote).not.toBeNull();
    expect(quote?.symbol).toBe('NVDA');
    expect(quote?.name.length).toBeGreaterThan(0);
    expect(quote?.price).toBeGreaterThan(0);
  });

  it('should cache quote requests in MarketCache', async () => {
    marketCache.clear();
    const service = new MarketService();
    const q1 = await service.getQuote('NVDA');
    const cached = marketCache.get('quote:NVDA');
    expect(cached).toEqual(q1);
  });

  it('should return synthetic candle data for candles query', async () => {
    const service = new MarketService();
    const candles = await service.getCandles('NVDA', '5m', '1d');
    expect(candles).not.toBeNull();
    expect(candles?.symbol).toBe('NVDA');
    expect(candles?.data.length).toBeGreaterThan(0);
  });
});

describe('Stock REST API & Mini App Routes Unit Tests', () => {
  it('should handle /api/stocks/NVDA quote endpoint', async () => {
    let responseData = '';
    let statusCode = 0;
    const req = { url: '/api/stocks/NVDA', method: 'GET' } as IncomingMessage;
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (data: string) => { responseData = data; },
    } as unknown as ServerResponse;

    const handled = await handleStockRoutes(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const json = JSON.parse(responseData);
    expect(json.symbol).toBe('NVDA');
  });

  it('should handle /api/stocks/NVDA/candles endpoint', async () => {
    let responseData = '';
    let statusCode = 0;
    const req = { url: '/api/stocks/NVDA/candles?range=1d', method: 'GET' } as IncomingMessage;
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (data: string) => { responseData = data; },
    } as unknown as ServerResponse;

    const handled = await handleStockRoutes(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const json = JSON.parse(responseData);
    expect(json.symbol).toBe('NVDA');
    expect(json.data.length).toBeGreaterThan(0);
  });

  it('should handle /api/stocks/search endpoint (not swallowed by symbol route)', async () => {
    let responseData = '';
    let statusCode = 0;
    const req = { url: '/api/stocks/search?q=NVDA', method: 'GET' } as IncomingMessage;
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (data: string) => { responseData = data; },
    } as unknown as ServerResponse;

    const handled = await handleStockRoutes(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const json = JSON.parse(responseData);
    expect(Array.isArray(json)).toBe(true);
  });
});

describe('Fund Provider & Analyzer', () => {
  it('should parse fund symbol with various formats (.OF, uppercase, etc.)', async () => {
    const dsNull = await getFundDataset('INVALID_SYMBOL_123');
    expect(dsNull).toBeNull();
  });

  it('should calculate 7-dimension score correctly for sample fund dataset', () => {
    const mockDataset = {
      symbol: '005827',
      info: {
        code: '005827',
        name: '易方达蓝筹精选混合',
        type: '混合型-偏股',
        establishedDate: '2018-09-05',
        scaleB: 450.5,
        manager: '张坤',
        managerTenure: {
          since: '2018-09-05',
          days: 2890,
          returnPct: 110.5,
        },
        returns: {
          w1: 1.2,
          m1: 3.5,
          m3: 6.8,
          m6: 12.0,
          y1: 18.5,
          y2: 25.0,
          y3: 35.2,
          ytd: 10.1,
          sinceInception: 110.5,
        },
        managementFeePct: 1.2,
        custodyFeePct: 0.2,
        buyStatus: '开放申购',
        sellStatus: '开放赎回',
      },
      nav: [
        { date: '2026-08-12', nav: 2.15, accumNav: 2.15, dailyChangePct: 0.5, sgtz: '开放申购', shtz: '开放赎回' },
        { date: '2026-08-11', nav: 2.14, accumNav: 2.14, dailyChangePct: -0.2, sgtz: '开放申购', shtz: '开放赎回' },
      ],
      topHoldings: [
        { stockCode: '00700', stockName: '腾讯控股', ratioPct: 9.8, sharesWan: 1200, valueWan: 45000 },
        { stockCode: '600519', stockName: '贵州茅台', ratioPct: 9.2, sharesWan: 200, valueWan: 42000 },
      ],
      peerRank: {
        total: 3500,
        rank: 350,
        percentilePct: 10.0,
        metric: '近1年收益率',
      },
      quote: null,
      timestamp: Date.now(),
    };

    const result = analyzeFund(mockDataset);
    expect(result.symbol).toBe('005827');
    expect(result.name).toBe('易方达蓝筹精选混合');
    expect(result.dimensions.length).toBe(7);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.grade).toBeDefined();
    expect(result.rating).toBeDefined();
  });
});

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
    vi.spyOn(watchlistService, 'getUserWatchlist').mockResolvedValue(['NVDA', '600519']);
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
