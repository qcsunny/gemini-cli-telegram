/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculatePerformance } from './performance.js';
import type { CandleDataPoint } from '../types.js';

const DAY = 24 * 3600;

function candle(time: number, close: number): CandleDataPoint {
  return { time, open: close, high: close, low: close, close, volume: 0 };
}

describe('calculatePerformance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns {} for empty candles or zero price', () => {
    expect(calculatePerformance(100, [])).toEqual({});
    expect(calculatePerformance(0, [candle(1, 100)])).toEqual({});
  });

  it('computes 1M/3M/6M/1Y/YTD percentages from nearest candles', () => {
    const now = Math.floor(Date.now() / 1000);
    const ytdStart = Math.floor(new Date(2026, 0, 1).getTime() / 1000);
    const candles = [
      candle(now - 30 * DAY, 100), // 1M → +20%
      candle(now - 90 * DAY, 80), // 3M → +50%
      candle(now - 180 * DAY, 60), // 6M → +100%
      candle(now - 365 * DAY, 50), // 1Y → +140%
      candle(ytdStart, 75), // YTD → +60%
    ];
    expect(calculatePerformance(120, candles)).toEqual({
      change1M: 20,
      change3M: 50,
      change6M: 100,
      change1Y: 140,
      changeYTD: 60,
    });
  });

  it('accepts candles within a 7-day window of the target date', () => {
    const now = Math.floor(Date.now() / 1000);
    const candles = [candle(now - 30 * DAY + 6 * DAY, 100)]; // 6 days off target
    expect(calculatePerformance(110, candles).change1M).toBe(10);
  });

  it('omits periods whose nearest candle is farther than 7 days', () => {
    const now = Math.floor(Date.now() / 1000);
    const candles = [candle(now - 30 * DAY - 10 * DAY, 100)]; // 10 days off 1M target
    expect(calculatePerformance(110, candles).change1M).toBeUndefined();
  });

  it('omits periods where the old price is zero', () => {
    const now = Math.floor(Date.now() / 1000);
    const candles = [candle(now - 30 * DAY, 0)];
    expect(calculatePerformance(110, candles).change1M).toBeUndefined();
  });

  it('rounds percentages to 2 decimal places', () => {
    const now = Math.floor(Date.now() / 1000);
    const candles = [candle(now - 30 * DAY, 33)];
    const result = calculatePerformance(33.33, candles);
    expect(result.change1M).toBe(Number(((33.33 - 33) / 33 * 100).toFixed(2)));
  });
});