/**
 * @file exchangeRate.ts
 * @description Real-time USD/CNY exchange rate provider.
 * Fetches from exchangerate-api.com, falls back to a locally persisted rate,
 * and finally to a hardcoded default when nothing is available.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '../../.exchange-rate-cache.json');

interface RateCache {
  rate: number;
  fetchedAt: number; // epoch ms
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5000;
/** Pause live fetches for this long after a failed attempt (API down / network error). */
const FETCH_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_RATE = 7; // fallback if nothing is available

let cachedRate: RateCache | null = null;
let lastFetchFailedAt = 0;

function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100;
}

function readCache(): RateCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const candidate = data as Partial<RateCache>;
    if (!isValidRate(candidate.rate)) return null;
    if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) return null;
    return { rate: candidate.rate, fetchedAt: candidate.fetchedAt };
  } catch {
    return null;
  }
}

function writeCache(rate: number): void {
  try {
    const data: RateCache = { rate, fetchedAt: Date.now() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    logger.warn(`[exchangeRate] Failed to write cache: ${e}`);
  }
}

/**
 * Fetch USD/CNY rate from exchangerate-api.com (free, no key needed).
 */
async function fetchFromApi(): Promise<number | null> {
  try {
    const res = await fetchWithTimeout('https://api.exchangerate-api.com/v4/latest/USD', {}, FETCH_TIMEOUT_MS);

    if (!res.ok) return null;
    const data = await res.json() as { rates?: Record<string, number> };
    const rate = data?.rates?.['CNY'];
    if (typeof rate === 'number' && rate > 0 && rate < 100) return rate;
    return null;
  } catch (e) {
    logger.debug(`[exchangeRate] API fetch failed: ${e}`);
    return null;
  }
}

async function updateCache(): Promise<void> {
  // Backoff: after a failed attempt, don't hammer a down API on every stale check.
  if (lastFetchFailedAt && Date.now() - lastFetchFailedAt < FETCH_BACKOFF_MS) return;
  const liveRate = await fetchFromApi();
  if (liveRate) {
    lastFetchFailedAt = 0;
    cachedRate = { rate: liveRate, fetchedAt: Date.now() };
    writeCache(liveRate);
    logger.info(`[exchangeRate] Updated live USD/CNY = ${liveRate}`);
  } else {
    lastFetchFailedAt = Date.now();
  }
}

let _fetching = false;

/** Run updateCache(), always resetting the in-flight guard so future TTL refreshes can happen. */
async function refreshWithGuard(): Promise<void> {
  try {
    await updateCache();
  } finally {
    _fetching = false;
  }
}

/**
 * Initialize exchange rate on startup: fetch live rate in background.
 */
export function initExchangeRate(): void {
  if (_fetching) return;
  _fetching = true;
  refreshWithGuard().catch((e) => {
    logger.debug(`[exchangeRate] Background refresh failed: ${e}`);
  });
}

/**
 * True when the last known rate is older than CACHE_TTL_MS (or never fetched),
 * i.e. the value returned by getCachedUsdToCnyRate() may be outdated.
 */
function isExchangeRateStale(): boolean {
  return cachedRate ? Date.now() - cachedRate.fetchedAt > CACHE_TTL_MS : true;
}

/** Getter for the cached rate with stale-aware logging (throttled). */
let staleWarned = false;
export function getCachedUsdToCnyRate(): number {
  if (isExchangeRateStale() && !staleWarned) {
    staleWarned = true;
    logger.warn('[exchangeRate] Using possibly stale cached rate (refresh failed or TTL exceeded)');
  }
  return getCachedUsdToCnyRateRaw();
}

function getCachedUsdToCnyRateRaw(): number {
  if (cachedRate) {
    if (Date.now() - cachedRate.fetchedAt > CACHE_TTL_MS && !_fetching) {
      _fetching = true;
      refreshWithGuard().catch(() => {});
    }
    return cachedRate.rate;
  }
  const disk = readCache();
  if (disk && disk.rate > 0) {
    cachedRate = disk;
    if (Date.now() - disk.fetchedAt > CACHE_TTL_MS && !_fetching) {
      _fetching = true;
      refreshWithGuard().catch(() => {});
    }
    return disk.rate;
  }
  if (!_fetching) {
    _fetching = true;
    refreshWithGuard().catch(() => {});
  }
  return DEFAULT_RATE;
}
