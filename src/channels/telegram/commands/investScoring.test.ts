/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investScoring.test.ts
 * @description Tests for the pure six-dimension value-investing scoring engine.
 * Pins the grading boundaries, weight normalization, red-flag detection, and
 * the missing-data neutral paths so scoring formula changes are reviewable.
 */

import { describe, it, expect } from 'vitest';
import { analyzeInvest, type InvestResult } from './investScoring.js';
import type { StockQuote, StockFinancial, StockBalanceSheet, StockCashFlow } from '../../../stock/types.js';

function mkQuote(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol: 'TEST',
    name: 'Test Corp',
    price: 100,
    change: 1,
    changePercent: 1,
    market: 'US',
    currency: 'USD',
    timestamp: 0,
    source: 'test',
    isDelayed: false,
    ...overrides,
  };
}

function mkFs(overrides: Partial<StockFinancial> = {}): StockFinancial {
  return {
    date: '2026-06-30',
    period: '2026 Q2',
    revenue: 1000,
    ...overrides,
  };
}

describe('analyzeInvest — weights and structure', () => {
  it('produces exactly six dimensions whose weights sum to 1', () => {
    const res = analyzeInvest(mkQuote());
    expect(res.dimensions).toHaveLength(6);
    const weightSum = res.dimensions.reduce((a, d) => a + d.weight, 0);
    expect(weightSum).toBeCloseTo(1, 10);
  });

  it('clamps every dimension score into [0, 100]', () => {
    const res = analyzeInvest(mkQuote());
    for (const d of res.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
  });

  it('computes totalScore as the weighted sum of dimension scores', () => {
    const res = analyzeInvest(mkQuote());
    const weighted = res.dimensions.reduce((a, d) => a + d.score * d.weight, 0);
    expect(res.totalScore).toBeCloseTo(weighted, 10);
  });

  it('never crashes on completely empty fundamentals', () => {
    const res = analyzeInvest(mkQuote());
    expect(res.totalScore).toBeGreaterThan(0);
    expect(res.summary).toContain('综合评分');
  });
});

describe('analyzeInvest — grading boundaries', () => {
  it('grades an excellent business A/A+ (high ROE, margins, net cash, cheap)', () => {
    const fs: StockFinancial[] = [
      mkFs({ roe: 25, netMargin: 22, grossMargin: 55, revenueYoY: 25, netIncomeYoY: 30, netIncome: 200 }),
      mkFs({ date: '2026-03-31', period: '2026 Q1', revenue: 950, roe: 24, netIncome: 180 }),
      mkFs({ date: '2025-12-31', period: '2025 Q4', revenue: 900, roe: 23.5, netIncome: 170 }),
      mkFs({ date: '2025-09-30', period: '2025 Q3', revenue: 850, roe: 23, netIncome: 160 }),
    ];
    const bs: StockBalanceSheet[] = [
      { date: '2026-06-30', debtRatio: 25, cash: 5000, shortTermDebt: 0, longTermDebt: 0 } as StockBalanceSheet,
    ];
    const cf: StockCashFlow[] = [
      { date: '2026-06-30', netCashOperating: 300, netCashInvesting: -100 } as StockCashFlow,
    ];
    const res = analyzeInvest(
      mkQuote({ pe: 12, pb: 2, dividendYield: 3, high52: 120, low52: 60, financials: fs, balanceSheets: bs, cashFlows: cf })
    );
    expect(res.totalScore).toBeGreaterThanOrEqual(75);
    expect(['A', 'A+']).toContain(res.grade);
    expect(res.redFlags).toHaveLength(0);
  });

  it('grades a distressed business C/D with red flags', () => {
    const fs: StockFinancial[] = [mkFs({ roe: -20, netMargin: -15, grossMargin: 8, revenueYoY: -20, netIncome: -50 })];
    const bs: StockBalanceSheet[] = [
      { date: '2026-06-30', debtRatio: 90 } as StockBalanceSheet,
    ];
    const cf: StockCashFlow[] = [
      { date: '2026-06-30', netCashOperating: -80 } as StockCashFlow,
    ];
    const res = analyzeInvest(
      mkQuote({ pe: 150, financials: fs, balanceSheets: bs, cashFlows: cf })
    );
    expect(res.totalScore).toBeLessThan(35);
    expect(['C', 'D']).toContain(res.grade);
    // All four red flags fire
    expect(res.redFlags).toContain('最近一期亏损');
    expect(res.redFlags.some((f) => f.includes('资产负债率'))).toBe(true);
    expect(res.redFlags).toContain('经营现金流为负');
    expect(res.redFlags).toContain('PE 过高，估值透支');
  });

  it('maps grade thresholds monotonically', () => {
    // Boundary checks via summary text on crafted quotes would be brittle;
    // instead verify ordering: better fundamentals never yield a lower grade rank.
    const rankOf = (res: InvestResult): number =>
      ['D', 'C', 'B-', 'B', 'B+', 'A-', 'A', 'A+'].indexOf(res.grade);

    const good = analyzeInvest(mkQuote({
      pe: 10, pb: 1, dividendYield: 5,
      financials: [mkFs({ roe: 30, netMargin: 30, grossMargin: 60, revenueYoY: 40, netIncomeYoY: 45, netIncome: 300 })],
    }));
    const bad = analyzeInvest(mkQuote({
      pe: 200, pb: 20, dividendYield: 0,
      financials: [mkFs({ roe: -30, netMargin: -30, grossMargin: 2, revenueYoY: -40, netIncomeYoY: -50, netIncome: -100 })],
    }));
    expect(rankOf(good)).toBeGreaterThan(rankOf(bad));
  });
});

describe('analyzeInvest — missing-data neutrality', () => {
  it('gives partial credit (not zero, not full) when ROE is absent', () => {
    const res = analyzeInvest(mkQuote({ financials: [mkFs({})] }));
    const profitability = res.dimensions.find((d) => d.id === 'profitability')!;
    expect(profitability.notes.some((n) => n.includes('ROE 数据缺失'))).toBe(true);
    expect(profitability.score).toBeGreaterThan(0);
  });

  it('falls back to operating margin when gross margin is missing', () => {
    const res = analyzeInvest(mkQuote({
      financials: [mkFs({ roe: 18, netMargin: 12, operatingMargin: 20 })],
    }));
    const profitability = res.dimensions.find((d) => d.id === 'profitability')!;
    expect(profitability.notes.some((n) => n.includes('营业利润率'))).toBe(true);
  });

  it('annualizes QoQ revenue growth when YoY data is absent', () => {
    const res = analyzeInvest(mkQuote({
      financials: [
        mkFs({ revenue: 1200 }),
        mkFs({ date: '2026-03-31', period: '2026 Q1', revenue: 1100 }),
        mkFs({ date: '2025-12-31', period: '2025 Q4', revenue: 1000 }),
        mkFs({ date: '2025-09-30', period: '2025 Q3', revenue: 950 }),
      ],
    }));
    const growth = res.dimensions.find((d) => d.id === 'growth')!;
    expect(growth.notes.some((n) => n.includes('年化营收增速'))).toBe(true);
  });

  it('treats dividendYield=0 as "no dividend" but missing as unknown', () => {
    const noDiv = analyzeInvest(mkQuote({ dividendYield: 0 }));
    expect(noDiv.dimensions.find((d) => d.id === 'shareholderYield')!.notes)
      .toContain('当前无现金分红');

    const unknownDiv = analyzeInvest(mkQuote({}));
    expect(unknownDiv.dimensions.find((d) => d.id === 'shareholderYield')!.notes[0])
      .toContain('股息率数据缺失');
  });
});
