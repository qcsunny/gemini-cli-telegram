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

export async function handleStockRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || 'GET';

  // 1. Mini App Unified Page: GET /app or GET /app?symbol=NVDA
  if ((url.startsWith('/app') || url.startsWith('/chart')) && method === 'GET') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Stock Market Terminal</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    :root {
      --bg-color: var(--tg-theme-bg-color, #17212b);
      --text-color: var(--tg-theme-text-color, #f5f5f5);
      --hint-color: var(--tg-theme-hint-color, #708499);
      --button-color: var(--tg-theme-button-color, #5288c1);
      --button-text-color: var(--tg-theme-button-text-color, #ffffff);
      --card-bg: var(--tg-theme-secondary-bg-color, #232e3c);
      --up-color: #26a69a;
      --down-color: #ef5350;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg-color); color: var(--text-color); padding: 16px; min-height: 100vh; display: flex; flex-direction: column; gap: 16px; }
    .header { display: flex; justify-content: space-between; align-items: center; background: var(--card-bg); padding: 14px 18px; border-radius: 12px; }
    .symbol-info h1 { font-size: 22px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .symbol-info .name { font-size: 13px; color: var(--hint-color); margin-top: 2px; }
    .price-box { text-align: right; }
    .price { font-size: 24px; font-weight: 700; }
    .change { font-size: 14px; font-weight: 600; margin-top: 2px; }
    .up { color: var(--up-color); }
    .down { color: var(--down-color); }
    .controls { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
    .tab-btn { background: var(--card-bg); color: var(--text-color); border: 1px solid rgba(255,255,255,0.1); padding: 8px 14px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; }
    .tab-btn.active { background: var(--button-color); color: var(--button-text-color); border-color: var(--button-color); }
    #chart_container { width: 100%; height: 320px; background: var(--card-bg); border-radius: 12px; overflow: hidden; position: relative; }
    .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .detail-card { background: var(--card-bg); padding: 12px 14px; border-radius: 10px; }
    .detail-card .label { font-size: 12px; color: var(--hint-color); }
    .detail-card .val { font-size: 15px; font-weight: 600; margin-top: 4px; }
    .badge { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); margin-left: 6px; }
    .actions { display: flex; gap: 10px; margin-top: auto; }
    .action-btn { flex: 1; padding: 12px; background: var(--button-color); color: var(--button-text-color); border: none; border-radius: 10px; font-weight: 600; font-size: 14px; cursor: pointer; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="symbol-info">
      <h1 id="sym_title">NVDA <span class="badge" id="sym_market">NASDAQ</span></h1>
      <div class="name" id="sym_name">NVIDIA Corporation</div>
    </div>
    <div class="price-box">
      <div class="price" id="sym_price">$0.00</div>
      <div class="change" id="sym_change">+0.00 (+0.00%)</div>
    </div>
  </div>

  <div class="controls">
    <button class="tab-btn active" onclick="switchRange('1D')">1D</button>
    <button class="tab-btn" onclick="switchRange('5D')">5D</button>
    <button class="tab-btn" onclick="switchRange('1M')">1M</button>
    <button class="tab-btn" onclick="switchRange('3M')">3M</button>
    <button class="tab-btn" onclick="switchRange('1Y')">1Y</button>
  </div>

  <div id="chart_container"></div>

  <div class="details-grid">
    <div class="detail-card"><div class="label">Open</div><div class="val" id="d_open">--</div></div>
    <div class="detail-card"><div class="label">Previous Close</div><div class="val" id="d_prev">--</div></div>
    <div class="detail-card"><div class="label">Day High</div><div class="val" id="d_high">--</div></div>
    <div class="detail-card"><div class="label">Day Low</div><div class="val" id="d_low">--</div></div>
  </div>

  <div class="actions">
    <button class="action-btn" onclick="toggleWatchlist()">⭐ Add to Watchlist</button>
    <button class="action-btn" style="background: rgba(255,255,255,0.15);" onclick="setAlert()">🔔 Price Alert</button>
  </div>

  <script>
    let currentSymbol = 'NVDA';
    let chart, candleSeries;

    // Telegram WebApp Initialization & Start Param Parsing (Deep Link)
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
      const startParam = window.Telegram.WebApp.initDataUnsafe?.start_param;
      if (startParam) {
        currentSymbol = startParam.toUpperCase();
      }
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('symbol')) {
      currentSymbol = urlParams.get('symbol').toUpperCase();
    }

    function initChart() {
      const container = document.getElementById('chart_container');
      chart = LightweightCharts.createChart(container, {
        layout: { backgroundColor: 'transparent', textColor: '#708499' },
        grid: { vertLines: { color: 'rgba(255, 255, 255, 0.05)' }, horzLines: { color: 'rgba(255, 255, 255, 0.05)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: { borderColor: 'rgba(255, 255, 255, 0.1)' }
      });
      candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350'
      });
    }

    async function loadQuote() {
      try {
        const res = await fetch('/api/stocks/' + currentSymbol);
        const q = await res.json();
        if (q && q.symbol) {
          document.getElementById('sym_title').childNodes[0].nodeValue = q.symbol + ' ';
          document.getElementById('sym_market').innerText = q.market;
          document.getElementById('sym_name').innerText = q.name;
          document.getElementById('sym_price').innerText = '$' + q.price.toFixed(2);
          const sign = q.change >= 0 ? '+' : '';
          const changeElem = document.getElementById('sym_change');
          changeElem.innerText = sign + q.change.toFixed(2) + ' (' + sign + q.changePercent.toFixed(2) + '%)';
          changeElem.className = 'change ' + (q.change >= 0 ? 'up' : 'down');

          document.getElementById('d_open').innerText = q.open ? '$' + q.open.toFixed(2) : '--';
          document.getElementById('d_prev').innerText = q.previousClose ? '$' + q.previousClose.toFixed(2) : '--';
          document.getElementById('d_high').innerText = q.high ? '$' + q.high.toFixed(2) : '--';
          document.getElementById('d_low').innerText = q.low ? '$' + q.low.toFixed(2) : '--';
        }
      } catch (err) {
        console.error('Failed to load quote', err);
      }
    }

    async function loadCandles(range = '1D') {
      try {
        const res = await fetch('/api/stocks/' + currentSymbol + '/candles?range=' + range);
        const candles = await res.json();
        if (candles && candles.data) {
          candleSeries.setData(candles.data);
          chart.timeScale().fitContent();
        }
      } catch (err) {
        console.error('Failed to load candles', err);
      }
    }

    function switchRange(range) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      loadCandles(range);
    }

    function toggleWatchlist() {
      alert('Added ' + currentSymbol + ' to Watchlist!');
    }

    function setAlert() {
      alert('Price Alert set for ' + currentSymbol);
    }

    window.onload = () => {
      initChart();
      loadQuote();
      loadCandles('1D');
    };
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  // 2. REST API: GET /api/stocks/{symbol} or /api/stocks/{symbol}/quote
  const stockMatch = url.match(/^\/api\/stocks\/([A-Za-z0-9-]+)(\/quote)?$/);
  if (stockMatch && method === 'GET') {
    const symbol = stockMatch[1].toUpperCase();
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
    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
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

  return false; // Not handled by stock routes
}
