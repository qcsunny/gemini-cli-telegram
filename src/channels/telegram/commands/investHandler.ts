/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investHandler.ts
 * @description Telegram command handler for `/invest <symbol>` — a one-command
 * value-investing analysis that scores a stock across six dimensions
 * (profitability, growth, financial health, cash-flow quality, valuation,
 * shareholder yield), flags red flags, and optionally asks the model for a
 * deep investment report.
 *
 * Scoring framework mirrors Graham (safety margin), Buffett (moat/ROE/cash
 * flow), Greenblatt (Magic Formula), Damodaran (growth) and Peter Lynch (PEG).
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
import { getDefaultModel, loadUserConfig } from '../../../config/userConfig.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

import {
  ensureQuotePerformance,
  ensureQuoteFinancials,
  ensureQuoteProfile,
  ensureQuoteDividendYield,
  buildFinancialBlocks,
} from './stockHandler.js';
import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';
import { getFundDataset, type FundDataset } from '../../../stock/provider/fund.js';
import { analyzeFund, type FundAnalysisResult } from '../../../stock/analyzer/fundAnalyzer.js';

// ── Dimension types ──

export interface InvestDimension {
  id: string;
  name: string;
  score: number; // 0-100
  weight: number; // 0-1
  notes: string[];
}

export interface InvestResult {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  price: number;
  dimensions: InvestDimension[];
  totalScore: number; // 0-100 weighted
  grade: string; // A+ .. D
  rating: string; // Chinese rating
  summary: string;
  redFlags: string[];
}

// ── Helpers ──

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function latest<T>(arr: T[] | undefined): T | undefined {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function fmtAmount(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  return `${sign}${abs.toFixed(0)}`;
}

function annualizeGrowth(qoQList: (number | null | undefined)[]): number | null {
  const nums = qoQList.filter(isNum);
  if (nums.length === 0) return null;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.pow(1 + avg / 100, 4) - 1;
}

// ── 1. 盈利能力 (weight 25%) ──

function scoreProfitability(fs: StockFinancial[]): InvestDimension {
  const notes: string[] = [];
  let points = 0;

  const cur = latest(fs);
  const roe = cur?.roe;
  const netMargin = cur?.netMargin;
  const grossMargin = cur?.grossMargin;
  const operatingMargin = cur?.operatingMargin;

  if (!isNum(roe)) {
    notes.push('ROE 数据缺失（港股/A股季度报表可能不含加权ROE）');
    points += 25;
  } else if (roe >= 20) {
    notes.push(`ROE ${roe.toFixed(1)}%，优秀（≥20%，巴菲特标准）`);
    points += 50;
  } else if (roe >= 15) {
    notes.push(`ROE ${roe.toFixed(1)}%，良好（15-20%）`);
    points += 42;
  } else if (roe >= 10) {
    notes.push(`ROE ${roe.toFixed(1)}%，一般（10-15%）`);
    points += 30;
  } else if (roe >= 0) {
    notes.push(`ROE ${roe.toFixed(1)}%，偏低（<10%）`);
    points += 15;
  } else {
    notes.push(`ROE ${roe.toFixed(1)}%，为负，严重警告`);
    points += 0;
  }

  if (isNum(netMargin)) {
    if (netMargin >= 20) {
      notes.push(`净利率 ${netMargin.toFixed(1)}%，优秀（≥20%）`);
      points += 25;
    } else if (netMargin >= 10) {
      notes.push(`净利率 ${netMargin.toFixed(1)}%，良好`);
      points += 20;
    } else if (netMargin >= 5) {
      notes.push(`净利率 ${netMargin.toFixed(1)}%，一般`);
      points += 12;
    } else if (netMargin >= 0) {
      notes.push(`净利率 ${netMargin.toFixed(1)}%，偏薄`);
      points += 6;
    } else {
      notes.push(`净利率 ${netMargin.toFixed(1)}%，亏损`);
      points += 0;
    }
  } else {
    points += 15;
    notes.push('净利率数据缺失');
  }

  if (isNum(grossMargin)) {
    if (grossMargin >= 40) points += 25;
    else if (grossMargin >= 25) points += 20;
    else if (grossMargin >= 15) points += 13;
    else points += 5;
    notes.push(`毛利率 ${grossMargin.toFixed(1)}%`);
  } else if (isNum(operatingMargin)) {
    points += operatingMargin >= 15 ? 25 : operatingMargin >= 8 ? 18 : operatingMargin >= 0 ? 8 : 0;
    notes.push(`营业利润率 ${operatingMargin.toFixed(1)}%（毛利率缺失）`);
  } else {
    points += 15;
    notes.push('毛利率/营业利润率数据缺失');
  }

  // Stability: ROE fluctuation over recent periods
  const roes = fs.slice(0, 4).map((f) => f.roe).filter(isNum);
  if (roes.length >= 2) {
    const min = Math.min(...roes);
    const max = Math.max(...roes);
    if (max - min <= 3) {
      notes.push(`ROE 稳定（近${roes.length}期波动 <3pp）`);
      points += 0;
    } else if (max - min <= 8) {
      notes.push(`ROE 波动适中（近${roes.length}期 ${min.toFixed(1)}%~${max.toFixed(1)}%）`);
      points -= 5;
    } else {
      notes.push(`ROE 波动大（近${roes.length}期 ${min.toFixed(1)}%~${max.toFixed(1)}%）`);
      points -= 12;
    }
  }

  return { id: 'profitability', name: '盈利能力', score: clamp(points), weight: 0.25, notes };
}

// ── 2. 成长性 (weight 15%) ──

function scoreGrowth(fs: StockFinancial[]): InvestDimension {
  const notes: string[] = [];
  let points = 0;

  const cur = latest(fs);
  const revYoY = cur?.revenueYoY;
  const niYoY = cur?.netIncomeYoY;
  let gotYoY = false;

  if (isNum(revYoY)) {
    gotYoY = true;
    notes.push(`最新一期营收同比 ${revYoY > 0 ? '+' : ''}${revYoY.toFixed(1)}%`);
    if (revYoY >= 30) points += 35;
    else if (revYoY >= 15) points += 30;
    else if (revYoY >= 5) points += 22;
    else if (revYoY >= 0) points += 12;
    else points += 0;
  }

  if (isNum(niYoY)) {
    gotYoY = true;
    notes.push(`最新一期净利同比 ${niYoY > 0 ? '+' : ''}${niYoY.toFixed(1)}%`);
    if (niYoY >= 30) points += 30;
    else if (niYoY >= 15) points += 25;
    else if (niYoY >= 5) points += 18;
    else if (niYoY >= 0) points += 10;
    else points += 0;
  }

  if (!gotYoY) {
    notes.push('缺少同比增速数据，改用近几期营收环比推算');
    const qoQs = fs
      .slice(0, 5)
      .map((f, i) => {
        const next = fs[i + 1];
        if (i >= fs.length - 1 || !f.revenue || !next?.revenue) return null;
        return ((f.revenue - next.revenue) / next.revenue) * 100;
      })
      .filter(isNum);
    const annualized = annualizeGrowth(qoQs);
    if (annualized !== null) {
      notes.push(`推算年化营收增速 ${annualized > 0 ? '+' : ''}${annualized.toFixed(1)}%`);
      if (annualized >= 20) points += 45;
      else if (annualized >= 10) points += 35;
      else if (annualized >= 5) points += 25;
      else if (annualized >= 0) points += 12;
      else points += 0;
    } else {
      notes.push('数据不足，成长性无法评估');
      points += 30;
    }
  }

  // Consistency: revenue growth across recent 4 periods
  const revs = fs.slice(0, 4).map((f) => f.revenue).filter(isNum);
  if (revs.length >= 3) {
    let up = 0;
    for (let i = 0; i < revs.length - 1; i++) {
      if ((revs[i] as number) >= (revs[i + 1] as number)) up++;
    }
    if (up === revs.length - 1) {
      notes.push('近几期营收连续增长');
      points += 15;
    } else if (up >= (revs.length - 1) / 2) {
      notes.push('营收增长总体向上，有波动');
      points += 8;
    } else {
      notes.push('营收增长不一致');
      points -= 5;
    }
  } else {
    points += 10;
  }

  return { id: 'growth', name: '成长性', score: clamp(points), weight: 0.15, notes };
}

// ── 3. 财务健康 (weight 15%) ──

function scoreFinancialHealth(bs: StockBalanceSheet[], cf: StockCashFlow[]): InvestDimension {
  const notes: string[] = [];
  let points = 0;

  const cur = latest(bs);
  const debtRatio = cur?.debtRatio;
  const cash = cur?.cash;
  const currentAssets = cur?.currentAssets;
  const currentLiabilities = cur?.currentLiabilities;
  const sd = cur?.shortTermDebt;
  const ld = cur?.longTermDebt;
  const hasDebtData = isNum(sd) || isNum(ld);
  const totalDebt = hasDebtData ? (sd ?? 0) + (ld ?? 0) : null;
  const cashTotal = cash ?? 0;
  const currentRatio =
    isNum(currentAssets) && isNum(currentLiabilities) && currentLiabilities !== 0
      ? currentAssets / currentLiabilities
      : null;

  if (isNum(debtRatio)) {
    notes.push(`资产负债率 ${debtRatio.toFixed(1)}%`);
    if (debtRatio <= 30) points += 45;
    else if (debtRatio <= 50) points += 38;
    else if (debtRatio <= 65) points += 25;
    else if (debtRatio <= 80) points += 12;
    else {
      points += 0;
      notes.push('高杠杆，注意偿债风险');
    }
  } else {
    points += 25;
    notes.push('资产负债率数据缺失');
  }

  if (isNum(currentRatio)) {
    notes.push(`流动比率 ${currentRatio.toFixed(2)}`);
    if (currentRatio >= 2) points += 30;
    else if (currentRatio >= 1.5) points += 26;
    else if (currentRatio >= 1) points += 18;
    else points += 5;
  } else {
    points += 20;
    notes.push('流动比率数据缺失');
  }

  // Net cash: cash vs total debt
  if (isNum(totalDebt) && cashTotal > 0 && totalDebt > 0) {
    const coverage = cashTotal / totalDebt;
    if (coverage >= 1.5) {
      notes.push('净现金充裕（现金/有息负债 >1.5x）');
      points += 20;
    } else if (coverage >= 0.8) {
      notes.push('现金可覆盖大部分有息负债');
      points += 13;
    } else {
      notes.push('有息负债高于现金');
      points += 5;
    }
  } else if (totalDebt === 0) {
    notes.push('几乎无有息负债');
    points += 25;
  } else if (totalDebt === null) {
    notes.push('有息负债数据缺失');
    points += 10;
  } else {
    points += 10;
  }

  void cf;
  return { id: 'financialHealth', name: '财务健康', score: clamp(points), weight: 0.15, notes };
}

// ── 4. 现金流质量 (weight 20%) ──

function scoreCashFlow(cf: StockCashFlow[], fs: StockFinancial[]): InvestDimension {
  const notes: string[] = [];
  let points = 0;

  const cur = latest(cf);
  const ocf = cur?.netCashOperating;
  const investing = cur?.netCashInvesting;

  if (isNum(ocf)) {
    if (ocf > 0) {
      notes.push(`经营现金流 ${fmtAmount(ocf)}，为正`);
      points += 35;
    } else {
      notes.push('经营现金流为负，盈利能力存疑');
      points += 0;
    }
  } else {
    points += 20;
    notes.push('经营现金流数据缺失');
  }

  // 净现比 OCF/NI
  const curFs = latest(fs);
  const ni = curFs?.netIncome;
  if (isNum(ocf) && isNum(ni) && ni > 0) {
    const ratio = ocf / ni;
    notes.push(`净现比 ${ratio.toFixed(2)}`);
    if (ratio >= 1) points += 40;
    else if (ratio >= 0.7) points += 30;
    else if (ratio >= 0.4) points += 18;
    else {
      points += 5;
      notes.push('利润含金量低（净现比 <0.4）');
    }
  } else {
    points += 25;
  }

  // FCF ≈ OCF + investing (investing is negative capex)
  const fcf = isNum(ocf) && isNum(investing) ? ocf + investing : null;
  if (fcf !== null && isNum(fcf)) {
    if (fcf > 0) {
      notes.push(`自由现金流 ${fmtAmount(fcf)}，为正`);
      points += 25;
    } else {
      notes.push(`自由现金流 ${fmtAmount(fcf)}，为负（资本开支过大）`);
      points += 5;
    }
  } else {
    points += 15;
    notes.push('自由现金流数据缺失');
  }

  return { id: 'cashFlow', name: '现金流质量', score: clamp(points), weight: 0.2, notes };
}

// ── 5. 估值吸引力 (weight 20%) ──

function scoreValuation(quote: StockQuote): InvestDimension {
  const notes: string[] = [];
  let points = 0;
  const pe = quote.pe;
  const pb = quote.pb;

  // PEG: PE / earnings growth
  const curFs = latest(quote.financials);
  const growth = curFs?.netIncomeYoY ?? curFs?.revenueYoY;
  let peg: number | null = null;
  if (isNum(pe) && pe > 0 && isNum(growth) && growth > 0) {
    peg = pe / growth;
    notes.push(`PEG ≈ ${peg.toFixed(2)}（PE ${pe.toFixed(1)} / 净利增速 ${growth.toFixed(1)}）`);
  }

  if (isNum(pe) && pe > 0) {
    notes.push(`PE(TTM) ${pe.toFixed(1)}`);
    if (peg !== null && peg <= 1) {
      points += 70;
      notes.push('PEG ≤1，估值合理偏低');
    } else if (pe <= 10) points += 55;
    else if (pe <= 20) points += 45;
    else if (pe <= 30) points += 32;
    else if (pe <= 50) points += 20;
    else {
      points += 8;
      notes.push('PE 偏高');
    }
  } else if (isNum(pe) && pe < 0) {
    notes.push('PE 为负（亏损）');
    points += 5;
  } else {
    points += 30;
    notes.push('PE 数据缺失');
  }

  if (isNum(pb) && pb > 0) {
    if (pb <= 1.5) points += 25;
    else if (pb <= 3) points += 20;
    else if (pb <= 6) points += 12;
    else points += 5;
    notes.push(`PB ${pb.toFixed(2)}`);
  } else {
    points += 15;
  }

  // 52-week relative position
  const high52 = quote.high52;
  const low52 = quote.low52;
  if (isNum(high52) && isNum(low52) && high52 > 0 && low52 > 0 && low52 < high52) {
    const pos = ((quote.price - low52) / (high52 - low52)) * 100;
    notes.push(`52周区间位置 ${pos.toFixed(0)}%（低 ${low52.toFixed(2)} / 高 ${high52.toFixed(2)}）`);
    if (pos <= 20) points += 15;
    else if (pos <= 45) points += 10;
    else if (pos <= 70) points += 5;
    else points += 0;
  } else {
    points += 8;
  }

  return { id: 'valuation', name: '估值吸引力', score: clamp(points), weight: 0.2, notes };
}

// ── 6. 股东回报 (weight 5%) ──

function scoreShareholderYield(quote: StockQuote): InvestDimension {
  const notes: string[] = [];
  let points = 0;
  const dy = quote.dividendYield;

  if (dy === undefined || dy === null || !isNum(dy)) {
    notes.push('股息率数据缺失（当前数据源未提供）');
    points += 40;
  } else if (dy >= 4) {
    notes.push(`股息率 ${dy.toFixed(2)}%，高分红、回报突出`);
    points += 100;
  } else if (dy >= 2.5) {
    notes.push(`股息率 ${dy.toFixed(2)}%，分红较稳定，回报良好`);
    points += 80;
  } else if (dy >= 1) {
    notes.push(`股息率 ${dy.toFixed(2)}%，有分红但吸引力一般`);
    points += 55;
  } else if (dy > 0) {
    notes.push(`股息率 ${dy.toFixed(2)}%，分红较低，成长型公司常见`);
    points += 30;
  } else {
    notes.push('当前无现金分红');
    points += 10;
  }
  return { id: 'shareholderYield', name: '股东回报', score: clamp(points), weight: 0.05, notes };
}

// ── Summary ──

function grade(total: number): { grade: string; rating: string } {
  if (total >= 85) return { grade: 'A+', rating: '强烈看多' };
  if (total >= 75) return { grade: 'A', rating: '看多' };
  if (total >= 65) return { grade: 'A-', rating: '谨慎看多' };
  if (total >= 55) return { grade: 'B+', rating: '中性偏多' };
  if (total >= 45) return { grade: 'B', rating: '中性' };
  if (total >= 35) return { grade: 'B-', rating: '中性偏空' };
  if (total >= 25) return { grade: 'C', rating: '看空' };
  return { grade: 'D', rating: '强烈看空' };
}

export function analyzeInvest(quote: StockQuote): InvestResult {
  const fs = quote.financials ?? [];
  const bs = quote.balanceSheets ?? [];
  const cf = quote.cashFlows ?? [];

  const dims = [
    scoreProfitability(fs),
    scoreGrowth(fs),
    scoreFinancialHealth(bs, cf),
    scoreCashFlow(cf, fs),
    scoreValuation(quote),
    scoreShareholderYield(quote),
  ];
  const total = dims.reduce((acc, d) => acc + d.score * d.weight, 0);
  const { grade: g, rating } = grade(total);

  // Red flags
  const redFlags: string[] = [];
  const curFs = latest(fs);
  if (curFs && isNum(curFs.netIncome) && curFs.netIncome < 0) redFlags.push('最近一期亏损');
  const bsCur = latest(bs);
  if (bsCur && isNum(bsCur.debtRatio) && bsCur.debtRatio > 80)
    redFlags.push(`资产负债率 ${bsCur.debtRatio.toFixed(1)}% 过高`);
  const cfCur = latest(cf);
  if (cfCur && isNum(cfCur.netCashOperating) && cfCur.netCashOperating < 0)
    redFlags.push('经营现金流为负');
  if (isNum(quote.pe) && quote.pe > 100) redFlags.push('PE 过高，估值透支');

  const summary = `${quote.name}（${quote.symbol}）综合评分 ${total.toFixed(1)}/100（${g}），评级「${rating}」。`;

  return {
    symbol: quote.symbol,
    name: quote.name,
    market: quote.market,
    currency: quote.currency,
    price: quote.price,
    dimensions: dims,
    totalScore: total,
    grade: g,
    rating,
    summary,
    redFlags,
  };
}

// ── Rich-message rendering ──

export function buildInvestBlocks(result: InvestResult): Array<Record<string, any>> {
  const blocks: Array<Record<string, any>> = [
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: [`⚖️ 价值投资分析 · ${result.name}（${result.symbol}）`] },
        `\n\n${result.summary}`,
        result.redFlags.length ? `\n\n⚠️ ${result.redFlags.join('；')}` : '',
      ],
    },
  ];

  // Dimension table
  const dimRows: Array<Array<Record<string, any>>> = [];
  const mkCell = (label: string, value: string): Array<Record<string, any>> => [
    { text: { type: 'bold', text: [label] }, align: 'left', valign: 'middle' },
    { text: value, align: 'center', valign: 'middle' },
  ];
  for (const d of result.dimensions) {
    const bar = '▰'.repeat(Math.round(d.score / 10)) + '▱'.repeat(10 - Math.round(d.score / 10));
    dimRows.push(mkCell(`${d.name}`, `${d.score}/100 ${bar}`));
  }
  dimRows.push(mkCell('综合评分', `${result.totalScore.toFixed(1)}/100（${result.grade}）`));
  blocks.push({ type: 'table', cells: dimRows, is_bordered: true, is_striped: true });

  // Dimension notes
  for (const d of result.dimensions) {
    blocks.push({
      type: 'details',
      summary: { type: 'bold', text: [`📊 ${d.name}（${d.score}/100）`] },
      blocks: [{ type: 'paragraph', text: d.notes.map((n) => `• ${n}`).join('\n') }],
    });
  }

  return blocks;
}

function buildDeepReportPrompt(result: InvestResult, quote: StockQuote): string {
  const fs = quote.financials?.[0];
  const bs = quote.balanceSheets?.[0];
  const cf = quote.cashFlows?.[0];
  const dimDetails = result.dimensions
    .map((d) => `- ${d.name} ${d.score}/100：${d.notes.join('；')}`)
    .join('\n');

  const pick = (v: unknown, label: string): string | null =>
    v === undefined || v === null || (typeof v === 'number' && !isFinite(v))
      ? null
      : `${label} ${v}`;
  const fsParts = [
    pick(fs?.revenue, '营收'),
    pick(fs?.costOfRevenue, '营业成本'),
    pick(fs?.grossProfit, '毛利'),
    pick(fs?.operatingIncome, '营业利润'),
    pick(fs?.incomeBeforeTax, '税前利润'),
    pick(fs?.incomeTaxExpense, '所得税'),
    pick(fs?.netIncome, '净利'),
    pick(fs?.grossMargin, '毛利率'),
    pick(fs?.netMargin, '净利率'),
    pick(fs?.operatingMargin, '营业利润率'),
    pick(fs?.roe, 'ROE'),
    pick(fs?.epsDiluted, 'EPS'),
    pick(fs?.bps, '每股净资产'),
    pick(fs?.revenueYoY, '营收同比'),
    pick(fs?.netIncomeYoY, '净利同比'),
  ].filter(Boolean);
  const bsParts = [
    pick(bs?.totalAssets, '总资产'),
    pick(bs?.totalLiabilities, '总负债'),
    pick(bs?.netAssets, '净资产'),
    pick(bs?.parentEquity, '股东权益'),
    pick(bs?.currentAssets, '流动资产'),
    pick(bs?.currentLiabilities, '流动负债'),
    pick(bs?.cash, '货币资金'),
    pick(bs?.inventory, '存货'),
    pick(bs?.accountsReceivable, '应收账款'),
    pick(bs?.goodwill, '商誉'),
    pick(bs?.shortTermDebt, '短期借款'),
    pick(bs?.longTermDebt, '长期借款'),
    pick(bs?.debtRatio, '资产负债率'),
  ].filter(Boolean);
  const cfParts = [
    pick(cf?.netCashOperating, '经营现金流'),
    pick(cf?.netCashInvesting, '投资现金流'),
    pick(cf?.netCashFinancing, '筹资现金流'),
    pick(cf?.endCash, '期末现金'),
  ].filter(Boolean);
  const quoteParts = [
    pick(quote.price, '当前价'),
    pick(quote.pe, 'PE'),
    pick(quote.pb, 'PB'),
    pick(quote.marketCap, '总市值'),
    pick(quote.high52, '52周最高'),
    pick(quote.low52, '52周最低'),
  ].filter(Boolean);

  const annuals = (quote.financials ?? []).filter((f) => f.isAnnual || f.date.endsWith('-12-31')).slice(0, 5);
  const annualSummary = annuals.length
    ? annuals
        .map(
          (a) =>
            `- ${a.date} (${a.period})：营收 ${fmtAmount(a.revenue)} | 净利 ${fmtAmount(a.netIncome)} | 毛利率 ${a.grossMargin != null ? a.grossMargin.toFixed(1) + '%' : '--'} | ROE ${a.roe != null ? a.roe.toFixed(1) + '%' : '--'}`
        )
        .join('\n')
    : '无（请主动联网搜寻补齐近 5 年年报数据）';

  return [
    `请对股票 ${quote.name}（${quote.symbol}，市场 ${quote.market}）做一份专业的价值投资深度分析报告。`,
    '',
    '## 已计算的六维度量化评分',
    dimDetails,
    `综合评分 ${result.totalScore.toFixed(1)}/100，评级「${result.rating}」（${result.grade}）。`,
    result.redFlags.length ? `红旗警示：${result.redFlags.join('；')}` : '',
    '',
    '## 最新一期财务数据',
    fsParts.length ? fsParts.join('，') : '无',
    bsParts.length ? bsParts.join('，') : '',
    cfParts.length ? cfParts.join('，') : '',
    quoteParts.length ? quoteParts.join('，') : '',
    quote.profile ? `公司简介：${quote.profile.slice(0, 500)}` : '',
    quote.fmpRateLimited ? `\n⚠️ 【数据提醒】美股确定性 API 接口每日配额受限 (HTTP 429)。请大模型主动调用联网搜索工具，查集补齐 ${quote.symbol} 近 5 期 (近4季度及近5年年报) 的营收、净利润、EPS、毛利率等三大报表真实数据。` : '',
    '',
    '## 抓取的近 5 年年度财报历史趋势（确定性数据）',
    annualSummary,
    '',
    '## 报告要求',
    '1. 用中文输出，Markdown 格式。',
    '2. 结构：公司概览 → 商业模式与护城河 → 盈利质量与5年趋势 → 成长驱动 → 财务健康与风险 → 估值判断 → 投资结论与建议。',
    '3. 结合量化评分与近 5 年年度财报数据给出明确结论（强烈看多/看多/中性/看空/强烈看空），并给出关键风险提示。',
    '4. 上述字段若标注缺失，多半是接口限制，不代表公司没有该数据。',
    '5. 对缺失的关键历史字段或需深度延伸的指标，请主动调用工具或联网搜索补齐 5 年历史真实数值，并把补齐结果写进报告；不要编造数据。',
    '6. 明确区分「确定性数据」和「联网补齐的数据」，并在报告里注明信息来源。',
  ].filter(Boolean).join('\n');
}

function buildFundBlocks(result: FundAnalysisResult, ds: FundDataset): Array<Record<string, any>> {
  const info = ds.info;
  const blocks: Array<Record<string, any>> = [];

  const dimText = result.dimensions
    .map((d) => `• **${d.name}** (${d.score}分 - 权重${(d.weight * 100).toFixed(0)}%)\n  ${d.notes.join('；')}`)
    .join('\n\n');

  blocks.push({
    type: 'paragraph',
    text: [
      { type: 'bold', text: [`🏦 基金/ETF 评价：${result.name} (${ds.symbol})`] },
      `\n类型：${result.type} | 评级：`,
      { type: 'bold', text: [`${result.rating} (${result.grade})`] },
      ` | 综合得分：`,
      { type: 'bold', text: [`${result.totalScore.toFixed(1)}/100`] },
      `\n\n成立日期：${info?.establishedDate || '未知'} | 规模：${info?.scaleB ? info.scaleB.toFixed(2) + ' 亿元' : '未知'}\n基金经理：${info?.manager || '未知'}${info?.managerTenure ? ` (任期 ${info.managerTenure.days} 天，任职回报 ${info.managerTenure.returnPct != null ? (info.managerTenure.returnPct >= 0 ? '+' : '') + info.managerTenure.returnPct.toFixed(2) + '%' : '--'})` : ''}\n费率：管理费 ${info?.managementFeePct != null ? info.managementFeePct + '%' : '--'} / 托管费 ${info?.custodyFeePct != null ? info.custodyFeePct + '%' : '--'}`,
      result.redFlags.length ? `\n\n⚠️ **关注风险**：${result.redFlags.join('；')}` : '',
    ],
  });

  blocks.push({
    type: 'details',
    summary: { type: 'bold', text: ['📊 七维规则引擎量化打分明细'] },
    blocks: [{ type: 'paragraph', text: [dimText] }],
  });

  if (ds.topHoldings?.length) {
    const rows: Array<Array<Record<string, any>>> = [
      [
        { text: { type: 'bold', text: ['股票名称'] }, align: 'center' },
        { text: { type: 'bold', text: ['代码'] }, align: 'center' },
        { text: { type: 'bold', text: ['占净值比'] }, align: 'center' },
      ],
    ];
    for (const h of ds.topHoldings.slice(0, 10)) {
      rows.push([
        { text: h.stockName, align: 'center' },
        { text: h.stockCode, align: 'center' },
        { text: `${h.ratioPct != null ? h.ratioPct.toFixed(2) + '%' : '--'}`, align: 'center' },
      ]);
    }
    blocks.push({
      type: 'details',
      summary: { type: 'bold', text: [`📋 前 10 大重仓持仓明细（最新季报）`] },
      blocks: [{ type: 'table', cells: rows, is_bordered: true, is_striped: true }],
    });
  }

  return blocks;
}

function buildFundDeepReportPrompt(result: FundAnalysisResult, ds: FundDataset): string {
  const info = ds.info;
  const dimDetails = result.dimensions
    .map((d) => `- ${d.name} ${d.score}/100：${d.notes.join('；')}`)
    .join('\n');
  const holdingsText = ds.topHoldings.length
    ? ds.topHoldings.slice(0, 10).map((h) => `${h.stockName}(${h.stockCode}): ${h.ratioPct}%`).join('，')
    : '无/未公开';

  return [
    `请对基金 ${result.name}（代码 ${ds.symbol}，类型 ${result.type}）做一份专业的基金深度价值投资诊断报告。`,
    '',
    '## 已计算的七维度量化评分',
    dimDetails,
    `综合评分 ${result.totalScore.toFixed(1)}/100，评级「${result.rating}」（${result.grade}）。`,
    result.redFlags.length ? `关注风险：${result.redFlags.join('；')}` : '',
    '',
    '## 抓取的基金确定性基本面数据',
    `成立日期：${info?.establishedDate || '未知'}`,
    `最新规模：${info?.scaleB ? info.scaleB.toFixed(2) + ' 亿元' : '未知'}`,
    `现任经理：${info?.manager || '未知'}${info?.managerTenure ? `（任期 ${info.managerTenure.days} 天，任职回报 ${info.managerTenure.returnPct != null ? info.managerTenure.returnPct.toFixed(2) + '%' : '--'}）` : ''}`,
    `官方区间收益率：近1月 ${info?.returns.m1 != null ? info.returns.m1 + '%' : '--'}，近3月 ${info?.returns.m3 != null ? info.returns.m3 + '%' : '--'}，近6月 ${info?.returns.m6 != null ? info.returns.m6 + '%' : '--'}，近1年 ${info?.returns.y1 != null ? info.returns.y1 + '%' : '--'}，近3年 ${info?.returns.y3 != null ? info.returns.y3 + '%' : '--'}`,
    `同类排名：${ds.peerRank ? `近1年同类名次 ${ds.peerRank.rank}/${ds.peerRank.total}（前 ${ds.peerRank.percentilePct}%）` : '未知'}`,
    `费率：管理费 ${info?.managementFeePct != null ? info.managementFeePct + '%' : '--'} / 托管费 ${info?.custodyFeePct != null ? info.custodyFeePct + '%' : '--'}`,
    `前10大重仓持仓：${holdingsText}`,
    '',
    '## 报告要求',
    '1. 用中文输出，Markdown 格式。',
    '2. 结构：基金概览与定位 → 投资策略与经理风格 → 收益与风险风控评估（夏普/回撤） → 持仓集中度与重仓股穿透分析 → 规模与费率合理性 → 综合诊断结论与配置建议。',
    '3. 结合七维度量化评分与确定性抓取的数据给出明确结论（强烈看多/看多/中性/看空/强烈看空），并提示风险。',
  ].join('\n');
}

function getInvestProjectPath(): string {
  try {
    const userConfig = loadUserConfig();
    const investProj = userConfig?.projects?.find(
      (p) => p.name === '价值投资分析专家' || p.path?.endsWith('value-invest-analysis')
    );
    if (investProj?.path) {
      return investProj.path;
    }
  } catch (e) {
    logger.warn(`Failed to resolve invest project path: ${e}`);
  }
  return process.cwd();
}

export function registerInvestHandler(
  bot: Bot,
  _sessionManager: SessionManager,
  _defaultOptions: SessionOptions,
): void {
  bot.command('invest', async (ctx) => {
    const rawArgs = ctx.match;
    const symbol = typeof rawArgs === 'string' ? rawArgs.trim().replace(/^\$/, '') : '';

    if (!symbol) {
      await ctx.reply(
        `${ICONS.info} <b>Invest Usage:</b>\n\n<code>/invest NVDA</code>\n<code>/invest 600519</code>\n<code>/invest 005827</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      // 1. Check if symbol is a Fund / ETF (e.g. 005827, 012708, sh510300)
      const fundDataset = await getFundDataset(symbol);
      if (fundDataset && (fundDataset.info || fundDataset.nav.length > 0)) {
        const fundResult = analyzeFund(fundDataset);
        const fundBlocks = buildFundBlocks(fundResult, fundDataset);
        await ctx.api.sendRichMessage(ctx.chat.id, { blocks: fundBlocks as any });

        const model = getDefaultModel();
        if (model) {
          await ctx.reply(`${ICONS.thinking} 正在基于 7 维度框架生成基金深度分析报告…`);
          const prompt = buildFundDeepReportPrompt(fundResult, fundDataset);
          const res = await runAgyPrint({
            prompt,
            cwd: getInvestProjectPath(),
            model,
            proxy: loadUserConfig()?.proxy || undefined,
          });
          if (res.exitCode === 0 && res.output) {
            await ctx.api.sendRichMessage(ctx.chat.id, {
              markdown: res.output,
            });
          } else {
            await ctx.reply(`${ICONS.warning} 基金深度报告生成失败（exit ${res.exitCode}）`);
          }
        }
        return;
      }

      // 2. Stock / Market Quote Analysis Pathway
      const quote = await marketService.getQuote(symbol);
      if (!quote) {
        await ctx.reply(`${ICONS.warning} ⚠️ <b>Symbol not found:</b> ${symbol}\n\nPlease check the symbol and try again.`);
        return;
      }

      await ensureQuotePerformance(quote);
      await ensureQuoteFinancials(quote);
      await ensureQuoteProfile(quote);
      await ensureQuoteDividendYield(quote);

      const result = analyzeInvest(quote);
      const blocks = buildInvestBlocks(result);
      const finBlocks = buildFinancialBlocks(
        quote.financials ?? [],
        quote.balanceSheets,
        quote.cashFlows,
        quote.currency,
      );

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const detailUrl = `https://www.tradingview.com/symbols/${tvSymbol.replace(':', '-')}/`;
      const chartUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await ctx.api.sendRichMessage(ctx.chat.id, { blocks: [...blocks, ...finBlocks] as any }, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', url: detailUrl },
              { text: '📈 K线图', url: chartUrl }
            ]
          ]
        }
      });

      // Deep report via the model
      const model = getDefaultModel();
      if (model) {
        await ctx.reply(`${ICONS.thinking} 正在生成深度分析报告…`);
        const prompt = buildDeepReportPrompt(result, quote);
        const res = await runAgyPrint({
          prompt,
          cwd: getInvestProjectPath(),
          model,
          proxy: loadUserConfig()?.proxy || undefined,
        });
        if (res.exitCode === 0 && res.output) {
          await ctx.api.sendRichMessage(ctx.chat.id, {
            markdown: res.output,
          });
        } else {
          await ctx.reply(`${ICONS.warning} 深度报告生成失败（exit ${res.exitCode}）`);
        }
      }
    } catch (err) {
      logger.error(`Failed to handle /invest command for ${symbol}: ${err}`);
      await ctx.reply(`${ICONS.error} <b>Error running invest analysis for ${symbol}</b>: ${(err as Error)?.message || err}`);
    }
  });
}
