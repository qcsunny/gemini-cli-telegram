/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file analystRating.test.ts
 * @description Tests for fetchFmpRating: API-key/symbol guards, FMP response
 * shaping (non-array/empty/HTTP-error), exact consensus-text formatting,
 * symbol normalization, and marketCache hit behavior.
 *
 * Both network (fetchWithTimeout) and the shared marketCache are mocked; the
 * cache mock is an in-memory Map with TTL semantics so entries cannot leak
 * between tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('../../utils/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock('../cache.js', () => {
  const store = new Map<string, { data: unknown; expiresAt: number }>();
  return {
    marketCache: {
      get: (key: string): unknown => {
        const entry = store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
          store.delete(key);
          return null;
        }
        return entry.data;
      },
      set: (key: string, data: unknown, ttlMs: number): void => {
        store.set(key, { data, expiresAt: Date.now() + ttlMs });
      },
      delete: (key: string): void => {
        store.delete(key);
      },
      clear: (): void => {
        store.clear();
      },
    },
  };
});

import { fetchFmpRating } from './analystRating.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { marketCache } from '../cache.js';

const fetchMock = fetchWithTimeout as unknown as MockFn;

function jsonRes(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

const SNAPSHOT_URL = 'https://financialmodelingprep.com/stable/ratings-snapshot?symbol=';
const TARGET_URL = 'https://financialmodelingprep.com/stable/price-target-consensus?symbol=';

describe('fetchFmpRating', () => {
  beforeEach(() => {
    marketCache.clear();
  });

  it('returns null for an empty API key without fetching', async () => {
    const result = await fetchFmpRating('NVDA', '');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for blank symbols without fetching', async () => {
    expect(await fetchFmpRating('   ', 'key-1')).toBeNull();
    expect(await fetchFmpRating('$', 'key-1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when FMP answers with non-array JSON', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: 'nope' }));
    const result = await fetchFmpRating('NVDA', 'key-1');
    expect(result).toBeNull();
    // Both endpoints are attempted via Promise.all before the null result.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when FMP answers with empty arrays', async () => {
    fetchMock.mockResolvedValue(jsonRes([]));
    expect(await fetchFmpRating('NVDA', 'key-1')).toBeNull();
  });

  it('returns null when the request fails with a non-ok status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect(await fetchFmpRating('NVDA', 'key-1')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    expect(await fetchFmpRating('NVDA', 'key-1')).toBeNull();
  });

  it('returns the full rating with exact consensus text for snapshot + target data', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('ratings-snapshot')) {
        return jsonRes([{
          symbol: 'NVDA',
          rating: 'B',
          overallScore: 3,
          discountedCashFlowScore: 4,
          returnOnEquityScore: 2,
          returnOnAssetsScore: 3,
          debtToEquityScore: 2,
          priceToEarningsScore: 3,
          priceToBookScore: 4,
        }]);
      }
      if (url.includes('price-target-consensus')) {
        return jsonRes([{ targetConsensus: 120.5, targetMedian: 121, targetHigh: 132, targetLow: 108 }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    // '$nvda' must be normalized to NVDA in the request URL.
    const result = await fetchFmpRating('$nvda', 'testkey');
    expect(result).not.toBeNull();
    expect(result?.rating).toBe('B');
    expect(result?.ratingScore).toBe(3);
    expect(result?.targetPriceMean).toBe(120.5);
    expect(result?.targetPriceMedian).toBe(121);
    expect(result?.targetPriceHigh).toBe(132);
    expect(result?.targetPriceLow).toBe(108);
    expect(result?.consensusText).toBe('FMP 评级 B (3/5) · 目标价 $120.50');
    expect(result?.scores).toEqual({ dcf: 4, roe: 2, roa: 3, debtEquity: 2, pe: 3, pb: 4 });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe(`${SNAPSHOT_URL}NVDA&apikey=testkey`);
    expect(urls[1]).toBe(`${TARGET_URL}NVDA&apikey=testkey`);
  });

  it('serves repeat calls from marketCache without re-fetching', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('ratings-snapshot')) return jsonRes([{ rating: 'A-', overallScore: 4 }]);
      if (url.includes('price-target-consensus')) return jsonRes([]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const first = await fetchFmpRating('TSLA', 'testkey');
    const second = await fetchFmpRating('tsla', 'testkey');
    expect(first).not.toBeNull();
    expect(second).toBe(first); // same cached object, case-insensitive key
    expect(fetchMock).toHaveBeenCalledTimes(2); // one round for both endpoints, not two
  });

  it('snapshot only: consensusText omits the target price', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('ratings-snapshot')) return jsonRes([{ rating: 'B', overallScore: 3 }]);
      if (url.includes('price-target-consensus')) return jsonRes([]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await fetchFmpRating('NVDA', 'testkey');
    expect(result).not.toBeNull();
    expect(result?.rating).toBe('B');
    expect(result?.ratingScore).toBe(3);
    expect(result?.targetPriceMean).toBeUndefined();
    expect(result?.targetPriceMedian).toBeUndefined();
    expect(result?.consensusText).toBe('FMP 评级 B (3/5)');
    expect(result?.consensusText).not.toContain('目标价');
  });

  it('target only: falls back to an empty rating with a 0/5 score', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('ratings-snapshot')) return jsonRes([]);
      if (url.includes('price-target-consensus')) return jsonRes([{ targetConsensus: 120.5 }]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await fetchFmpRating('NVDA', 'testkey');
    expect(result).not.toBeNull();
    expect(result?.rating).toBe('');
    expect(result?.ratingScore).toBe(0);
    expect(result?.scores).toBeUndefined();
    expect(result?.consensusText).toBe('FMP 评级  (0/5) · 目标价 $120.50');
  });
});