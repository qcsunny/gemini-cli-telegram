/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file cache.ts
 * @description In-memory TTL cache for market data queries to prevent API quota exhaustion.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class MarketCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
    // Periodic sweep to drop expired entries and cap growth even when keys
    // are never re-read (prevents unbounded memory growth in long-running bots).
    const sweeper = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
    sweeper.unref?.();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
    // Enforce a hard size cap as a final safety net.
    if (this.cache.size > this.maxEntries) {
      const overflow = this.cache.size - this.maxEntries;
      const oldestKeys = Array.from(this.cache.keys()).slice(0, overflow);
      for (const key of oldestKeys) this.cache.delete(key);
    }
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
    if (this.cache.size > this.maxEntries) {
      this.sweepExpired();
    }
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const marketCache = new MarketCache();
