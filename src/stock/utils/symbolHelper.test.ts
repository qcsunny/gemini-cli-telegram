/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildTradingViewSymbol } from './symbolHelper.js';

describe('buildTradingViewSymbol', () => {
  it('maps well-known crypto tickers to BINANCE pairs', () => {
    expect(buildTradingViewSymbol('BTC')).toBe('BINANCE:BTCUSDT');
    expect(buildTradingViewSymbol('eth')).toBe('BINANCE:ETHUSDT');
    expect(buildTradingViewSymbol('SOL')).toBe('BINANCE:SOLUSDT');
    expect(buildTradingViewSymbol('DOGE')).toBe('BINANCE:DOGEUSDT');
  });

  it('maps CRYPTO market symbols to BINANCE pairs and strips dashes', () => {
    expect(buildTradingViewSymbol('LINK', 'CRYPTO')).toBe('BINANCE:LINKUSDT');
    expect(buildTradingViewSymbol('WBTC', 'CRYPTO')).toBe('BINANCE:WBTCUSDT');
  });

  it('strips $ prefix and trims whitespace', () => {
    expect(buildTradingViewSymbol('$BTC')).toBe('BINANCE:BTCUSDT');
    expect(buildTradingViewSymbol('  AAPL  ')).toBe('NASDAQ:AAPL');
  });

  it('maps 6-digit A-share codes to SSE (6/9 prefix) or SZSE', () => {
    expect(buildTradingViewSymbol('600519')).toBe('SSE:600519');
    expect(buildTradingViewSymbol('900901')).toBe('SSE:900901');
    expect(buildTradingViewSymbol('000001')).toBe('SZSE:000001');
    expect(buildTradingViewSymbol('300750')).toBe('SZSE:300750');
  });

  it('respects explicit SH/SZ prefixes and SSE/SZSE markets', () => {
    expect(buildTradingViewSymbol('SH600519')).toBe('SSE:600519');
    expect(buildTradingViewSymbol('SZ000001')).toBe('SZSE:000001');
    // market hint overrides digit heuristic for non-6/9 prefixes
    expect(buildTradingViewSymbol('000001', 'SSE')).toBe('SSE:000001');
    expect(buildTradingViewSymbol('123', 'SZSE')).toBe('SZSE:123');
    // but the 6/9 digit prefix always wins over a SZSE hint
    expect(buildTradingViewSymbol('600519', 'SZSE')).toBe('SSE:600519');
  });

  it('maps 5-digit HK codes to HKEX without leading zeroes', () => {
    expect(buildTradingViewSymbol('00700')).toBe('HKEX:700');
    expect(buildTradingViewSymbol('09988')).toBe('HKEX:9988');
    expect(buildTradingViewSymbol('HK00700')).toBe('HKEX:700');
    expect(buildTradingViewSymbol('9988', 'HKEX')).toBe('HKEX:9988');
  });

  it('maps US symbols to NYSE when market says so, else NASDAQ', () => {
    expect(buildTradingViewSymbol('JPM', 'NYSE')).toBe('NYSE:JPM');
    expect(buildTradingViewSymbol('AAPL')).toBe('NASDAQ:AAPL');
    expect(buildTradingViewSymbol('tsla')).toBe('NASDAQ:TSLA');
  });
});