/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { localIsoTimestamp } from './logger.js';

describe('localIsoTimestamp', () => {
  it('stamps the local wall clock, not the UTC reading, alongside the local offset', () => {
    const d = new Date();
    const stamp = localIsoTimestamp(d);

    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const expectedOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    expect(stamp.endsWith(expectedOffset)).toBe(true);

    // The digits must match the local wall clock (what `date` prints), so the
    // stamp round-trips back to the same instant it was taken at.
    expect(new Date(stamp).getTime()).toBe(d.getTime());
  });

  it('keeps the hour digits in sync with the local hour', () => {
    const d = new Date();
    const hour = localIsoTimestamp(d).slice(11, 13);
    expect(Number(hour)).toBe(d.getHours());
  });

  it('does not shift the reported instant by the offset (regression: UTC digits + local suffix)', () => {
    // Fixed instant: 2026-08-30T06:58:06.349Z === 14:58:06.349 in Asia/Shanghai.
    const instant = new Date('2026-08-30T06:58:06.349Z');
    const stamp = localIsoTimestamp(instant);
    // Whatever the host zone is, parsing the stamp must yield the same instant —
    // the old implementation drifted by the full UTC offset.
    expect(new Date(stamp).toISOString()).toBe('2026-08-30T06:58:06.349Z');
  });
});
