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
import { getDb } from '../db/index.js';
import { modelOutputs } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { extractSimpleThought } from './textUtils.js';

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
  /** Tracks the most recent reply context per chat, enabling per-chat retrieval. */
  private lastReplyContexts: LRUCache<number, ReplyContext>;
  /** Fallback to the most recently stored context (when no chatId is available). */
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
    this.lastReplyContexts = new LRUCache<number, ReplyContext>({
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
   * @param chatId - Optional Telegram chat ID to trigger SQLite persistence.
   * @param model - Optional model name for database record.
   * @param conversationId - Optional conversation UUID for database record.
   */
  set(
    messageId: number,
    text: string,
    replyContext?: ReplyContext,
    chatId?: number,
    model?: string,
    conversationId?: string
  ): void {
    let finalContext = replyContext;
    if (!finalContext && text) {
      const parsed = extractSimpleThought(text);
      finalContext = {
        answerMarkdown: parsed.content,
        thinkingMarkdown: parsed.thought,
      };
    }
    this.cache.set(messageId, { text, replyContext: finalContext });
    if (finalContext) {
      if (chatId !== undefined) {
        this.lastReplyContexts.set(chatId, finalContext);
      }
      this.lastReplyContext = finalContext;
    }

    if (chatId !== undefined) {
      void (async () => {
        try {
          const db = getDb();
          const nowStr = new Date().toISOString();
          await db.insert(modelOutputs)
            .values({
              chatId: String(chatId),
              messageId,
              conversationId: conversationId || null,
              model: model || null,
              title: finalContext?.title || null,
              answerMarkdown: finalContext?.answerMarkdown || text,
              thinkingMarkdown: finalContext?.thinkingMarkdown || null,
              createdAt: nowStr,
            })
            .onConflictDoUpdate({
              target: [modelOutputs.chatId, modelOutputs.messageId],
              set: {
                conversationId: conversationId || null,
                model: model || null,
                title: finalContext?.title || null,
                answerMarkdown: finalContext?.answerMarkdown || text,
                thinkingMarkdown: finalContext?.thinkingMarkdown || null,
                createdAt: nowStr,
              }
            });
          logger.debug(`[messageCache] Persisted model output for message ${messageId} in chat ${chatId} to database.`);
        } catch (err) {
          logger.error(`[messageCache] Failed to persist model output to database: ${err}`);
        }
      })();
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
   * Retrieves the last stored ReplyContext for a specific chat if any exists.
   */
  getLastReplyContextForChat(chatId: number): ReplyContext | null {
    return this.lastReplyContexts.get(chatId) ?? null;
  }

  /**
   * Finds and returns the most recently stored ReplyContext (any chat).
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
