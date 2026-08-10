/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { StockFallbackProvider } from './provider/stockFallback.js';
import { MarketService } from './service/quote.js';
import { marketCache } from './cache.js';

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
