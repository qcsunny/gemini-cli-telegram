/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file quote.ts
 * @description Market Data Quote Service for fetching, aggregating, and caching stock & crypto quotes.
 */

import type { MarketDataProvider, StockQuote, StockCandles, StockSearchResult } from '../types.js';
import { CoinGeckoProvider } from '../provider/coingecko.js';
import { StockFallbackProvider } from '../provider/stockFallback.js';
import { marketCache } from '../cache.js';
import { logger } from '../../utils/logger.js';

const QUOTE_TTL_MS = 5_000; // 5 second cache TTL for quotes
const CANDLE_TTL_MS = 30_000; // 30 second cache TTL for candles

export class MarketService {
  private providers: MarketDataProvider[];

  constructor() {
    this.providers = [
      new CoinGeckoProvider(),
      new StockFallbackProvider(),
    ];
  }

  async getQuote(symbol: string): Promise<StockQuote | null> {
    const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
    if (!cleanSym) return null;

    const cacheKey = `quote:${cleanSym}`;
    const cached = marketCache.get<StockQuote>(cacheKey);
    if (cached) return cached;

    for (const provider of this.providers) {
      try {
        const quote = await provider.getQuote(cleanSym);
        if (quote) {
          marketCache.set(cacheKey, quote, QUOTE_TTL_MS);
          return quote;
        }
      } catch (err) {
        logger.warn(`[MarketService] Provider ${provider.name} failed for ${cleanSym}: ${err}`);
      }
    }

    return null;
  }

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const results: StockQuote[] = [];
    for (const sym of symbols) {
      const q = await this.getQuote(sym);
      if (q) results.push(q);
    }
    return results;
  }

  async getCandles(symbol: string, interval = '5m', range = '1d'): Promise<StockCandles | null> {
    const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
    if (!cleanSym) return null;

    const cacheKey = `candles:${cleanSym}:${interval}:${range}`;
    const cached = marketCache.get<StockCandles>(cacheKey);
    if (cached) return cached;

    for (const provider of this.providers) {
      try {
        const candles = await provider.getCandles(cleanSym, interval, range);
        if (candles) {
          marketCache.set(cacheKey, candles, CANDLE_TTL_MS);
          return candles;
        }
      } catch (err) {
        logger.warn(`[MarketService] Provider ${provider.name} failed candles for ${cleanSym}: ${err}`);
      }
    }

    return null;
  }

  async searchSymbols(query: string): Promise<StockSearchResult[]> {
    const cleanQ = query.trim();
    if (!cleanQ) return [];

    const cacheKey = `search:${cleanQ.toUpperCase()}`;
    const cached = marketCache.get<StockSearchResult[]>(cacheKey);
    if (cached) return cached;

    const allResults: StockSearchResult[] = [];
    for (const provider of this.providers) {
      try {
        const res = await provider.searchSymbols(cleanQ);
        allResults.push(...res);
      } catch (err) {
        logger.warn(`[MarketService] Provider ${provider.name} search failed for ${cleanQ}: ${err}`);
      }
    }

    marketCache.set(cacheKey, allResults, 60_000);
    return allResults;
  }
}

export const marketService = new MarketService();
