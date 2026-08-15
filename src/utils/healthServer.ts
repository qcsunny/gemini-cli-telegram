/**
 * @file healthServer.ts
 * @description Minimal HTTP health-check server for the daemon.
 * No dependencies beyond Node.js built-ins. Provides a JSON /health endpoint
 * for monitoring (Docker health checks, load balancers, systemd probes).
 */

import * as http from 'node:http';
import { logger } from './logger.js';

import { handleStockRoutes } from '../stock/api/stockRoutes.js';

let server: http.Server | null = null;
const startTime = Date.now();

interface HealthStatus {
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
    void (async () => {
      const handled = await handleStockRoutes(req, res);
      if (handled) return;

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
    } else if (req.url?.startsWith('/chart') && req.method === 'GET') {
      const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const symbol = (urlObj.searchParams.get('symbol') || 'NVDA').toUpperCase().replace(/[^A-Z0-9-]/g, '');
      const tvSymbol = symbol.includes('BTC') || symbol.includes('ETH') ? `BINANCE:${symbol.replace('-', '')}USDT` : `NASDAQ:${symbol}`;
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${symbol} Realtime Chart</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #131722; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #tv_chart_container { width: 100%; height: 100%; }
  </style>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
  <div id="tv_chart_container"></div>
  <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
  <script type="text/javascript">
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
    new TradingView.widget({
      "autosize": true,
      "symbol": "${tvSymbol}",
      "interval": "D",
      "timezone": "Etc/UTC",
      "theme": "dark",
      "style": "1",
      "locale": "en",
      "toolbar_bg": "#f1f3f6",
      "enable_publishing": false,
      "allow_symbol_change": true,
      "container_id": "tv_chart_container"
    });
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not Found\n');
      }
    })().catch((error) => {
      logger.error(`[healthServer] Request failed: ${error}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
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
