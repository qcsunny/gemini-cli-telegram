/**
 * @file backendHealth.ts
 * @description Backend health tracking with exponential backoff cooldown.
 * Each backend channel (agy, deepseek, web2api) carries a failCount and cooldownUntil timestamp.
 * Before attempting a model route, check whether its backend is currently in cooldown.
 */

import { logger } from '../utils/logger.js';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

// ── Backend Health Tracker ──────────────────────────────────────────────────

interface BackendHealth {
  failCount: number;
  cooldownUntil: number;
}

const backendHealth = new Map<string, BackendHealth>();
const COOLDOWN_INITIAL_MS = 30_000;   // 30 seconds
const COOLDOWN_MAX_MS = 300_000;      // 5 minutes

let isLoaded = false;

function loadFromDbIfNeeded(): void {
  if (isLoaded) return;
  isLoaded = true;
  try {
    const db = getDb();
    const row = db.select().from(schema.runtimeStates).where(eq(schema.runtimeStates.key, 'backend_health')).get();
    if (row?.value) {
      const data = JSON.parse(row.value);
      for (const [k, v] of Object.entries(data)) {
        backendHealth.set(k, v as BackendHealth);
      }
    }
  } catch (err) {
    logger.warn(`[BackendHealth] Failed to load backend health from db: ${err}`);
  }
}

function saveToDb(): void {
  try {
    const db = getDb();
    const data = Object.fromEntries(backendHealth.entries());
    db.insert(schema.runtimeStates)
      .values({
        key: 'backend_health',
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
    logger.warn(`[BackendHealth] Failed to save backend health to db: ${err}`);
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
    backendHealth.delete(channel);
    saveToDb();
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
  try {
    const db = getDb();
    db.delete(schema.runtimeStates)
      .where(eq(schema.runtimeStates.key, 'backend_health'))
      .run();
  } catch (err) {
    // ignore
  }
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
