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
  dividendYield?: number; // Annual dividend yield in percentage
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
  /** Real FMP analyst rating & price-target consensus (absent when FMP key unset or symbol not covered). */
  recommendations?: {
    rating: string;
    ratingScore: number;
    consensusText: string;
    targetPriceMean?: number;
    targetPriceMedian?: number;
    targetPriceHigh?: number;
    targetPriceLow?: number;
    scores?: {
      dcf?: number;
      roe?: number;
      roa?: number;
      debtEquity?: number;
      pe?: number;
      pb?: number;
    };
  };
  /** Recent quarterly financial statements (income statement), newest first. Filled when a stock market API key is configured. */
  financials?: StockFinancial[];
  /** Recent quarterly balance sheets, newest first. Filled alongside financials when available. */
  balanceSheets?: StockBalanceSheet[];
  /** Recent quarterly cash-flow statements, newest first. Filled alongside financials when available. */
  cashFlows?: StockCashFlow[];
  fmpRateLimited?: boolean;
  /** Company main-business description (主营业务简介). Optional, shown when available. */
  profile?: string;
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
  /** Net income in reported currency (undefined when the source omits it). */
  netIncome?: number;
  /** Diluted earnings per share. */
  epsDiluted?: number;
  /** Revenue YoY growth in percent (null when unavailable). */
  revenueYoY?: number | null;
  /** Revenue QoQ growth in percent (null when unavailable). */
  revenueQoQ?: number | null;
  /** Net income YoY growth in percent (null when unavailable). */
  netIncomeYoY?: number | null;
  /** Net income QoQ growth in percent (null when unavailable). */
  netIncomeQoQ?: number | null;
  /** Gross margin in percent (null when unavailable). */
  grossMargin?: number | null;
  /** Net margin in percent (null when unavailable). */
  netMargin?: number | null;
  /** Weighted return on equity in percent (null when unavailable). */
  roe?: number | null;
  /** Earnings per share (basic), distinct from diluted eps. */
  eps?: number | null;
  /** Cost of revenue in reported currency (营业成本). */
  costOfRevenue?: number;
  /** EBITDA in reported currency. */
  ebitda?: number;
  /** Total operating expenses in reported currency (营业费用). */
  operatingExpenses?: number;
  /** Income before tax in reported currency (税前利润). */
  incomeBeforeTax?: number;
  /** Income tax expense in reported currency (所得税). */
  incomeTaxExpense?: number;
  /** Net profit excluding non-recurring items (扣非净利润). */
  deductedNetProfit?: number;
  /** Book value per share (每股净资产). */
  bps?: number | null;
  /** Operating margin in percent (营业利润率 = operatingIncome / revenue). */
  operatingMargin?: number | null;
  /** Reported currency code (e.g. 'USD'). */
  currency?: string;
  /** True when report is annual (12-31 / FY). */
  isAnnual?: boolean;
}

/**
 * A single period's balance-sheet (资产负债表) data. Amounts in reported
 * currency; null/absent fields mean the provider did not report them.
 */
export interface StockBalanceSheet {
  /** Report date (e.g. '2026-03-31'). */
  date: string;
  /** Total assets (总资产). */
  totalAssets: number;
  /** Total liabilities (总负债). */
  totalLiabilities: number;
  /** Net assets (净资产 = totalAssets - totalLiabilities). */
  netAssets: number;
  /** Equity attributable to parent shareholders (归母权益). */
  parentEquity?: number;
  /** Total current assets (流动资产合计). */
  currentAssets?: number;
  /** Total current liabilities (流动负债合计). */
  currentLiabilities?: number;
  /** Cash and cash equivalents (货币资金/现金及等价物). */
  cash?: number;
  /** Inventory (存货). */
  inventory?: number;
  /** Accounts receivable (应收账款). */
  accountsReceivable?: number;
  /** Goodwill (商誉). */
  goodwill?: number;
  /** Short-term debt (短期借款). */
  shortTermDebt?: number;
  /** Long-term debt (长期借款). */
  longTermDebt?: number;
  /** Debt-to-asset ratio in percent (资产负债率 = totalLiabilities / totalAssets). */
  debtRatio?: number | null;
  /** Reported currency code (e.g. 'CNY'). */
  currency?: string;
  /** True when report is annual (12-31 / FY). */
  isAnnual?: boolean;
}

/**
 * A single period's cash-flow statement (现金流量表) data. Amounts in reported
 * currency; null/absent fields mean the provider did not report them.
 */
export interface StockCashFlow {
  /** Report date (e.g. '2026-03-31'). */
  date: string;
  /** Net cash from operating activities (经营活动现金流量净额). */
  netCashOperating: number;
  /** Net cash from investing activities (投资活动现金流量净额). */
  netCashInvesting: number;
  /** Net cash from financing activities (筹资活动现金流量净额). */
  netCashFinancing: number;
  /** Cash and cash equivalents at period end (期末现金). */
  endCash: number;
  /** Reported currency code (e.g. 'CNY'). */
  currency?: string;
  /** True when report is annual (12-31 / FY). */
  isAnnual?: boolean;
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
