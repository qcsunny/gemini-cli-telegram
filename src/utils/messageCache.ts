/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file messageCache.ts
 * @description LRU TTL cache storing unformatted Markdown messages and reply contexts.
 * Enables exact Markdown source retrieval for the /save command instead of extracting rendered HTML from Telegram.
 */

import { LRUCache } from 'lru-cache';
import { getTuningConfig } from '../config/userConfig.js';

/**
 * Contextual metadata associated with a saved message reply, including title and separate thinking/answer blocks.
 */
export interface ReplyContext {
  title?: string;
  answerMarkdown: string;
  thinkingMarkdown: string;
}

/**
 * Internal cache entry storing the raw Markdown text and optional reply context.
 */
interface CacheEntry {
  text: string;
  replyContext?: ReplyContext;
}

/**
 * LRU-based TTL cache for original Markdown messages.
 * Uses `lru-cache` for efficient O(1) get/set with automatic LRU eviction
 * and TTL-based expiration. The /save command retrieves unformatted source
 * instead of rendered text from Telegram.
 */
export class MessageCache {
  private cache: LRUCache<number, CacheEntry>;
  /** Tracks the most recently stored reply context for /save convenience. */
  private lastReplyContext: ReplyContext | null = null;

  /**
   * @param ttlMs - Time-to-live for cache entries in milliseconds.
   * @param maxSize - Maximum number of entries before LRU eviction.
   */
  constructor(ttlMs: number, maxSize: number) {
    this.cache = new LRUCache<number, CacheEntry>({
      max: maxSize,
      ttl: ttlMs,
    });
  }

  /**
   * Stores or updates a message entry in the cache.
   * LRU eviction happens automatically when capacity is reached.
   *
   * @param messageId - Telegram message ID or draft ID.
   * @param text - Raw Markdown content string.
   * @param replyContext - Optional structured reply context (thinking & answer parts).
   */
  set(messageId: number, text: string, replyContext?: ReplyContext): void {
    this.cache.set(messageId, { text, replyContext });
    if (replyContext) {
      this.lastReplyContext = replyContext;
    }
  }

  /**
   * Retrieves stored raw Markdown text for a given message ID if not expired.
   */
  get(messageId: number): string | null {
    return this.cache.get(messageId)?.text ?? null;
  }

  /**
   * Retrieves stored ReplyContext for a given message ID if not expired.
   */
  getReplyContext(messageId: number): ReplyContext | null {
    return this.cache.get(messageId)?.replyContext ?? null;
  }

  /**
   * Finds and returns the most recently stored ReplyContext across all cached messages.
   */
  getLastReplyContext(): ReplyContext | null {
    return this.lastReplyContext;
  }

  get size(): number {
    return this.cache.size;
  }

  get capacity(): number {
    return this.cache.max;
  }
}

/** Singleton instance — configured from config.json tuning parameters. */
export const messageCache = new MessageCache(
  getTuningConfig().cacheTtlMs,
  getTuningConfig().cacheMaxSize,
);
