/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file messageCache.ts
 * @description In-memory TTL cache storing unformatted Markdown messages and reply contexts.
 * Enables exact Markdown source retrieval for the /save command instead of extracting rendered HTML from Telegram.
 */

/**
 * Contextual metadata associated with a saved message reply, including title and separate thinking/answer blocks.
 */
export interface ReplyContext {
  title?: string;
  answerMarkdown: string;
  thinkingMarkdown: string;
}

/**
 * A simple TTL-based cache for storing original Markdown messages.
 * This allows the /save command to retrieve the unformatted source
 * instead of the rendered text from Telegram.
 */
export class MessageCache {
  private cache = new Map<number, { text: string; replyContext?: ReplyContext; timestamp: number }>();
  private readonly ttl: number;
  private readonly maxSize: number;

  /**
   * @param ttlMs - Time-to-live for cache entries in milliseconds (default: 24 hours).
   * @param maxSize - Maximum number of entries before oldest entry eviction (default: 1000).
   */
  constructor(ttlMs = 24 * 60 * 60 * 1000, maxSize = 1000) {
    this.ttl = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Stores or updates a message entry in the cache.
   * Evicts the oldest entry if capacity is reached.
   *
   * @param messageId - Telegram message ID or draft ID.
   * @param text - Raw Markdown content string.
   * @param replyContext - Optional structured reply context (thinking & answer parts).
   */
  set(messageId: number, text: string, replyContext?: ReplyContext): void {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    this.cache.set(messageId, {
      text,
      replyContext,
      timestamp: Date.now(),
    });

    // Cleanup expired entries occasionally
    if (Math.random() < 0.1) {
      this.cleanup();
    }
  }

  /**
   * Retrieves stored raw Markdown text for a given message ID if not expired.
   */
  get(messageId: number): string | null {
    const entry = this.cache.get(messageId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(messageId);
      return null;
    }

    return entry.text;
  }

  /**
   * Retrieves stored ReplyContext for a given message ID if not expired.
   */
  getReplyContext(messageId: number): ReplyContext | null {
    const entry = this.cache.get(messageId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(messageId);
      return null;
    }

    return entry.replyContext || null;
  }

  /**
   * Finds and returns the most recently stored ReplyContext across all cached messages.
   */
  getLastReplyContext(): ReplyContext | null {
    let latest: { timestamp: number; context: ReplyContext } | null = null;
    for (const entry of this.cache.values()) {
      if (entry.replyContext && (!latest || entry.timestamp > latest.timestamp)) {
        latest = { timestamp: entry.timestamp, context: entry.replyContext };
      }
    }
    return latest ? latest.context : null;
  }

  /**
   * Evicts all expired cache entries based on configured TTL.
   */
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
