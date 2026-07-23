/**
 * @file backendHealth.ts
 * @description Backend health tracking with exponential backoff cooldown.
 * Each backend channel (agy, deepseek, web2api) carries a failCount and cooldownUntil timestamp.
 * Before attempting a model route, check whether its backend is currently in cooldown.
 */

import { logger } from '../utils/logger.js';

// ── Backend Health Tracker ──────────────────────────────────────────────────

interface BackendHealth {
  failCount: number;
  cooldownUntil: number;
}

const backendHealth = new Map<string, BackendHealth>();
const COOLDOWN_INITIAL_MS = 30_000;   // 30 seconds
const COOLDOWN_MAX_MS = 300_000;      // 5 minutes

/**
 * Returns true if the backend channel is available (not in cooldown).
 * If the cooldown has expired, the entry is deleted and true is returned.
 */
export function isBackendAvailable(channel: string | null): boolean {
  if (!channel) return true;
  const health = backendHealth.get(channel);
  if (!health) return true;
  if (Date.now() >= health.cooldownUntil) {
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
  const prev = backendHealth.get(channel);
  const failCount = (prev?.failCount ?? 0) + 1;
  const cooldownMs = Math.min(COOLDOWN_INITIAL_MS * Math.pow(2, failCount - 1), COOLDOWN_MAX_MS);
  backendHealth.set(channel, { failCount, cooldownUntil: Date.now() + cooldownMs });
  logger.warn(`[BackendHealth] Backend "${channel}" marked unavailable for ${cooldownMs}ms (fail #${failCount})`);
}

/**
 * Marks a backend channel as healthy, clearing any cooldown.
 * Called on successful model execution.
 */
export function markBackendHealthy(channel: string | null): void {
  if (!channel) return;
  backendHealth.delete(channel);
}

/**
 * Clears all backend health state. Used by tests and SIGHUP handler.
 */
export function clearBackendHealth(): void {
  backendHealth.clear();
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

/** Returns true if the error indicates rate limiting or upstream unavailability. */
export function isRateLimitOrUnavailableError(stderr: string, output: string): boolean {
  const lowerStderr = stderr.toLowerCase();
  const lowerOutput = output.toLowerCase();

  const keywords = [
    '429',
    'quota',
    'exhausted',
    'rate_limit',
    'rate limit',
    'limit exceeded',
    'resource_exhausted',
    'unavailable',
    'overloaded',
    'capacity',
  ];

  return keywords.some(keyword => lowerStderr.includes(keyword) || lowerOutput.includes(keyword));
}
