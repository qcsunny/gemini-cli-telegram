import { logger } from '../../../utils/logger.js';
import { getDb, schema } from '../../../db/index.js';
import { eq } from 'drizzle-orm';

const BACKOFF_CLEANUP_INTERVAL = 300_000;

const draftBackoffMultiplier = new Map<number, number>();

let _backoffCleanupTimer: ReturnType<typeof setInterval> | undefined;

let isLoaded = false;

function loadFromDbIfNeeded(): void {
  if (isLoaded) return;
  isLoaded = true;
  try {
    const db = getDb();
    const rows = db.select().from(schema.runtimeStates).where(
      eq(schema.runtimeStates.key, 'rate_limiter')
    ).get();
    if (rows?.value) {
      const data = JSON.parse(rows.value);
      if (data.until) {
        for (const [k, v] of Object.entries(data.until)) {
          draftBackoffUntil.setInternal(Number(k), Number(v));
        }
      }
      if (data.multiplier) {
        for (const [k, v] of Object.entries(data.multiplier)) {
          draftBackoffMultiplier.set(Number(k), Number(v));
        }
      }
    }
  } catch (err) {
    logger.warn(`[RateLimiter] Failed to load rate limiter states from db: ${err}`);
  }
}

function saveToDb(): void {
  try {
    const db = getDb();
    const data = {
      until: Object.fromEntries(draftBackoffUntil.entries()),
      multiplier: Object.fromEntries(draftBackoffMultiplier.entries()),
    };
    db.insert(schema.runtimeStates)
      .values({
        key: 'rate_limiter',
        value: JSON.stringify(data),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: schema.runtimeStates.key,
        set: {
          value: JSON.stringify(data),
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  } catch (err) {
    logger.warn(`[RateLimiter] Failed to save rate limiter states to db: ${err}`);
  }
}

class RateLimitMap extends Map<number, number> {
  override get(key: number): number | undefined {
    loadFromDbIfNeeded();
    return super.get(key);
  }
  override set(key: number, value: number): this {
    loadFromDbIfNeeded();
    super.set(key, value);
    return this;
  }
  setInternal(key: number, value: number): void {
    super.set(key, value);
  }
  override has(key: number): boolean {
    loadFromDbIfNeeded();
    return super.has(key);
  }
  override delete(key: number): boolean {
    loadFromDbIfNeeded();
    const res = super.delete(key);
    draftBackoffMultiplier.delete(key);
    return res;
  }
  override clear(): void {
    super.clear();
    draftBackoffMultiplier.clear();
    isLoaded = true; // prevent loading after clear
    try {
      const db = getDb();
      db.delete(schema.runtimeStates)
        .where(eq(schema.runtimeStates.key, 'rate_limiter'))
        .run();
    } catch {
      // ignore
    }
  }
  override [Symbol.iterator]() {
    loadFromDbIfNeeded();
    return super[Symbol.iterator]();
  }
  override entries() {
    loadFromDbIfNeeded();
    return super.entries();
  }
  override keys() {
    loadFromDbIfNeeded();
    return super.keys();
  }
  override values() {
    loadFromDbIfNeeded();
    return super.values();
  }
}

export const draftBackoffUntil = new RateLimitMap();

/** Start periodic cleanup of expired backoff entries. */
export function startBackoffCleanup(): void {
  if (_backoffCleanupTimer) return;
  _backoffCleanupTimer = setInterval(() => {
    loadFromDbIfNeeded();
    const now = Date.now();
    let changed = false;
    for (const [chatId, until] of draftBackoffUntil) {
      if (now >= until) {
        draftBackoffUntil.delete(chatId);
        changed = true;
      }
    }
    if (changed) {
      saveToDb();
    }
  }, BACKOFF_CLEANUP_INTERVAL);
  _backoffCleanupTimer.unref();
}

export function record429Backoff(chatId: number, retryAfterSec?: number): void {
  loadFromDbIfNeeded();
  const mult = Math.min((draftBackoffMultiplier.get(chatId) ?? 1) * 2, 8);
  draftBackoffMultiplier.set(chatId, mult);

  const baseWait = retryAfterSec ? retryAfterSec * 1000 : 1000;
  const waitMs = baseWait * mult + 100;
  const existingUntil = draftBackoffUntil.get(chatId) ?? 0;
  const nextUntil = Math.max(existingUntil, Date.now() + waitMs);
  draftBackoffUntil.set(chatId, nextUntil);
  saveToDb();
  logger.warn(`[429 BACKOFF] Dynamic rate-limit backoff set for chatId=${chatId}: wait ${waitMs}ms (mult=${mult})`);
}

export function reset429Backoff(chatId: number): void {
  loadFromDbIfNeeded();
  if (draftBackoffUntil.has(chatId) || draftBackoffMultiplier.has(chatId)) {
    draftBackoffUntil.delete(chatId);
    saveToDb();
  }
}

export function is429Error(err: any): boolean {
  if (!err) return false;
  if (err.error_code === 429 || err.status === 429) return true;
  if (err.parameters?.retry_after !== undefined) return true;
  if (err.payload?.parameters?.retry_after !== undefined) return true;
  const msg = String(err.message || err);
  return msg.includes('429') || msg.includes('Too Many Requests');
}

export function get429RetryAfter(err: any): number | undefined {
  if (typeof err?.parameters?.retry_after === 'number') return err.parameters.retry_after;
  if (typeof err?.payload?.parameters?.retry_after === 'number') return err.payload.parameters.retry_after;
  return undefined;
}
