/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file stockRoutes.ts
 * @description HTTP API Endpoints and Mini App static HTML route handlers for Stock Market feature.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { marketService } from '../service/quote.js';
import { getStockApiToken } from '../../config/userConfig.js';
import { renderStockAppHtml } from './templates/stockAppHtml.js';

const MAX_BODY_BYTES = 16 * 1024;

/** Read the full request body as a string, enforcing a size limit. */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  let bodyStr = '';
  let bodyBytes = 0;
  for await (const chunk of req) {
    bodyBytes += (chunk as Buffer).length;
    if (bodyBytes > maxBytes) throw new Error('too_large');
    bodyStr += chunk;
  }
  return bodyStr;
}

export async function handleStockRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || 'GET';

  const isWatchlistRoute = url.startsWith('/api/watchlist');
  if (isWatchlistRoute) {
    const expected = getStockApiToken();
    if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
  }

  // 1. Mini App Unified Page: GET /app or GET /app?symbol=NVDA
  if (url.startsWith('/app') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStockAppHtml());
    return true;
  }

  // 2. REST API: GET /api/stocks/{symbol} or /api/stocks/{symbol}/quote
  //    (must not swallow /api/stocks/search — that is route 4 below)
  const decodedUrl = decodeURIComponent(url);
  const stockMatch = decodedUrl.match(/^\/api\/stocks\/([^/]+)(\/quote)?$/);
  if (stockMatch && method === 'GET' && !url.includes('/candles') && !url.includes('/search')) {
    const symbol = stockMatch[1].trim();
    const quote = await marketService.getQuote(symbol);
    if (!quote) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Symbol not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quote));
    return true;
  }

  // 3. REST API: GET /api/stocks/{symbol}/candles?interval=5m&range=1d
  const candleMatch = url.match(/^\/api\/stocks\/([A-Za-z0-9-]+)\/candles/);
  if (candleMatch && method === 'GET') {
    const symbol = candleMatch[1].toUpperCase();
    const host = req.headers?.host || '127.0.0.1';
    const urlObj = new URL(url, `http://${host}`);
    const interval = urlObj.searchParams.get('interval') || '5m';
    const range = urlObj.searchParams.get('range') || '1d';

    const candles = await marketService.getCandles(symbol, interval, range);
    if (!candles) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Candle data not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(candles));
    return true;
  }

  // 4. REST API: GET /api/stocks/search?q=NVDA
  if (url.startsWith('/api/stocks/search') && method === 'GET') {
    const host = req.headers?.host || '127.0.0.1';
    const urlObj = new URL(url, `http://${host}`);
    const q = urlObj.searchParams.get('q') || '';
    const results = await marketService.searchSymbols(q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return true;
  }

  // 5. REST API: GET /api/watchlist
  if (url.startsWith('/api/watchlist') && method === 'GET') {
    const host = req.headers?.host || '127.0.0.1';
    const urlObj = new URL(url, `http://${host}`);
    const userId = Number(urlObj.searchParams.get('userId') || '0');
    const { getUserWatchlist } = await import('../service/watchlist.js');
    const symbols = await getUserWatchlist(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ userId, watchlist: symbols }));
    return true;
  }

  // 6. REST API: POST /api/watchlist
  if (url.startsWith('/api/watchlist') && method === 'POST') {
    let bodyStr: string;
    try {
      bodyStr = await readJsonBody(req);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      return true;
    }
    try {
      const { userId, symbol } = JSON.parse(bodyStr);
      const { addToWatchlist } = await import('../service/watchlist.js');
      const ok = await addToWatchlist(Number(userId), String(symbol));
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return true;
  }

  // 7. REST API: DELETE /api/watchlist
  if (url.startsWith('/api/watchlist') && method === 'DELETE') {
    let bodyStr: string;
    try {
      bodyStr = await readJsonBody(req);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      return true;
    }
    try {
      const { userId, symbol } = JSON.parse(bodyStr);
      const { removeFromWatchlist } = await import('../service/watchlist.js');
      const ok = await removeFromWatchlist(Number(userId), String(symbol));
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return true;
  }

  return false; // Not handled by stock routes
}
