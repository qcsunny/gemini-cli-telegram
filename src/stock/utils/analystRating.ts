/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file analystRating.ts
 * @description Real analyst ratings & price targets from Financial Modeling Prep
 * (FMP). No synthetic data: when the FMP key is absent or the request fails,
 * callers simply omit the rating section.
 */

import { fetch as undiciFetch } from 'undici';
import { marketCache } from '../cache.js';
import { logger } from '../../utils/logger.js';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FETCH_TIMEOUT_MS = 3000;
/** 24h cache for rating/target data (moves slowly). */
const RATING_TTL_MS = 24 * 60 * 60 * 1000;

export interface AnalystRatingData {
  /** FMP letter rating, e.g. 'A+', 'B', 'C-'. */
  rating: string;
  /** FMP overall score 0..5 (5 = best). */
  ratingScore: number;
  /** Human-readable summary, e.g. "FMP 评级 B (3/5) · 目标价 $120.50". */
  consensusText: string;
  targetPriceMean?: number;
  targetPriceMedian?: number;
  targetPriceHigh?: number;
  targetPriceLow?: number;
  scores?: {
    dcf?: number;
    roe?: number;
    roa?: number;
    debtEquity?: number;
    pe?: number;
    pb?: number;
  };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : undefined;
};

async function fetchJson(url: string, apiKey: string): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await undiciFetch(`${url}&apikey=${encodeURIComponent(apiKey)}`, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[FMP] Rating request failed: HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as unknown;
    return Array.isArray(json) ? json : [];
  } catch (err) {
    logger.warn(`[FMP] Rating request error: ${err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the real FMP analyst rating (ratings-snapshot) and price-target
 * consensus for a symbol. Returns null when no API key is configured, the
 * requests fail, or the symbol is not covered.
 */
export async function fetchFmpRating(
  symbol: string,
  apiKey: string,
): Promise<AnalystRatingData | null> {
  if (!apiKey) return null;

  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;

  const cacheKey = `fmp-rating:${cleanSym}`;
  const cached = marketCache.get<AnalystRatingData>(cacheKey);
  if (cached) return cached;

  const [snapshotRaw, targetRaw] = await Promise.all([
    fetchJson(`${FMP_BASE}/ratings-snapshot?symbol=${encodeURIComponent(cleanSym)}`, apiKey),
    fetchJson(`${FMP_BASE}/price-target-consensus?symbol=${encodeURIComponent(cleanSym)}`, apiKey),
  ]);

  const snapshot = snapshotRaw[0] as Record<string, unknown> | undefined;
  const target = targetRaw[0] as Record<string, unknown> | undefined;
  if (!snapshot && !target) return null;

  const rating = typeof snapshot?.['rating'] === 'string' ? snapshot['rating'] : '';
  const ratingScore = num(snapshot?.['overallScore']);
  const targetPriceMean = num(target?.['targetConsensus']);
  const targetPriceMedian = num(target?.['targetMedian']);
  const targetPriceHigh = num(target?.['targetHigh']);
  const targetPriceLow = num(target?.['targetLow']);
  if (!rating && ratingScore === undefined && targetPriceMean === undefined) return null;

  const scores = snapshot ? {
    dcf: num(snapshot['discountedCashFlowScore']),
    roe: num(snapshot['returnOnEquityScore']),
    roa: num(snapshot['returnOnAssetsScore']),
    debtEquity: num(snapshot['debtToEquityScore']),
    pe: num(snapshot['priceToEarningsScore']),
    pb: num(snapshot['priceToBookScore']),
  } : undefined;

  const rec: AnalystRatingData = {
    rating,
    ratingScore: ratingScore ?? 0,
    consensusText:
      `FMP 评级 ${rating} (${ratingScore ?? 0}/5)` +
      (targetPriceMean !== undefined ? ` · 目标价 $${targetPriceMean.toFixed(2)}` : ''),
    targetPriceMean,
    targetPriceMedian,
    targetPriceHigh,
    targetPriceLow,
    scores,
  };
  marketCache.set(cacheKey, rec, RATING_TTL_MS);
  return rec;
}