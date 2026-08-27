/**
 * @file web2apiHealth.ts
 * @description Periodic health probe for the Web2API backend.
 *
 * The existing `backendHealth` system is reactive — it only marks a backend
 * failed after a real request fails. But the Go-side Web2API service can
 * degrade silently (cookie death, model downgrade, abuse wall), and the first
 * user to hit the degraded service pays the penalty of discovering it.
 *
 * This module proactively polls `GET <base>/health` every 45 s. The Go side's
 * `/health` endpoint aggregates cookie rotation + downgrade verdicts and needs
 * no API key, so it's safe to call without auth. On HTTP 503 (degraded), we
 * call `markBackendFailed('web2api')` so the fallback chain skips it; on 200
 * we call `markBackendHealthy('web2api')` to clear any stale cooldown.
 */

import * as http from 'node:http';
import { logger } from '../utils/logger.js';
import { getBackendUrl } from '../config/userConfig.js';
import { markBackendFailed, markBackendHealthy } from './backendHealth.js';

const POLL_INTERVAL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 5_000;
const CHANNEL = 'web2api';

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Derives the health endpoint URL from the configured Web2API base URL.
 * `http://127.0.0.1:8083/v1` → `http://127.0.0.1:8083/health`.
 */
function healthUrl(): string | null {
  const base = getBackendUrl('web2api');
  if (!base) return null;
  // Strip trailing /v1 (or any path) and append /health
  const url = new URL(base);
  return `${url.protocol}//${url.host}/health`;
}

/** One probe cycle: GET /health, update backend health accordingly. */
function probe(): void {
  const url = healthUrl();
  if (!url) return; // Web2API not configured — skip silently

  const parsed = new URL(url);
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname,
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
  }, (res) => {
    // Drain the body so the socket can be reused
    res.resume();
    if (res.statusCode === 200) {
      markBackendHealthy(CHANNEL);
    } else if (res.statusCode === 503) {
      logger.warn(`[Web2ApiHealth] /health returned 503 — marking backend degraded`);
      markBackendFailed(CHANNEL);
    } else {
      logger.warn(`[Web2ApiHealth] /health returned HTTP ${res.statusCode}`);
    }
  });

  req.on('error', (err: NodeJS.ErrnoException) => {
    // ECONNREFUSED = service not running; treat like a failed backend
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      logger.warn(`[Web2ApiHealth] Web2API unreachable (${err.code}) — marking backend failed`);
      markBackendFailed(CHANNEL);
    } else {
      logger.debug(`[Web2ApiHealth] Probe error: ${err.message}`);
    }
  });

  req.on('timeout', () => {
    logger.warn(`[Web2ApiHealth] /health probe timed out — marking backend failed`);
    req.destroy();
    markBackendFailed(CHANNEL);
  });

  req.end();
}

/** Starts the periodic health probe. Safe to call multiple times — subsequent calls are no-ops. */
export function startWeb2ApiHealthProbe(): void {
  if (timer) return;
  // Probe immediately on start so a degraded service is caught before the first user request.
  probe();
  timer = setInterval(probe, POLL_INTERVAL_MS);
  timer.unref?.(); // Don't keep the event loop alive solely for this timer
  logger.info(`[Web2ApiHealth] Started periodic /health probe (every ${POLL_INTERVAL_MS / 1000}s)`);
}

/** Stops the periodic health probe. */
export function stopWeb2ApiHealthProbe(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[Web2ApiHealth] Stopped periodic /health probe');
  }
}
