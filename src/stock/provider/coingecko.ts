/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file coingecko.ts
 * @description CoinGecko provider for crypto market data (BTC, ETH, SOL, etc.).
 */

import type { MarketDataProvider, StockQuote, StockCandles, StockSearchResult, CandleDataPoint } from '../types.js';
import { logger } from '../../utils/logger.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';

const CRYPTO_MAP: Record<string, { id: string; name: string }> = {
  BTC: { id: 'bitcoin', name: 'Bitcoin' },
  ETH: { id: 'ethereum', name: 'Ethereum' },
  SOL: { id: 'solana', name: 'Solana' },
  ADA: { id: 'cardano', name: 'Cardano' },
  DOGE: { id: 'dogecoin', name: 'Dogecoin' },
  XRP: { id: 'ripple', name: 'XRP' },
};

export class CoinGeckoProvider implements MarketDataProvider {
  readonly name = 'CoinGecko';

  async getQuote(symbol: string): Promise<StockQuote | null> {
    const cleanSym = symbol.toUpperCase().replace(/^\$/, '');
    const meta = CRYPTO_MAP[cleanSym];
    if (!meta) return null;

    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${meta.id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 3000);
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      const coin = data[meta.id];
      if (!coin || typeof coin !== 'object' || Array.isArray(coin)) return null;
      const coinData = coin as Record<string, unknown>;

      const price = typeof coinData['usd'] === 'number' ? coinData['usd'] : 0;
      const changePercent = typeof coinData['usd_24h_change'] === 'number' ? coinData['usd_24h_change'] : 0;
      const change = (price * changePercent) / 100;

      return {
        symbol: cleanSym,
        name: meta.name,
        price,
        change,
        changePercent,
        volume: typeof coinData['usd_24h_vol'] === 'number' ? coinData['usd_24h_vol'] : 0,
        market: 'CRYPTO',
        currency: 'USD',
        timestamp: Math.floor(Date.now() / 1000),
        source: this.name,
        isDelayed: false,
      };
    } catch (err) {
      logger.error(`[CoinGeckoProvider] Failed to fetch quote for ${cleanSym}: ${err}`);
      return null;
    }
  }

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const quotes: StockQuote[] = [];
    for (const sym of symbols) {
      const q = await this.getQuote(sym);
      if (q) quotes.push(q);
    }
    return quotes;
  }

  async getCandles(symbol: string, interval: string, range: string): Promise<StockCandles | null> {
    const cleanSym = symbol.toUpperCase().replace(/^\$/, '');
    const meta = CRYPTO_MAP[cleanSym];
    if (!meta) return null;

    try {
      const days = range === '1d' ? '1' : range === '7d' || range === '1w' ? '7' : '30';
      const url = `https://api.coingecko.com/api/v3/coins/${meta.id}/market_chart?vs_currency=usd&days=${days}`;
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 3000);
      if (!res.ok) return null;

      const json = (await res.json()) as { prices: Array<[number, number]>; total_volumes: Array<[number, number]> };
      const candles: CandleDataPoint[] = (json.prices || []).map(([ts, price], idx) => {
        const vol = json.total_volumes?.[idx]?.[1] ?? 0;
        return {
          time: Math.floor(ts / 1000),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: vol,
        };
      });

      return {
        symbol: cleanSym,
        interval,
        range,
        data: candles,
        source: this.name,
        isDelayed: false,
      };
    } catch (err) {
      logger.error(`[CoinGeckoProvider] Failed to fetch candles for ${cleanSym}: ${err}`);
      return null;
    }
  }

  async searchSymbols(query: string): Promise<StockSearchResult[]> {
    const cleanQ = query.toUpperCase().trim();
    const results: StockSearchResult[] = [];
    for (const [sym, meta] of Object.entries(CRYPTO_MAP)) {
      if (sym.includes(cleanQ) || meta.name.toUpperCase().includes(cleanQ)) {
        results.push({
          symbol: sym,
          name: meta.name,
          exchange: 'CRYPTO',
          type: 'crypto',
          currency: 'USD',
        });
      }
    }
    return results;
  }
}
