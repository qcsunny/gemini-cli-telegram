/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file fundAnalyzer.ts
 * @description Fund 7-dimension value investing evaluation engine (Return, Risk, Risk-Adjusted, Holdings, Scale & Cost, Stability, Peer Rank).
 */

import type { FundDataset, FundInfo, FundNavRow } from '../provider/fund.js';

interface DimensionScore {
  id: string;
  name: string;
  score: number;
  weight: number;
  notes: string[];
}

export interface FundAnalysisResult {
  symbol: string;
  name: string;
  type: string;
  dimensions: DimensionScore[];
  totalScore: number;
  grade: string;
  rating: string;
  summary: string;
  redFlags: string[];
}

const MIN_NAV_ROWS = 60;

function periodReturn(nav: FundNavRow[], days: number): number | null {
  if (!nav || nav.length < 2) return null;
  const endIdx = Math.min(days, nav.length - 1);
  const end = nav[0]?.nav;
  const start = nav[endIdx]?.nav;
  if (!end || !start || start <= 0) return null;
  return ((end - start) / start) * 100;
}

function dailyReturns(nav: FundNavRow[]): number[] {
  const res: number[] = [];
  for (let i = 0; i < nav.length - 1; i++) {
    const cur = nav[i]?.nav;
    const prev = nav[i + 1]?.nav;
    if (cur && prev && prev > 0) {
      res.push((cur - prev) / prev);
    }
  }
  return res;
}

function meanStd(arr: number[]): { mean: number; std: number } {
  if (!arr.length) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
  return { mean, std: Math.sqrt(variance) };
}

function maxDrawdown(nav: FundNavRow[]): number {
  if (!nav || nav.length < 2) return 0;
  let maxNav = -Infinity;
  let maxDd = 0;
  for (let i = nav.length - 1; i >= 0; i--) {
    const val = nav[i]?.nav ?? 0;
    if (val > maxNav) maxNav = val;
    const dd = maxNav > 0 ? ((val - maxNav) / maxNav) * 100 : 0;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

function grade(score: number): { grade: string; rating: string } {
  if (score >= 85) return { grade: 'A+', rating: '强烈看多' };
  if (score >= 75) return { grade: 'A', rating: '看多' };
  if (score >= 65) return { grade: 'A-', rating: '谨慎看多' };
  if (score >= 55) return { grade: 'B+', rating: '中性偏多' };
  if (score >= 45) return { grade: 'B', rating: '中性' };
  if (score >= 35) return { grade: 'B-', rating: '中性偏空' };
  if (score >= 25) return { grade: 'C', rating: '看空' };
  return { grade: 'D', rating: '强烈看空' };
}

function scoreReturn(nav: FundNavRow[], info: FundInfo | null): DimensionScore {
  const r = info?.returns;
  const notes: string[] = [];
  const y3 = r?.y3 ?? periodReturn(nav, 750);
  const y1 = r?.y1 ?? periodReturn(nav, 250);
  const m6 = r?.m6 ?? periodReturn(nav, 125);
  const m3 = r?.m3 ?? periodReturn(nav, 66);
  const m1 = r?.m1 ?? periodReturn(nav, 22);
  const ytd = r?.ytd ?? null;
  const ten = info?.managerTenure?.returnPct ?? null;
  const sinceInc = r?.sinceInception ?? (nav.length >= 2 ? periodReturn(nav, nav.length - 1) : null);

  const fmt = (v: number | null | undefined): string | null =>
    v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  if (y3 != null) notes.push(`近3年 ${fmt(y3)}`);
  if (y1 != null) notes.push(`近1年 ${fmt(y1)}`);
  if (m6 != null) notes.push(`近6月 ${fmt(m6)}`);
  if (m3 != null) notes.push(`近3月 ${fmt(m3)}`);
  if (m1 != null) notes.push(`近1月 ${fmt(m1)}`);
  if (ytd != null) notes.push(`YTD ${fmt(ytd)}`);
  if (ten != null) notes.push(`任职以来 ${fmt(ten)}`);
  if (sinceInc != null && notes.length <= 1) notes.push(`成立以来 ${fmt(sinceInc)}`);

  let anchor: number | null = null;
  let factor = 1.0;
  let periodLabel = '';

  if (y1 != null || y3 != null) {
    if (y1 != null) {
      anchor = y1;
      periodLabel = '近1年';
    } else {
      // y3 via official info.returns.y3 is a true 3-year figure; a NAV-based
      // fallback may cover fewer days — label it honestly instead of "近3年".
      anchor = y3;
      periodLabel = r?.y3 != null || nav.length >= 700
        ? '近3年'
        : `近${Math.max(1, Math.round(nav.length / 21))}个月`;
    }
    factor = 1.0;
  } else if (m6 != null) {
    anchor = m6;
    periodLabel = '近6月';
    factor = 0.9;
  } else if (m3 != null) {
    anchor = m3;
    periodLabel = '近3月';
    factor = 0.85;
  } else if (ytd != null) {
    anchor = ytd;
    periodLabel = '今年以来';
    factor = 0.8;
  } else if (m1 != null) {
    anchor = m1;
    periodLabel = '近1月';
    factor = 0.75;
  } else if (sinceInc != null) {
    anchor = sinceInc;
    periodLabel = '成立以来';
    factor = 0.7;
  }

  if (anchor == null) {
    if (notes.length === 0) notes.push('收益数据缺失，无法计算区间收益');
    return { id: 'return', name: '收益表现', score: 50, weight: 0.2, notes: [...notes, '数据不足取中性分'] };
  }

  if (factor < 1.0) {
    notes.push(`次新基金/短期数据（采信${periodLabel} ${fmt(anchor)}，得分按 ${factor} 折减）`);
  }

  let rawScore: number;
  if (anchor >= 30) rawScore = 95;
  else if (anchor >= 15) rawScore = 82;
  else if (anchor >= 8) rawScore = 68;
  else if (anchor >= 0) rawScore = 50;
  else if (anchor >= -15) rawScore = 32;
  else rawScore = 15;

  const score = Math.round(50 + (rawScore - 50) * factor);
  return { id: 'return', name: '收益表现', score, weight: 0.2, notes };
}

function scoreRisk(nav: FundNavRow[]): DimensionScore {
  if (nav.length < MIN_NAV_ROWS) {
    return {
      id: 'risk',
      name: '风险控制',
      score: 50,
      weight: 0.12,
      notes: [`净值仅 ${nav.length} 条（<${MIN_NAV_ROWS}），历史数据不足，取中性分`],
    };
  }
  const dd = maxDrawdown(nav);
  const { std } = meanStd(dailyReturns(nav));
  const annualVol = std * Math.sqrt(252);
  const notes = [`最大回撤 ${dd.toFixed(2)}%`, `年化波动率 ${annualVol.toFixed(1)}%`];

  let score: number;
  if (dd >= -5) score = 92;
  else if (dd >= -10) score = 78;
  else if (dd >= -20) score = 60;
  else if (dd >= -35) score = 40;
  else score = 20;
  return { id: 'risk', name: '风险控制', score, weight: 0.12, notes };
}

function scoreRiskAdjusted(nav: FundNavRow[]): DimensionScore {
  const r1y = periodReturn(nav, 250);
  const { std } = meanStd(dailyReturns(nav));
  const annualVol = std * Math.sqrt(252);
  const dd = maxDrawdown(nav);
  const riskFreePct = 2;

  const sharpe = annualVol > 0 && r1y != null ? (r1y - riskFreePct) / annualVol : null;
  const calmar = r1y != null && dd < 0 ? r1y / Math.abs(dd) : null;
  const notes: string[] = [];
  if (sharpe != null) notes.push(`夏普比率 ${sharpe.toFixed(2)}`);
  if (calmar != null) notes.push(`卡玛比率 ${calmar.toFixed(2)}`);

  const primary = sharpe ?? calmar;
  if (primary == null) return { id: 'riskAdjusted', name: '风险调整后收益', score: 50, weight: 0.18, notes: [...notes, '数据不足取中性分'] };
  let score: number;
  if (primary >= 2) score = 95;
  else if (primary >= 1.2) score = 82;
  else if (primary >= 0.5) score = 62;
  else if (primary >= 0) score = 45;
  else score = 22;
  return { id: 'riskAdjusted', name: '风险调整后收益', score, weight: 0.18, notes };
}

function scoreHoldings(ds: FundDataset): DimensionScore {
  const hs = ds.topHoldings ?? [];
  const isIndex = /指数|ETF/.test(ds.info?.type ?? '');
  const notes: string[] = [];
  if (hs.length === 0) {
    if (isIndex) {
      return { id: 'holdings', name: '持仓质量', score: 65, weight: 0.13, notes: ['指数基金不看重仓集中度，按中性偏好评'] };
    }
    return { id: 'holdings', name: '持仓质量', score: 50, weight: 0.13, notes: ['重仓数据不可用，取中性分'] };
  }
  const top5 = hs.slice(0, 5).filter((h) => h.ratioPct != null).reduce((a, h) => a + (h.ratioPct ?? 0), 0);
  const top10 = hs.filter((h) => h.ratioPct != null).reduce((a, h) => a + (h.ratioPct ?? 0), 0);
  notes.push(`前5集中度 ${top5.toFixed(1)}%`);
  notes.push(`前${hs.length}集中度 ${top10.toFixed(1)}%`);

  let score: number;
  if (top10 >= 85) score = 40;
  else if (top10 >= 65) score = 62;
  else if (top10 >= 40) score = 78;
  else if (top10 >= 25) score = 55;
  else score = 40;

  return { id: 'holdings', name: '持仓质量', score, weight: 0.13, notes };
}

function scoreScaleCost(ds: FundDataset): DimensionScore {
  const scaleB = ds.info?.scaleB;
  const mgt = ds.info?.managementFeePct;
  const cust = ds.info?.custodyFeePct;
  const totalFee = mgt != null && cust != null ? mgt + cust : null;
  const isIndex = /指数|ETF/.test(ds.info?.type ?? '');
  const notes: string[] = [];
  if (scaleB != null) notes.push(`规模 ${scaleB.toFixed(2)} 亿元`);
  if (totalFee != null) notes.push(`管理+托管费 ${totalFee.toFixed(2)}%`);
  if (isIndex) notes.push('指数基金（被动跟踪，规模影响小）');
  if (notes.length === 0) notes.push('规模/费率数据不可用');

  const scoreScale = (() => {
    if (scaleB == null) return 50;
    if (isIndex) {
      if (scaleB < 0.5) return 40;
      if (scaleB < 2) return 60;
      if (scaleB < 100) return 85;
      return 75;
    }
    if (scaleB < 0.5) return 20;
    if (scaleB < 2) return 55;
    if (scaleB < 50) return 90;
    if (scaleB < 100) return 72;
    if (scaleB < 300) return 52;
    return 35;
  })();
  const scoreFee = totalFee == null ? 50 : totalFee <= 0.6 ? 92 : totalFee <= 1.0 ? 78 : totalFee <= 1.5 ? 60 : 40;
  return { id: 'scaleCost', name: '规模/成本', score: Math.round(scoreScale * 0.6 + scoreFee * 0.4), weight: 0.12, notes };
}

function scoreStability(nav: FundNavRow[]): DimensionScore {
  if (nav.length < MIN_NAV_ROWS) {
    return {
      id: 'stability',
      name: '收益稳定性',
      score: 50,
      weight: 0.08,
      notes: [`净值仅 ${nav.length} 条（<${MIN_NAV_ROWS}），历史数据不足，取中性分`],
    };
  }
  const { std } = meanStd(dailyReturns(nav));
  const annualVol = std * Math.sqrt(252);
  const r6m = periodReturn(nav, 125);
  const r1y = periodReturn(nav, 250);
  const notes: string[] = [`年化波动率 ${annualVol.toFixed(1)}%`];
  if (r6m != null && r1y != null) {
    const consistency = (r6m / Math.max(r1y, 1)) * 100;
    notes.push(`近半年/近1年收益比 ${Math.round(consistency)}%`);
  }

  let score: number;
  if (annualVol <= 10) score = 90;
  else if (annualVol <= 18) score = 75;
  else if (annualVol <= 28) score = 55;
  else score = 35;
  return { id: 'stability', name: '收益稳定性', score, weight: 0.08, notes };
}

function scorePeerRank(ds: FundDataset): DimensionScore {
  const pr = ds.peerRank;
  if (!pr) {
    return { id: 'peerRank', name: '同类排名', score: 50, weight: 0.17, notes: ['同类排名数据不可用，取中性分'] };
  }
  const notes = [`近1年同类 ${pr.rank}/${pr.total}（前 ${pr.percentilePct.toFixed(1)}%）`];
  const pct = pr.percentilePct;
  let score: number;
  if (pct <= 10) score = 95;
  else if (pct <= 25) score = 82;
  else if (pct <= 50) score = 65;
  else if (pct <= 75) score = 45;
  else score = 25;
  return { id: 'peerRank', name: '同类排名', score, weight: 0.17, notes };
}

export function analyzeFund(ds: FundDataset): FundAnalysisResult {
  const dims: DimensionScore[] = [
    scoreReturn(ds.nav ?? [], ds.info),
    scoreRisk(ds.nav ?? []),
    scoreRiskAdjusted(ds.nav ?? []),
    scoreHoldings(ds),
    scoreScaleCost(ds),
    scoreStability(ds.nav ?? []),
    scorePeerRank(ds),
  ];
  const totalScore = Math.round(dims.reduce((a, d) => a + d.score * d.weight, 0) * 10) / 10;
  const { grade: g, rating } = grade(totalScore);

  const redFlags: string[] = [];
  const scaleB = ds.info?.scaleB;
  const isIndex = /指数|ETF/.test(ds.info?.type ?? '');
  if (scaleB != null && scaleB < 0.5) redFlags.push(`规模仅 ${scaleB.toFixed(2)} 亿元，存在清盘风险`);
  if (scaleB != null && !isIndex && scaleB >= 300) redFlags.push(`主动型规模达 ${scaleB.toFixed(0)} 亿元，调仓冲击成本高、灵活性受限`);
  const dd = maxDrawdown(ds.nav ?? []);
  if (dd <= -35) redFlags.push(`近一年最大回撤 ${dd.toFixed(1)}%，风险较大`);
  const r1y = periodReturn(ds.nav ?? [], 250);
  if (r1y != null && r1y < -15) redFlags.push(`近一年收益 ${r1y.toFixed(1)}%，显著亏损`);

  const { name, type } = ds.info ?? {};
  const summary = `${name ?? ds.symbol}（${type ?? '基金'}）综合评分 ${totalScore.toFixed(1)}/100 → ${g}（${rating}）。${redFlags.length > 0 ? `关注风险：${redFlags.join('；')}` : '无明显红旗。'}`;

  return {
    symbol: ds.symbol,
    name: name ?? ds.symbol,
    type: type ?? '基金',
    dimensions: dims,
    totalScore,
    grade: g,
    rating,
    summary,
    redFlags,
  };
}
