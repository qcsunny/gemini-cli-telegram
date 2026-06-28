/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A simple TTL-based cache for storing original Markdown messages.
 * This allows the /save command to retrieve the unformatted source
 * instead of the rendered text from Telegram.
 */
export class MessageCache {
  private cache = new Map<number, { text: string; timestamp: number }>();
  private readonly ttl: number;
  private readonly maxSize: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000, maxSize = 1000) {
    this.ttl = ttlMs;
    this.maxSize = maxSize;
  }

  set(messageId: number, text: string): void {
    // Evict oldest if full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    this.cache.set(messageId, {
      text,
      timestamp: Date.now(),
    });

    // Cleanup expired entries occasionally
    if (Math.random() < 0.1) {
      this.cleanup();
    }
  }

  get(messageId: number): string | null {
    const entry = this.cache.get(messageId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(messageId);
      return null;
    }

    return entry.text;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    return this.cache.size;
  }

  get capacity(): number {
    return this.maxSize;
  }
}

export const messageCache = new MessageCache();
