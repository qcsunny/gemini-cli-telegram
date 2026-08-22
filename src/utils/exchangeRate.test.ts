/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file exchangeRate.test.ts
 * @description Tests for the USD/CNY exchange rate provider: live fetch with
 * disk-cache persistence, default-rate fallback, fresh-rate short-circuiting,
 * stale-rate background refresh, and initExchangeRate().
 *
 * The module keeps process-wide state (cachedRate / _fetching / staleWarned),
 * so every test gets a freshly imported module via vi.resetModules() +
 * dynamic import. All I/O (node:fs, fetchWithTimeout, logger) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('./fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    pino: {},
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

/** The cache file path the module derives from its own location (project root). */
const EXPECTED_CACHE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.exchange-rate-cache.json',
);

interface FreshModules {
  exchangeRate: typeof import('./exchangeRate.js');
  fetchWithTimeout: MockFn;
  fs: { existsSync: MockFn; readFileSync: MockFn; writeFileSync: MockFn };
  logger: { debug: MockFn; info: MockFn; warn: MockFn; error: MockFn };
}

/**
 * Re-imports the module graph with a clean registry → fresh module-level state.
 *
 * The module under test is imported FIRST (and awaited) before its mocked
 * dependencies: importing 'node:fs' concurrently with a module that also
 * imports it races vitest's mocker, and the second importer can silently get
 * the real builtin instead of the mock.
 */
async function freshModules(): Promise<FreshModules> {
  vi.resetModules();
  const exchangeRate = await import('./exchangeRate.js');
  const [fwt, fsMod, loggerMod] = await Promise.all([
    import('./fetchWithTimeout.js'),
    import('node:fs'),
    import('./logger.js'),
  ]);
  return {
    exchangeRate,
    fetchWithTimeout: (fwt as unknown as { fetchWithTimeout: MockFn }).fetchWithTimeout,
    fs: fsMod as unknown as FreshModules['fs'],
    logger: (loggerMod as unknown as { logger: FreshModules['logger'] }).logger,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function okJson(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

describe('exchangeRate (USD/CNY provider)', () => {
  let mod: FreshModules;

  beforeEach(async () => {
    mod = await freshModules();
  });

  it('no cache + successful fetch: background refresh yields the live rate and writes the disk cache', async () => {
    mod.fs.existsSync.mockReturnValue(false);
    mod.fetchWithTimeout.mockResolvedValue(okJson({ rates: { CNY: 7.25 } }));

    // Synchronous read before the in-flight background refresh settles.
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);

    await waitFor(() => mod.exchangeRate.getCachedUsdToCnyRate() === 7.25);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.25);
    expect(mod.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mod.fetchWithTimeout.mock.calls[0]).toEqual([
      'https://api.exchangerate-api.com/v4/latest/USD',
      {},
      5000,
    ]);

    expect(mod.fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [file, raw] = mod.fs.writeFileSync.mock.calls[0] as [string, string, string];
    expect(file).toBe(EXPECTED_CACHE_FILE);
    const parsed = JSON.parse(raw) as { rate: number; fetchedAt: number };
    expect(parsed.rate).toBe(7.25);
    expect(typeof parsed.fetchedAt).toBe('number');
  });

  it('no cache + rejected fetch: stays on DEFAULT_RATE and never writes the cache', async () => {
    mod.fs.existsSync.mockReturnValue(false);
    mod.fetchWithTimeout.mockRejectedValue(new Error('network down'));

    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);
    await waitFor(() => mod.fetchWithTimeout.mock.calls.length >= 1);

    // Repeated reads keep the default; the failed refresh must not poison state.
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);
    expect(mod.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('no cache + not-ok HTTP response: stays on DEFAULT_RATE', async () => {
    mod.fs.existsSync.mockReturnValue(false);
    mod.fetchWithTimeout.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);
    await waitFor(() => mod.fetchWithTimeout.mock.calls.length >= 1);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);
    expect(mod.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('fresh in-memory rate: subsequent reads never trigger another fetch', async () => {
    mod.fs.existsSync.mockReturnValue(false);
    mod.fetchWithTimeout.mockResolvedValue(okJson({ rates: { CNY: 7.25 } }));

    mod.exchangeRate.getCachedUsdToCnyRate();
    await waitFor(() => mod.exchangeRate.getCachedUsdToCnyRate() === 7.25);
    const callsAfterWarmup = mod.fetchWithTimeout.mock.calls.length;
    expect(callsAfterWarmup).toBe(1);

    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.25);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.25);
    expect(mod.fetchWithTimeout.mock.calls.length).toBe(callsAfterWarmup);
  });

  it('fresh disk cache: served from disk without any fetch or rewrite', async () => {
    mod.fs.existsSync.mockReturnValue(true);
    mod.fs.readFileSync.mockReturnValue(
      JSON.stringify({ rate: 7.1, fetchedAt: Date.now() }),
    );

    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.1);
    // Second read is served from the in-memory copy, not the disk.
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.1);
    expect(mod.fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(mod.fetchWithTimeout).not.toHaveBeenCalled();
    expect(mod.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('stale disk cache: serves the old rate, refreshes in background, warns exactly once', async () => {
    mod.fs.existsSync.mockReturnValue(true);
    mod.fs.readFileSync.mockReturnValue(
      JSON.stringify({ rate: 6.9, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    mod.fetchWithTimeout.mockResolvedValue(okJson({ rates: { CNY: 7.3 } }));

    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(6.9);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(6.9); // refresh still in flight
    // Stale warning is throttled: only the first stale read logs it.
    expect(mod.logger.warn).toHaveBeenCalledTimes(1);
    expect(mod.logger.warn.mock.calls[0][0]).toContain('stale');

    await waitFor(() => mod.exchangeRate.getCachedUsdToCnyRate() === 7.3);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.3);
    expect(mod.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mod.fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('initExchangeRate kicks off the initial background fetch', async () => {
    mod.fs.existsSync.mockReturnValue(false);
    mod.fetchWithTimeout.mockResolvedValue(okJson({ rates: { CNY: 7.4 } }));

    mod.exchangeRate.initExchangeRate();
    // The fetch is in flight: reads still fall back to the default.
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7);
    expect(mod.fetchWithTimeout).toHaveBeenCalledTimes(1);

    await waitFor(() => mod.exchangeRate.getCachedUsdToCnyRate() === 7.4);
    expect(mod.exchangeRate.getCachedUsdToCnyRate()).toBe(7.4);
    expect(mod.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});