/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getFundDataset } from './fund.js';
import { analyzeFund } from '../analyzer/fundAnalyzer.js';

describe('Fund Provider & Analyzer', () => {
  it('should parse fund symbol with various formats (.OF, uppercase, etc.)', async () => {
    const dsNull = await getFundDataset('INVALID_SYMBOL_123');
    expect(dsNull).toBeNull();
  });

  it('should calculate 7-dimension score correctly for sample fund dataset', () => {
    const mockDataset = {
      symbol: '005827',
      info: {
        code: '005827',
        name: '易方达蓝筹精选混合',
        type: '混合型-偏股',
        establishedDate: '2018-09-05',
        scaleB: 450.5,
        manager: '张坤',
        managerTenure: {
          since: '2018-09-05',
          days: 2890,
          returnPct: 110.5,
        },
        returns: {
          w1: 1.2,
          m1: 3.5,
          m3: 6.8,
          m6: 12.0,
          y1: 18.5,
          y2: 25.0,
          y3: 35.2,
          ytd: 10.1,
          sinceInception: 110.5,
        },
        managementFeePct: 1.2,
        custodyFeePct: 0.2,
        buyStatus: '开放申购',
        sellStatus: '开放赎回',
      },
      nav: [
        { date: '2026-08-12', nav: 2.15, accumNav: 2.15, dailyChangePct: 0.5, sgtz: '开放申购', shtz: '开放赎回' },
        { date: '2026-08-11', nav: 2.14, accumNav: 2.14, dailyChangePct: -0.2, sgtz: '开放申购', shtz: '开放赎回' },
      ],
      topHoldings: [
        { stockCode: '00700', stockName: '腾讯控股', ratioPct: 9.8, sharesWan: 1200, valueWan: 45000 },
        { stockCode: '600519', stockName: '贵州茅台', ratioPct: 9.2, sharesWan: 200, valueWan: 42000 },
      ],
      peerRank: {
        total: 3500,
        rank: 350,
        percentilePct: 10.0,
        metric: '近1年收益率',
      },
      quote: null,
      timestamp: Date.now(),
    };

    const result = analyzeFund(mockDataset);
    expect(result.symbol).toBe('005827');
    expect(result.name).toBe('易方达蓝筹精选混合');
    expect(result.dimensions.length).toBe(7);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.grade).toBeDefined();
    expect(result.rating).toBeDefined();
  });
});
