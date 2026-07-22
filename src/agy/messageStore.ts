/**
 * @file messageStore.ts
 * @description SQLite-backed persistence for web2api / deepseek / gemini-direct
 * conversation histories. Messages are written on stream end (not per chunk)
 * and restored into the in-memory Maps at startup so they survive restarts.
 */

import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { logger } from '../utils/logger.js';

type Backend = 'web2api' | 'deepseek' | 'gemini-direct';

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
export function saveMessage(conversationId: string, role: 'user' | 'assistant', content: string, backend: Backend): void {
  try {
    const db = getDb();
    db.insert(schema.messages)
      .values({
        conversationId,
        role,
        content,
        backend,
        createdAt: new Date().toISOString(),
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
  } catch (e) {
    logger.warn(`[messageStore] clearMessages failed: ${e}`);
  }
}

/**
 * Restore in-memory history Maps from the database at startup.
 * Scans all distinct conversation_id+backend pairs and loads their messages.
 */
export function restoreAllHistories(
  web2apiHistories: Map<string, StoredMessage[]>,
  deepseekHistories: Map<string, StoredMessage[]>,
  geminiDirectHistories: Map<string, StoredMessage[]>,
): void {
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
      const msgs = loadMessages(row.conversationId, row.backend as Backend);
      if (msgs.length === 0) continue;
      const map =
        row.backend === 'web2api' ? web2apiHistories :
        row.backend === 'deepseek' ? deepseekHistories :
        row.backend === 'gemini-direct' ? geminiDirectHistories :
        null;
      if (map) {
        map.set(row.conversationId, msgs);
        logger.info(`[messageStore] Restored ${msgs.length} messages for ${row.backend} conv ${row.conversationId.slice(0, 12)}...`);
      }
    }
  } catch (e) {
    logger.warn(`[messageStore] restoreAllHistories failed: ${e}`);
  }
}
