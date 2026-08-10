/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file types.ts
 * @description Standardized data models for Stock & Market Data Providers,
 * decoupled from any specific external market data vendor.
 */

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  volume?: number;
  market: string;
  currency: string;
  timestamp: number;
  source: string;
  isDelayed: boolean;
  performance?: {
    change1M?: number; // 1 month percentage change
    change3M?: number; // 3 months percentage change
    change6M?: number; // 6 months percentage change
    change1Y?: number; // 1 year percentage change
    changeYTD?: number; // Year-to-date (今年以来) percentage change
  };
  recommendations?: {
    consensus: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
    consensusText: string;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    buyProbability: number;
    holdProbability: number;
    sellProbability: number;
    targetPriceMean?: number;
    targetPriceHigh?: number;
    targetPriceLow?: number;
  };
}

export interface CandleDataPoint {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockCandles {
  symbol: string;
  interval: string;
  range: string;
  data: CandleDataPoint[];
  source: string;
  isDelayed: boolean;
}

export interface StockSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  currency: string;
}

export interface MarketDataProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<StockQuote | null>;
  getQuotes(symbols: string[]): Promise<StockQuote[]>;
  getCandles(symbol: string, interval: string, range: string): Promise<StockCandles | null>;
  searchSymbols(query: string): Promise<StockSearchResult[]>;
}
