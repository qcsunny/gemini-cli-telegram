/**
 * @file messageStore.ts
 * @description SQLite-backed persistence for web2api / deepseek / gemini-direct
 * conversation histories. Messages are written on stream end (not per chunk)
 * and restored into the in-memory Maps at startup so they survive restarts.
 */

import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { logger } from '../utils/logger.js';

type Backend = 'web2api' | 'deepseek' | 'gemini-direct' | 'opencode';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

/**
 * Load all persisted messages for a conversation, ordered oldest-first.
 * Returns the message array suitable for seeding the in-memory history Maps.
 */
export function loadMessages(conversationId: string, backend: Backend): StoredMessage[] {
  try {
    const db = getDb();
    const rows = db
      .select({
        role: schema.messages.role,
        content: schema.messages.content,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.backend, backend),
        ),
      )
      .orderBy(schema.messages.id)
      .all();

    return rows as StoredMessage[];
  } catch (e) {
    logger.warn(`[messageStore] loadMessages failed: ${e}`);
    return [];
  }
}

/**
 * Save a single message turn to the database.
 * Called at stream end (not per chunk) to minimize write overhead.
 */
export function saveMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  backend: Backend,
  usage?: { input: number; output: number; cached: number; thinking: number }
): void {
  try {
    const db = getDb();
    db.insert(schema.messages)
      .values({
        conversationId,
        role,
        content,
        backend,
        createdAt: new Date().toISOString(),
        usage: usage ? JSON.stringify(usage) : null,
      })
      .run();
  } catch (e) {
    logger.warn(`[messageStore] saveMessage failed: ${e}`);
  }
}

/**
 * Delete all persisted messages for a conversation (called on /new or session reset).
 */
export function clearMessages(conversationId: string, backend: Backend): void {
  try {
    const db = getDb();
    db.delete(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.backend, backend),
        ),
      )
      .run();
    knownConversationIds.delete(`${backend}|${conversationId}`);
  } catch (e) {
    logger.warn(`[messageStore] clearMessages failed: ${e}`);
  }
}

/** Known conversation IDs (backend|convId) for lazy loading. */
export const knownConversationIds = new Set<string>();

/**
 * Register known conversation IDs from database at startup.
 * Messages are NOT loaded into memory — they will be lazy-loaded on first access.
 */
export function restoreAllHistories(): void {
  try {
    const db = getDb();
    const rows = db
      .select({
        conversationId: schema.messages.conversationId,
        backend: schema.messages.backend,
      })
      .from(schema.messages)
      .groupBy(schema.messages.conversationId, schema.messages.backend)
      .all() as { conversationId: string; backend: string }[];

    for (const row of rows) {
      knownConversationIds.add(`${row.backend}|${row.conversationId}`);
    }
    logger.info(`[messageStore] Registered ${rows.length} known conversations for lazy loading`);
  } catch (e) {
    logger.warn(`[messageStore] restoreAllHistories failed: ${e}`);
  }
}

/**
 * Get conversation history, lazy-loading from SQLite on first access.
 * Once loaded, the result is cached in the in-memory map for subsequent calls.
 */
export function getHistory(
  map: Map<string, StoredMessage[]>,
  convId: string,
  backend: Backend,
): StoredMessage[] {
  const cached = map.get(convId);
  if (cached) return cached;

  const key = `${backend}|${convId}`;
  if (knownConversationIds.has(key)) {
    const msgs = loadMessages(convId, backend);
    if (msgs.length > 0) {
      map.set(convId, msgs);
      logger.info(`[messageStore] Lazy-loaded ${msgs.length} messages for ${backend} conv ${convId.slice(0, 12)}...`);
    }
    return msgs;
  }
  return [];
}
