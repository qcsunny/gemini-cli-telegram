/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file symbolHelper.ts
 * @description Helper utilities for mapping global stock tickers (A-Share, HKEX, US, Crypto)
 * to official TradingView symbol identifiers for chart embedding.
 */

export function buildTradingViewSymbol(symbol: string, market?: string): string {
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  const mkt = (market || '').toUpperCase();

  // 1. Crypto Market
  if (mkt === 'CRYPTO' || cleanSym === 'BTC' || cleanSym === 'ETH' || cleanSym === 'SOL' || cleanSym === 'DOGE') {
    return `BINANCE:${cleanSym.replace('-', '')}USDT`;
  }

  // 2. A-Share (SSE / SZSE)
  // e.g. 600519 -> SSE:600519, 000001 -> SZSE:000001
  const isAshare = /^(SH|SZ)?\d{6}$/i.test(cleanSym);
  if (isAshare || mkt === 'SSE' || mkt === 'SZSE') {
    const digits = cleanSym.replace(/^(SH|SZ)/i, '');
    if (mkt === 'SSE' || digits.startsWith('6') || digits.startsWith('9')) {
      return `SSE:${digits}`;
    }
    return `SZSE:${digits}`;
  }

  // 3. HKEX (Hong Kong Stock Exchange)
  // e.g. 00700 -> HKEX:700, 09988 -> HKEX:9988
  const isHK = /^(HK)?\d{5}$/i.test(cleanSym);
  if (isHK || mkt === 'HKEX') {
    const digits = cleanSym.replace(/^HK/i, '').replace(/^0+/, ''); // TradingView HKEX omits leading zeroes (e.g. HKEX:700)
    return `HKEX:${digits}`;
  }

  // 4. US Stock Market (NASDAQ / NYSE)
  if (mkt === 'NYSE') {
    return `NYSE:${cleanSym}`;
  }
  return `NASDAQ:${cleanSym}`;
}
