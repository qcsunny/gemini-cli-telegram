/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { handleStockRoutes } from './api/stockRoutes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('Stock REST API & Mini App Routes Unit Tests', () => {
  it('should handle /api/stocks/NVDA quote endpoint', async () => {
    let responseData = '';
    let statusCode = 0;
    const req = { url: '/api/stocks/NVDA', method: 'GET' } as IncomingMessage;
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (data: string) => { responseData = data; },
    } as unknown as ServerResponse;

    const handled = await handleStockRoutes(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const json = JSON.parse(responseData);
    expect(json.symbol).toBe('NVDA');
  });

  it('should handle /api/stocks/NVDA/candles endpoint', async () => {
    let responseData = '';
    let statusCode = 0;
    const req = { url: '/api/stocks/NVDA/candles?range=1d', method: 'GET' } as IncomingMessage;
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (data: string) => { responseData = data; },
    } as unknown as ServerResponse;

    const handled = await handleStockRoutes(req, res);
    expect(handled).toBe(true);
    expect(statusCode).toBe(200);
    const json = JSON.parse(responseData);
    expect(json.symbol).toBe('NVDA');
    expect(json.data.length).toBeGreaterThan(0);
  });
});
