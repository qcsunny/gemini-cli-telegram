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
import { getStockMarketApiKey } from '../../config/userConfig.js';
import { fetchFmpRating } from '../utils/analystRating.js';

const QUOTE_TTL_MS = 5_000; // 5 second cache TTL for quotes
const CANDLE_TTL_MS = 30_000; // 30 second cache TTL for candles

export class MarketService {
  private providers: MarketDataProvider[];
  /** Per-symbol in-flight quote fetches (single-flight dedup). */
  private inflight = new Map<string, Promise<StockQuote | null>>();

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

    const existing = this.inflight.get(cleanSym);
    if (existing) return existing;

    const task = this.fetchQuote(cleanSym, cacheKey);
    this.inflight.set(cleanSym, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(cleanSym);
    }
  }

  private async fetchQuote(cleanSym: string, cacheKey: string): Promise<StockQuote | null> {
    for (const provider of this.providers) {
      try {
        const quote = await provider.getQuote(cleanSym);
        if (quote) {
          // Enrich quote with the real FMP analyst rating & price-target
          // consensus (24h cached; skipped entirely without an API key).
          const apiKey = getStockMarketApiKey();
          if (apiKey) {
            try {
              const rec = await fetchFmpRating(cleanSym, apiKey);
              if (rec) quote.recommendations = rec;
            } catch (err) {
              logger.warn(`[MarketService] FMP rating enrichment failed for ${cleanSym}: ${err}`);
            }
          }

          // Asynchronously attempt to enrich quote with performance metrics in
          // background without blocking the response. Only write back if the
          // cache still holds our quote object (never clobber a newer one).
          this.getCandles(cleanSym, '1d', '1y').then(async (candles) => {
            if (candles && candles.data && marketCache.get<StockQuote>(cacheKey) === quote) {
              const { calculatePerformance } = await import('../utils/performance.js');
              quote.performance = calculatePerformance(quote.price, candles.data);
              marketCache.set(cacheKey, quote, QUOTE_TTL_MS);
            }
          }).catch(() => {});

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
    const results = await Promise.all(symbols.map((sym) => this.getQuote(sym)));
    return results.filter((q): q is StockQuote => q !== null);
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
