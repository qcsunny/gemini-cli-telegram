/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file performance.ts
 * @description Computes multi-period stock performance (1M, 3M, 6M, 1Y, YTD)
 * based on candle data points.
 */

import type { CandleDataPoint } from '../types.js';

export interface StockPerformance {
  change1M?: number;
  change3M?: number;
  change6M?: number;
  change1Y?: number;
  changeYTD?: number;
}

export function calculatePerformance(currentPrice: number, candles: CandleDataPoint[]): StockPerformance {
  if (!candles || candles.length === 0 || !currentPrice) return {};

  const nowSec = Math.floor(Date.now() / 1000);
  const currentYear = new Date().getFullYear();
  const ytdStartSec = Math.floor(new Date(currentYear, 0, 1).getTime() / 1000);

  const sec1M = 30 * 24 * 3600;
  const sec3M = 90 * 24 * 3600;
  const sec6M = 180 * 24 * 3600;
  const sec1Y = 365 * 24 * 3600;

  function getClosestPrice(targetSec: number): number | null {
    let closestPoint: CandleDataPoint | null = null;
    let minDiff = Infinity;
    for (const point of candles) {
      const diff = Math.abs(point.time - targetSec);
      if (diff < minDiff) {
        minDiff = diff;
        closestPoint = point;
      }
    }
    // Only accept if within a 7-day window of target timestamp
    if (closestPoint && minDiff < 7 * 24 * 3600) {
      return closestPoint.close;
    }
    return null;
  }

  function calcPct(oldPrice: number | null): number | undefined {
    if (!oldPrice || oldPrice === 0) return undefined;
    return Number((((currentPrice - oldPrice) / oldPrice) * 100).toFixed(2));
  }

  return {
    change1M: calcPct(getClosestPrice(nowSec - sec1M)),
    change3M: calcPct(getClosestPrice(nowSec - sec3M)),
    change6M: calcPct(getClosestPrice(nowSec - sec6M)),
    change1Y: calcPct(getClosestPrice(nowSec - sec1Y)),
    changeYTD: calcPct(getClosestPrice(ytdStartSec)),
  };
}
