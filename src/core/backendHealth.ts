/**
 * @file backendHealth.ts
 * @description Backend health tracking with exponential backoff cooldown.
 * Each backend channel (agy, deepseek, web2api) carries a failCount and cooldownUntil timestamp.
 * Before attempting a model route, check whether its backend is currently in cooldown.
 */

import { logger } from '../utils/logger.js';
import { getDb, schema } from '../db/index.js';
import { eq, like } from 'drizzle-orm';

// ── Backend Health Tracker ──────────────────────────────────────────────────

interface BackendHealth {
  failCount: number;
  cooldownUntil: number;
}

const backendHealth = new Map<string, BackendHealth>();
const COOLDOWN_INITIAL_MS = 30_000;   // 30 seconds
const COOLDOWN_MAX_MS = 300_000;      // 5 minutes

/**
 * Runtime state DB key prefix for backend health rows.
 * Each channel is persisted as its own row (key = `${STORAGE_KEY_PREFIX}${channel}`)
 * so concurrent instances can update only the channels they care about without
 * clobbering the others' state.
 */
const STORAGE_KEY_PREFIX = 'backend_health:';

/** Tracks which storage keys were last persisted, for incremental writes. */
const lastPersistedKeys = new Set<string>();
let isLoaded = false;

function loadFromDbIfNeeded(): void {
  if (isLoaded) return;
  isLoaded = true;
  try {
    const db = getDb();
    // New format: one row per channel, keyed `backend_health:<channel>`.
    const rows = db.select()
      .from(schema.runtimeStates)
      .where(like(schema.runtimeStates.key, `${STORAGE_KEY_PREFIX}%`))
      .all();
    for (const row of rows) {
      const channel = row.key.slice(STORAGE_KEY_PREFIX.length);
      try {
        backendHealth.set(channel, JSON.parse(row.value) as BackendHealth);
        lastPersistedKeys.add(row.key);
      } catch {
        // skip malformed rows
      }
    }
    // Backwards-compatible load: a legacy single row whose whole map was
    // JSON-serialized under the "backend_health" key (pre-incremental format).
    const legacy = db.select()
      .from(schema.runtimeStates)
      .where(eq(schema.runtimeStates.key, STORAGE_KEY_PREFIX.slice(0, -1)))
      .get();
    if (legacy?.value) {
      try {
        const data = JSON.parse(legacy.value) as Record<string, BackendHealth>;
        for (const [k, v] of Object.entries(data)) {
          backendHealth.set(k, v);
          lastPersistedKeys.add(STORAGE_KEY_PREFIX + k);
        }
        // Drop the legacy row; the per-channel rows persist from now on.
        db.delete(schema.runtimeStates)
          .where(eq(schema.runtimeStates.key, STORAGE_KEY_PREFIX.slice(0, -1)))
          .run();
      } catch {
        // ignore malformed legacy payload
      }
    }
  } catch (err) {
    logger.warn(`[BackendHealth] Failed to load backend health from db: ${err}`);
  }
}

function saveToDb(): void {
  try {
    const db = getDb();
    const nowStr = new Date().toISOString();

    // Incremental persistence: only upsert channels whose state changed since
    // the last save, so concurrent instances never clobber each other's rows.
    for (const [channel, value] of backendHealth.entries()) {
      const storageKey = STORAGE_KEY_PREFIX + channel;
      if (!lastPersistedKeys.has(storageKey)) {
        const valueStr = JSON.stringify(value);
        db.insert(schema.runtimeStates)
          .values({
            key: storageKey,
            value: valueStr,
            updatedAt: nowStr,
          })
          .onConflictDoUpdate({
            target: schema.runtimeStates.key,
            set: {
              value: valueStr,
              updatedAt: nowStr,
            },
          })
          .run();
        lastPersistedKeys.add(storageKey);
      }
    }

    // Clean up DB rows for channels that no longer exist in memory.
    for (const storageKey of lastPersistedKeys) {
      const channel = storageKey.slice(STORAGE_KEY_PREFIX.length);
      if (!backendHealth.has(channel)) {
        db.delete(schema.runtimeStates)
          .where(eq(schema.runtimeStates.key, storageKey))
          .run();
        lastPersistedKeys.delete(storageKey);
      }
    }
  } catch (err) {
    logger.warn(`[BackendHealth] Failed to persist backend health to db: ${err}`);
  }
}

/**
 * Returns true if the backend channel is available (not in cooldown).
 * If the cooldown has expired, the entry is deleted and true is returned.
 */
export function isBackendAvailable(channel: string | null): boolean {
  if (!channel) return true;
  loadFromDbIfNeeded();
  const health = backendHealth.get(channel);
  if (!health) return true;
  if (Date.now() >= health.cooldownUntil) {
    // Read paths must not write to the DB: just drop the expired entry from the
    // in-memory map. The next write (fail/healthy) persists that state.
    backendHealth.delete(channel);
    return true;
  }
  return false;
}

/**
 * Marks a backend channel as failed and enters exponential backoff cooldown.
 * Cooldown doubles per failure: 30s, 60s, 120s, 240s, 300s (capped at 5 min).
 */
export function markBackendFailed(channel: string | null): void {
  if (!channel) return;
  loadFromDbIfNeeded();
  const prev = backendHealth.get(channel);
  const failCount = (prev?.failCount ?? 0) + 1;
  const cooldownMs = Math.min(COOLDOWN_INITIAL_MS * Math.pow(2, failCount - 1), COOLDOWN_MAX_MS);
  backendHealth.set(channel, { failCount, cooldownUntil: Date.now() + cooldownMs });
  saveToDb();
  logger.warn(`[BackendHealth] Backend "${channel}" marked unavailable for ${cooldownMs}ms (fail #${failCount})`);
}

/**
 * Marks a backend channel as healthy, clearing any cooldown.
 * Called on successful model execution.
 */
export function markBackendHealthy(channel: string | null): void {
  if (!channel) return;
  loadFromDbIfNeeded();
  if (backendHealth.has(channel)) {
    backendHealth.delete(channel);
    saveToDb();
  }
}

/**
 * Clears all backend health state. Used by tests and SIGHUP handler.
 */
export function clearBackendHealth(): void {
  backendHealth.clear();
  isLoaded = true; // prevent loading after clear
  let db: ReturnType<typeof getDb> | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }
  if (db) {
    try {
      // Delete the persisted rows for every tracked key.
      for (const storageKey of lastPersistedKeys) {
        db.delete(schema.runtimeStates)
          .where(eq(schema.runtimeStates.key, storageKey))
          .run();
      }
    } catch (err) {
      // ignore
    }
  }
  lastPersistedKeys.clear();
}


// ── Error Classification ────────────────────────────────────────────────────

/** Returns true if the error indicates the backend service itself is unreachable. */
export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ECONNRESET' || e.code === 'ENETUNREACH' || e.code === 'ETIMEDOUT') return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('socket hang up') || msg.includes('connection refused') || msg.includes('econnrefused');
}