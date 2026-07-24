/**
 * @file exchangeRate.ts
 * @description Real-time USD/CNY exchange rate provider.
 * Fetches from Google Finance, falls back to locally persisted rate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '../../.exchange-rate-cache.json');

interface RateCache {
  rate: number;
  fetchedAt: number; // epoch ms
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_RATE = 7.25; // fallback if nothing is available

let cachedRate: RateCache | null = null;

function readCache(): RateCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw) as RateCache;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: controller.signal,
    });
    clearTimeout(timer);

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

/**
 * Get the current USD → CNY exchange rate.
 * Priority: in-memory cache → Google Finance → disk cache → default.
 */
export async function getUsdToCnyRate(): Promise<number> {
  // 1. In-memory cache (valid for 24h)
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL_MS) {
    return cachedRate.rate;
  }

  // 2. Try exchangerate-api.com
  const liveRate = await fetchFromApi();
  if (liveRate) {
    cachedRate = { rate: liveRate, fetchedAt: Date.now() };
    writeCache(liveRate);
    logger.info(`[exchangeRate] Fetched live USD/CNY = ${liveRate}`);
    return liveRate;
  }

  // 3. Disk cache (even if stale, better than default)
  const diskCache = readCache();
  if (diskCache && diskCache.rate > 0) {
    cachedRate = diskCache;
    logger.info(`[exchangeRate] Using cached USD/CNY = ${diskCache.rate} (fetched ${new Date(diskCache.fetchedAt).toISOString()})`);
    return diskCache.rate;
  }

  // 4. Hardcoded default
  logger.warn(`[exchangeRate] Using default USD/CNY = ${DEFAULT_RATE}`);
  return DEFAULT_RATE;
}

/**
 * Synchronous getter for the cached rate (for use in hot paths).
 * Returns the last known rate or the default if none fetched yet.
 */
export function getCachedUsdToCnyRate(): number {
  if (cachedRate) return cachedRate.rate;
  const disk = readCache();
  if (disk && disk.rate > 0) return disk.rate;
  return DEFAULT_RATE;
}
