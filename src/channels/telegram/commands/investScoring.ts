/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investScoring.ts
 * @description Pure value-investing scoring engine used by `/invest` — six
 * weighted dimensions (profitability, growth, financial health, cash-flow
 * quality, valuation, shareholder yield), red-flag detection, and grading.
 *
 * Scoring framework mirrors Graham (safety margin), Buffett (moat/ROE/cash
 * flow), Greenblatt (Magic Formula), Damodaran (growth) and Peter Lynch (PEG).
 *
 * This module has NO I/O and NO Telegram dependencies: every function is a
 * pure transformation of stock data structures, so it can be unit-tested in
 * isolation from the grammY handler layer.
 */

import type {
  StockQuote,
  StockFinancial,
  StockBalanceSheet,
  StockCashFlow,
} from '../../../stock/types.js';

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

export function fmtAmount(n: number): string {
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
  const dyPct = dy !== null && dy !== undefined && isNum(dy) ? dy * 100 : null;

  if (dyPct === null) {
    notes.push('股息率数据缺失（当前数据源未提供）');
    points += 40;
  } else if (dyPct >= 4) {
    notes.push(`股息率 ${dyPct.toFixed(2)}%，高分红、回报突出`);
    points += 100;
  } else if (dyPct >= 2.5) {
    notes.push(`股息率 ${dyPct.toFixed(2)}%，分红较稳定，回报良好`);
    points += 80;
  } else if (dyPct >= 1) {
    notes.push(`股息率 ${dyPct.toFixed(2)}%，有分红但吸引力一般`);
    points += 55;
  } else if (dyPct > 0) {
    notes.push(`股息率 ${dyPct.toFixed(2)}%，分红较低，成长型公司常见`);
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
