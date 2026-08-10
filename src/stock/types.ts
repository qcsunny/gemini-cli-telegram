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
  high52?: number;
  low52?: number;
  marketCap?: number; // Total market capitalization in USD (US stocks via Eastmoney)
  pe?: number; // Price-to-earnings ratio (TTM)
  pb?: number; // Price-to-book ratio
  turnoverRate?: number; // Percentage
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
  /** Recent quarterly financial statements (income statement), newest first. Filled when a stock market API key is configured. */
  financials?: StockFinancial[];
}

/** A single period's income statement data from the stock market data provider. */
export interface StockFinancial {
  /** Report date (e.g. '2026-04-26'). */
  date: string;
  /** Filing date (e.g. '2026-05-20'). */
  filingDate?: string;
  /** Fiscal year and period (e.g. '2027 Q1'). */
  period: string;
  /** Total revenue in reported currency. */
  revenue: number;
  /** Gross profit in reported currency. */
  grossProfit?: number;
  /** Operating income in reported currency. */
  operatingIncome?: number;
  /** Net income in reported currency. */
  netIncome: number;
  /** Diluted earnings per share. */
  epsDiluted?: number;
  /** Reported currency code (e.g. 'USD'). */
  currency?: string;
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
