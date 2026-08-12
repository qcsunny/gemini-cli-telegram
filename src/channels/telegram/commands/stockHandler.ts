/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file stockHandler.ts
 * @description Telegram command handler for `/stock <symbol>` and stock details formatting.
 */

import type { Bot } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type {
  StockQuote,
  StockFinancial,
  StockBalanceSheet,
  StockCashFlow,
} from '../../../stock/types.js';
import { marketService } from '../../../stock/service/quote.js';
import { getStockMarketApiKey } from '../../../config/userConfig.js';
import {
  fetchRecentFinancials,
  fetchCompanyProfile,
  fetchRecentBalanceSheets,
  fetchRecentCashFlows,
  fetchUSDividendYield,
} from '../../../stock/provider/fmp.js';
import {
  fetchAStockFinancials,
  fetchHKFinancials,
  fetchAStockProfile,
  fetchABalanceSheets,
  fetchACashFlows,
  fetchHKBalanceSheets,
  fetchHKCashFlows,
  fetchADividendYield,
  fetchHKDividendYield,
} from '../../../stock/provider/eastmoney.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';

export function buildStockBlocks(quote: StockQuote): Array<Record<string, any>> {
  const sign = quote.change >= 0 ? '+' : '';
  const icon = quote.change >= 0 ? '📈' : '📉';
  const delayBadge = quote.isDelayed ? '(Delayed ~15m)' : '(Real-time)';

  const perf = quote.performance;
  const fmtPerf = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    const s = val >= 0 ? '+' : '';
    return `${s}${val.toFixed(2)}%`;
  };
  const fmtPrice = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    return `${quote.currency === 'CNY' ? '¥' : quote.currency === 'HKD' ? 'HK$' : '$'}${val.toFixed(2)}`;
  };
  const fmtVol = (val?: number) => {
    if (val === undefined || isNaN(val)) return '--';
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `${(val / 1e3).toFixed(2)}K`;
    return `${val}`;
  };
  const fmtCap = (val: number) => {
    if (val >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    return `${val.toFixed(0)}`;
  };

  const rec = quote.recommendations;
  const recSection = rec ? [
    { type: 'bold', text: ['🏦 华尔街/机构评级建议：'] },
    `\n• 综合评级：${rec.consensusText}` +
    `\n• 建议买入比例：${rec.buyProbability}%  (买入:${rec.buy+rec.strongBuy}家)` +
    `\n• 建议持有比例：${rec.holdProbability}%  (持有:${rec.hold}家)` +
    `\n• 建议卖出比例：${rec.sellProbability}%  (卖出:${rec.sell+rec.strongSell}家)` +
    (rec.targetPriceMean ? `\n• 机构目标均价：$${rec.targetPriceMean} (最高:$${rec.targetPriceHigh} / 最低:$${rec.targetPriceLow})\n\n` : '\n\n')
  ] : [];

  const mkCell = (label: string, value: string): Array<Record<string, any>> => [
    { text: { type: 'bold', text: [label] }, align: 'left', valign: 'middle' },
    { text: value, align: 'center', valign: 'middle' },
  ];

  const perfCells: Array<Array<Record<string, any>>> = [];
  if (perf) {
    perfCells.push(mkCell('近1个月', fmtPerf(perf.change1M)));
    perfCells.push(mkCell('近3个月', fmtPerf(perf.change3M)));
    perfCells.push(mkCell('近6个月', fmtPerf(perf.change6M)));
    perfCells.push(mkCell('近1年', fmtPerf(perf.change1Y)));
    perfCells.push(mkCell('今年以来 (YTD)', fmtPerf(perf.changeYTD)));
  }

  const quotePairs: Array<Array<Record<string, any>>> = [];
  const addRow = (label: string, value?: string) => {
    if (value !== undefined && value !== '--') quotePairs.push(mkCell(label, value));
  };
  addRow('今开', quote.open !== undefined ? fmtPrice(quote.open) : undefined);
  addRow('昨收', quote.previousClose !== undefined ? fmtPrice(quote.previousClose) : undefined);
  addRow('最高', quote.high !== undefined ? fmtPrice(quote.high) : undefined);
  addRow('最低', quote.low !== undefined ? fmtPrice(quote.low) : undefined);
  addRow('成交量', quote.volume !== undefined ? fmtVol(quote.volume) : undefined);
  addRow('日振幅', (quote.high !== undefined && quote.low !== undefined && quote.previousClose) ? `${((quote.high - quote.low) / quote.previousClose * 100).toFixed(2)}%` : undefined);
  addRow('总市值', quote.marketCap ? `$${fmtCap(quote.marketCap)}` : undefined);
  addRow('市盈率 (PE)', quote.pe !== undefined ? quote.pe.toFixed(2) : undefined);
  addRow('市净率 (PB)', quote.pb !== undefined ? quote.pb.toFixed(2) : undefined);
  addRow('换手率', quote.turnoverRate !== undefined ? `${quote.turnoverRate.toFixed(2)}%` : undefined);
  addRow('52周最高', quote.high52 && quote.low52 ? fmtPrice(quote.high52) : undefined);
  addRow('52周最低', quote.high52 && quote.low52 ? fmtPrice(quote.low52) : undefined);
  const quoteCells: Array<Array<Record<string, any>>> = [];
  for (let i = 0; i < quotePairs.length; i += 2) {
    const row: Array<Record<string, any>> = [...quotePairs[i]];
    if (quotePairs[i + 1]) row.push(...quotePairs[i + 1]);
    quoteCells.push(row);
  }

  return [
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: [`${icon} ${quote.name}`] },
        '\n\n代号：',
        { type: 'cashtag', text: [`$${quote.symbol}`], cashtag: quote.symbol },
        '\n\n',
        { type: 'bold', text: ['当前价格：'] },
        `${quote.currency === 'CNY' ? '¥' : quote.currency === 'HKD' ? 'HK$' : '$'}${quote.price.toFixed(2)}\n`,
        { type: 'bold', text: ['当日涨跌：'] },
        `${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n`,
      ]
    },
    ...(quoteCells.length ? [
      { type: 'paragraph', text: [{ type: 'bold', text: ['📋 当日行情：'] }] },
      { type: 'table', cells: quoteCells, is_bordered: true, is_striped: true },
    ] : []),
    ...(perfCells.length ? [
      { type: 'paragraph', text: [{ type: 'bold', text: ['📊 阶段涨跌表现：'] }] },
      { type: 'table', cells: perfCells, is_bordered: true, is_striped: true },
    ] : []),
    ...(recSection.length ? [{ type: 'paragraph', text: recSection }] : []),
    ...(quote.financials?.length
      ? buildFinancialBlocks(quote.financials, quote.balanceSheets, quote.cashFlows, quote.currency)
      : []),
    ...(quote.profile ? [
      {
        type: 'details',
        summary: { type: 'bold', text: ['🏢 公司简介'] },
        blocks: [{ type: 'paragraph', text: [quote.profile] }],
      },
    ] : []),
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: ['市场：'] },
        `${quote.market}\n`,
        { type: 'bold', text: ['数据时间：'] },
        `${new Date(quote.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} `,
        { type: 'italic', text: [delayBadge] },
      ]
    }
  ];
}

const fmtAmount = (val: number | undefined, currency?: string): string => {
  if (val === undefined || isNaN(val)) return '--';
  const cur = currency === 'CNY' ? '¥' : currency === 'HKD' ? '' : '$';
  if (val >= 1e9) return `${cur}${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `${cur}${(val / 1e6).toFixed(2)}M`;
  return `${cur}${val.toFixed(0)}`;
};

const fmtPct = (val?: number | null): string =>
  val === undefined || val === null || isNaN(val) ? '--' : `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;

const header = (label: string): Record<string, any> => ({
  text: { type: 'bold', text: [label] },
  is_header: true,
  align: 'center',
  valign: 'middle',
});

const cell = (value: string): Record<string, any> => ({
  text: value,
  align: 'center',
  valign: 'middle',
});

/**
 * Builds the four financial report fold blocks (业绩汇总 / 利润表 / 资产负债表 /
 * 现金流量表), one row per reported quarter, sharing period-aligned columns.
 */
export function buildFinancialBlocks(
  financials: StockFinancial[],
  balanceSheets: StockBalanceSheet[] | undefined,
  cashFlows: StockCashFlow[] | undefined,
  currency?: string,
): Array<Record<string, any>> {
  if (!financials?.length) return [];

  const blocks: Array<Record<string, any>> = [];

  const recentQuarters = financials.slice(0, 4);
  const annuals = financials.filter((f) => f.isAnnual || f.date.endsWith('-12-31')).slice(0, 5);

  const summaryFold = buildIncomeTableBlocks(recentQuarters, currency, '📊 业绩汇总（最近4个季度）', [
    ['营收', (f) => fmtAmount(f.revenue, currency)],
    ['营收同比', (f) => fmtPct(f.revenueYoY)],
    ['营收环比', (f) => fmtPct(f.revenueQoQ)],
    ['净利润', (f) => fmtAmount(f.netIncome, currency)],
    ['净利同比', (f) => fmtPct(f.netIncomeYoY)],
    ['净利环比', (f) => fmtPct(f.netIncomeQoQ)],
    ['营业利润', (f) => (f.operatingIncome !== undefined ? fmtAmount(f.operatingIncome, currency) : '--')],
    ['毛利率', (f) => fmtPct(f.grossMargin)],
    ['净利率', (f) => fmtPct(f.netMargin)],
    ['EPS', (f) => (f.epsDiluted !== undefined ? f.epsDiluted.toFixed(2) : '--')],
    ['ROE', (f) => fmtPct(f.roe)],
  ]);
  if (summaryFold) blocks.push(summaryFold);

  if (annuals.length > 0) {
    const annualSummaryFold = buildIncomeTableBlocks(annuals, currency, `📅 业绩汇总（近${annuals.length}年年度）`, [
      ['营业总收入', (f) => fmtAmount(f.revenue, currency)],
      ['营收同比', (f) => fmtPct(f.revenueYoY)],
      ['净利润', (f) => fmtAmount(f.netIncome, currency)],
      ['净利同比', (f) => fmtPct(f.netIncomeYoY)],
      ['毛利率', (f) => fmtPct(f.grossMargin)],
      ['净利率', (f) => fmtPct(f.netMargin)],
      ['EPS', (f) => (f.epsDiluted !== undefined ? f.epsDiluted.toFixed(2) : '--')],
      ['ROE', (f) => fmtPct(f.roe)],
    ]);
    if (annualSummaryFold) blocks.push(annualSummaryFold);
  }

  const incomeFold = buildIncomeTableBlocks(recentQuarters, currency, '📋 利润表（最近4个季度）', [
    ['营业总收入', (f) => fmtAmount(f.revenue, currency)],
    ['营业成本', (f) => (f.costOfRevenue !== undefined ? fmtAmount(f.costOfRevenue, currency) : '--')],
    ['毛利', (f) => (f.grossProfit !== undefined ? fmtAmount(f.grossProfit, currency) : '--')],
    ['营业费用', (f) => (f.operatingExpenses !== undefined ? fmtAmount(f.operatingExpenses, currency) : '--')],
    ['EBITDA', (f) => (f.ebitda !== undefined ? fmtAmount(f.ebitda, currency) : '--')],
    ['营业利润', (f) => (f.operatingIncome !== undefined ? fmtAmount(f.operatingIncome, currency) : '--')],
    ['营业利润率', (f) => fmtPct(f.operatingMargin)],
    ['税前利润', (f) => (f.incomeBeforeTax !== undefined ? fmtAmount(f.incomeBeforeTax, currency) : '--')],
    ['所得税', (f) => (f.incomeTaxExpense !== undefined ? fmtAmount(f.incomeTaxExpense, currency) : '--')],
    ['净利润', (f) => fmtAmount(f.netIncome, currency)],
    ['归母净利', (f) => (f.deductedNetProfit !== undefined ? fmtAmount(f.deductedNetProfit, currency) : '--')],
    ['毛利率', (f) => fmtPct(f.grossMargin)],
    ['净利率', (f) => fmtPct(f.netMargin)],
    ['EPS(摊薄)', (f) => (f.epsDiluted !== undefined ? f.epsDiluted.toFixed(2) : '--')],
  ]);
  if (incomeFold) blocks.push(incomeFold);

  if (annuals.length > 0) {
    const annualIncomeFold = buildIncomeTableBlocks(annuals, currency, `📋 利润表（近${annuals.length}年年度）`, [
      ['营业总收入', (f) => fmtAmount(f.revenue, currency)],
      ['营业成本', (f) => (f.costOfRevenue !== undefined ? fmtAmount(f.costOfRevenue, currency) : '--')],
      ['毛利', (f) => (f.grossProfit !== undefined ? fmtAmount(f.grossProfit, currency) : '--')],
      ['营业费用', (f) => (f.operatingExpenses !== undefined ? fmtAmount(f.operatingExpenses, currency) : '--')],
      ['EBITDA', (f) => (f.ebitda !== undefined ? fmtAmount(f.ebitda, currency) : '--')],
      ['营业利润', (f) => (f.operatingIncome !== undefined ? fmtAmount(f.operatingIncome, currency) : '--')],
      ['营业利润率', (f) => fmtPct(f.operatingMargin)],
      ['税前利润', (f) => (f.incomeBeforeTax !== undefined ? fmtAmount(f.incomeBeforeTax, currency) : '--')],
      ['所得税', (f) => (f.incomeTaxExpense !== undefined ? fmtAmount(f.incomeTaxExpense, currency) : '--')],
      ['净利润', (f) => fmtAmount(f.netIncome, currency)],
      ['归母净利', (f) => (f.deductedNetProfit !== undefined ? fmtAmount(f.deductedNetProfit, currency) : '--')],
      ['毛利率', (f) => fmtPct(f.grossMargin)],
      ['净利率', (f) => fmtPct(f.netMargin)],
      ['EPS(摊薄)', (f) => (f.epsDiluted !== undefined ? f.epsDiluted.toFixed(2) : '--')],
    ]);
    if (annualIncomeFold) blocks.push(annualIncomeFold);
  }

  if (balanceSheets?.length) {
    const recentBS = balanceSheets.slice(0, 4);
    const annualBS = balanceSheets.filter((b) => b.isAnnual || b.date.endsWith('-12-31')).slice(0, 5);

    const bsFold = buildBalanceSheetFold(recentBS, currency, '🏦 资产负债表（最近4个季度）');
    if (bsFold) blocks.push(bsFold);

    if (annualBS.length > 0) {
      const annualBsFold = buildBalanceSheetFold(annualBS, currency, `🏦 资产负债表（近${annualBS.length}年年度）`);
      if (annualBsFold) blocks.push(annualBsFold);
    }
  }
  if (cashFlows?.length) {
    blocks.push(buildCashFlowFold(cashFlows.slice(0, 4), currency));
  }

  return blocks;
}

function buildIncomeTableBlocks(
  financials: StockFinancial[],
  currency: string | undefined,
  summary: string,
  metrics: Array<[string, (f: StockFinancial) => string]>,
): Record<string, any> | null {
  if (!financials.length) return null;
  const rows: Array<Array<Record<string, any>>> = [
    [
      header('指标'),
      ...financials.map((f) => header(`${f.period || ''}\n${f.date}`)),
    ],
  ];
  for (const [label, fn] of metrics) {
    rows.push([header(label), ...financials.map((f) => cell(fn(f)))]);
  }

  return {
    type: 'details',
    summary: { type: 'bold', text: [summary] },
    blocks: [
      {
        type: 'table',
        cells: rows,
        is_bordered: true,
        is_striped: true,
      },
    ],
  };
}

function buildBalanceSheetFold(
  sheets: StockBalanceSheet[],
  currency?: string,
  title?: string,
): Record<string, any> | null {
  if (!sheets.length) return null;
  const rows: Array<Array<Record<string, any>>> = [
    [
      header('指标'),
      ...sheets.map((s) => header(`${s.date.slice(0, 7)}`)),
    ],
  ];
  const metrics: Array<[string, (s: StockBalanceSheet) => string]> = [
    ['总资产', (s) => fmtAmount(s.totalAssets, currency)],
    ['总负债', (s) => fmtAmount(s.totalLiabilities, currency)],
    ['净资产', (s) => fmtAmount(s.netAssets, currency)],
    ['股东权益', (s) => (s.parentEquity !== undefined ? fmtAmount(s.parentEquity, currency) : '--')],
    ['流动资产', (s) => (s.currentAssets !== undefined ? fmtAmount(s.currentAssets, currency) : '--')],
    ['流动负债', (s) => (s.currentLiabilities !== undefined ? fmtAmount(s.currentLiabilities, currency) : '--')],
    ['货币资金', (s) => (s.cash !== undefined ? fmtAmount(s.cash, currency) : '--')],
    ['存货', (s) => (s.inventory !== undefined ? fmtAmount(s.inventory, currency) : '--')],
    ['应收账款', (s) => (s.accountsReceivable !== undefined ? fmtAmount(s.accountsReceivable, currency) : '--')],
    ['商誉', (s) => (s.goodwill !== undefined ? fmtAmount(s.goodwill, currency) : '--')],
    ['短期借款', (s) => (s.shortTermDebt !== undefined ? fmtAmount(s.shortTermDebt, currency) : '--')],
    ['长期借款', (s) => (s.longTermDebt !== undefined ? fmtAmount(s.longTermDebt, currency) : '--')],
    ['资产负债率', (s) => fmtPct(s.debtRatio)],
  ];
  for (const [label, fn] of metrics) {
    rows.push([header(label), ...sheets.map((s) => cell(fn(s)))]);
  }

  return {
    type: 'details',
    summary: { type: 'bold', text: [title || `🏦 资产负债表（最近${String(sheets.length)}个季度）`] },
    blocks: [
      {
        type: 'table',
        cells: rows,
        is_bordered: true,
        is_striped: true,
      },
    ],
  };
}

function buildCashFlowFold(
  flows: StockCashFlow[],
  currency?: string,
): Record<string, any> {
  const rows: Array<Array<Record<string, any>>> = [
    [
      header('指标'),
      ...flows.map((f) => header(`${f.date.slice(0, 7)}`)),
    ],
  ];
  const metrics: Array<[string, (f: StockCashFlow) => string]> = [
    ['经营净现金流', (f) => fmtAmount(f.netCashOperating, currency)],
    ['投资净现金流', (f) => fmtAmount(f.netCashInvesting, currency)],
    ['筹资净现金流', (f) => fmtAmount(f.netCashFinancing, currency)],
    ['期末现金', (f) => fmtAmount(f.endCash, currency)],
  ];
  for (const [label, fn] of metrics) {
    rows.push([header(label), ...flows.map((f) => cell(fn(f)))]);
  }

  return {
    type: 'details',
    summary: { type: 'bold', text: [`💵 现金流量表（最近${String(flows.length)}个季度）`] },
    blocks: [
      {
        type: 'table',
        cells: rows,
        is_bordered: true,
        is_striped: true,
      },
    ],
  };
}

export async function ensureQuotePerformance(quote: StockQuote): Promise<StockQuote> {
  if (quote.performance) return quote;
  try {
    const candles = await marketService.getCandles(quote.symbol, '1d', '1y');
    if (candles && candles.data) {
      const { calculatePerformance } = await import('../../../stock/utils/performance.js');
      quote.performance = calculatePerformance(quote.price, candles.data);
      let high52 = -Infinity;
      let low52 = Infinity;
      for (const point of candles.data) {
        if (point.high > high52) high52 = point.high;
        if (point.low < low52) low52 = point.low;
      }
      if (high52 !== -Infinity) quote.high52 = high52;
      if (low52 !== Infinity) quote.low52 = low52;
    }
  } catch (err) {
    logger.warn(`[ensureQuotePerformance] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}

/**
 * Enriches a quote with recent quarterly financials, balance sheets and cash
 * flows, routing by market: A-shares/HK stocks use the free Eastmoney datacenter
 * API; US stocks use FMP when an API key is configured. No-op when data already
 * present.
 */
export async function ensureQuoteFinancials(quote: StockQuote): Promise<StockQuote> {
  if (quote.financials) return quote;
  try {
    let financials: StockFinancial[] | null = null;
    let balanceSheets: StockBalanceSheet[] | null = null;
    let cashFlows: StockCashFlow[] | null = null;
    if (quote.market === 'SSE' || quote.market === 'SZSE') {
      financials = await fetchAStockFinancials(quote.symbol);
      balanceSheets = await fetchABalanceSheets(quote.symbol);
      cashFlows = await fetchACashFlows(quote.symbol);
    } else if (quote.market === 'HKEX') {
      financials = await fetchHKFinancials(quote.symbol);
      balanceSheets = await fetchHKBalanceSheets(quote.symbol);
      cashFlows = await fetchHKCashFlows(quote.symbol);
    } else {
      const apiKey = getStockMarketApiKey();
      if (!apiKey) return quote;
      financials = await fetchRecentFinancials(quote.symbol, apiKey);
      balanceSheets = await fetchRecentBalanceSheets(quote.symbol, apiKey);
      cashFlows = await fetchRecentCashFlows(quote.symbol, apiKey);
    }
    if (financials && financials.length) quote.financials = financials;
    if (balanceSheets && balanceSheets.length) quote.balanceSheets = balanceSheets;
    if (cashFlows && cashFlows.length) quote.cashFlows = cashFlows;
    const bsByDate = new Map<string, StockBalanceSheet>();
    for (const bs of quote.balanceSheets ?? []) bsByDate.set(bs.date, bs);
    for (const f of quote.financials ?? []) {
      if (f.roe === undefined || f.roe === null) {
        const eq = bsByDate.get(f.date)?.parentEquity;
        if (eq && f.netIncome) f.roe = (f.netIncome / eq) * 100;
      }
      if ((f.netMargin === undefined || f.netMargin === null) && f.netIncome && f.revenue) {
        f.netMargin = (f.netIncome / f.revenue) * 100;
      }
      if ((f.operatingMargin === undefined || f.operatingMargin === null) && f.operatingIncome && f.revenue) {
        f.operatingMargin = (f.operatingIncome / f.revenue) * 100;
      }
    }
  } catch (err) {
    logger.warn(`[ensureQuoteFinancials] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}

/**
 * Enriches a quote with a company main-business description, routing by market:
 * A-shares use the free Eastmoney F10 CompanySurvey API; HK/US stocks use FMP
 * profile when an API key is configured. No-op when data already present.
 */
export async function ensureQuoteProfile(quote: StockQuote): Promise<StockQuote> {
  if (quote.profile) return quote;
  try {
    let profile: string | null = null;
    if (quote.market === 'SSE' || quote.market === 'SZSE') {
      profile = await fetchAStockProfile(quote.symbol);
    } else {
      const apiKey = getStockMarketApiKey();
      if (apiKey) profile = await fetchCompanyProfile(quote.symbol, apiKey);
    }
    if (profile) quote.profile = profile;
  } catch (err) {
    logger.warn(`[ensureQuoteProfile] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}

export function registerStockHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('stock', async (ctx) => {
    const rawArgs = ctx.match;
    const symbol = typeof rawArgs === 'string' ? rawArgs.trim().replace(/^\$/, '') : '';

    if (!symbol) {
      await ctx.reply(
        `${ICONS.info} <b>Stock Quote Usage:</b>\n\n<code>/stock NVDA</code>\n<code>/stock 600519</code>\n<code>/stock 00700</code>\n<code>/stock BTC</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      const quote = await marketService.getQuote(symbol);
      if (!quote) {
        await ctx.reply(`${ICONS.warning} ⚠️ <b>Symbol not found:</b> ${symbol}\n\nPlease check the symbol and try again.`);
        return;
      }

      await ensureQuotePerformance(quote);
      await ensureQuoteFinancials(quote);
      await ensureQuoteProfile(quote);

      const blocksPayload = buildStockBlocks(quote);

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const detailUrl = `https://www.tradingview.com/symbols/${tvSymbol.replace(':', '-')}/`;
      const chartUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await ctx.api.sendRichMessage(ctx.chat.id, { blocks: blocksPayload as any }, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', url: detailUrl },
              { text: '📈 K线图', url: chartUrl }
            ]
          ]
        }
      });
    } catch (err) {
      logger.error(`Failed to handle /stock command for ${symbol}: ${err}`);
      await ctx.reply(`${ICONS.error} <b>Error fetching market quote for ${symbol}</b>`);
    }
  });
}

/**
 * Enriches a quote with the latest annual dividend yield (percentage), routed by
 * market: A-shares via Eastmoney RPT_SHAREBONUS_DET, HK via RPT_HKF10_FN_MAININDICATOR,
 * US via FMP /stable/dividends. No-op when already present.
 */
export async function ensureQuoteDividendYield(quote: StockQuote): Promise<StockQuote> {
  if (quote.dividendYield !== undefined && quote.dividendYield !== null) return quote;
  try {
    let yieldPct: number | null = null;
    if (quote.market === 'SSE' || quote.market === 'SZSE') {
      yieldPct = await fetchADividendYield(quote.symbol, quote.price);
    } else if (quote.market === 'HKEX') {
      yieldPct = await fetchHKDividendYield(quote.symbol);
    } else {
      const apiKey = getStockMarketApiKey();
      if (!apiKey) return quote;
      yieldPct = await fetchUSDividendYield(quote.symbol, apiKey);
    }
    if (yieldPct !== null && yieldPct > 0) quote.dividendYield = yieldPct;
  } catch (err) {
    logger.warn(`[ensureQuoteDividendYield] failed for ${quote.symbol}: ${err}`);
  }
  return quote;
}
