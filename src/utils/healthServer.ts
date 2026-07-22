/**
 * @file healthServer.ts
 * @description Minimal HTTP health-check server for the daemon.
 * No dependencies beyond Node.js built-ins. Provides a JSON /health endpoint
 * for monitoring (Docker health checks, load balancers, systemd probes).
 */

import * as http from 'node:http';
import { logger } from './logger.js';

let server: http.Server | null = null;
const startTime = Date.now();

export interface HealthStatus {
  status: 'ok';
  uptime: number;
  uptimeHuman: string;
}

/**
 * Starts a minimal HTTP server on the given port serving a /health endpoint.
 * Returns immediately; callers should await a small delay or check readiness
 * before relying on the server.
 */
export function startHealthServer(port: number): void {
  if (server) {
    logger.warn(`[healthServer] Already running on port ${port}, ignoring duplicate start`);
    return;
  }

  server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const now = Date.now();
      const uptimeMs = now - startTime;
      const body: HealthStatus = {
        status: 'ok',
        uptime: uptimeMs,
        uptimeHuman: formatUptime(uptimeMs),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body) + '\n');
    } else {
      res.writeHead(404);
      res.end('Not Found\n');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`[healthServer] Listening on http://127.0.0.1:${port}/health`);
  });

  server.on('error', (err) => {
    logger.error(`[healthServer] Failed to start on port ${port}: ${err}`);
    server = null;
  });
}

/**
 * Stops the health HTTP server. Idempotent.
 */
export function stopHealthServer(): void {
  if (!server) return;
  server.close();
  server = null;
  logger.info('[healthServer] Stopped');
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}
