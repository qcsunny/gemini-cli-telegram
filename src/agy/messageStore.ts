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
 * Calculate cumulative token usage for a conversation by summing all stored turn usages.
 */
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

/**
 * Aggregate cumulative token usage across ALL stored messages for a given
 * Telegram chat (matched via conversations table → conversationId), summing the
 * per-turn `usage` JSON column. Returns a single cumulative TokenUsage.
 */
export function getCumulativeUsageByChat(chatId: string | number): {
  input: number;
  output: number;
  cached: number;
  thinking: number;
} {
  const zero = { input: 0, output: 0, cached: 0, thinking: 0 };
  try {
    const db = getDb();
    const convRows = db
      .select({ conversationId: schema.conversations.conversationId })
      .from(schema.conversations)
      .where(eq(schema.conversations.chatId, String(chatId)))
      .all() as { conversationId: string }[];

    if (convRows.length === 0) return zero;

    const convIds = convRows.map((r) => r.conversationId);
    const allMsgs = db
      .select({
        conversationId: schema.messages.conversationId,
        usage: schema.messages.usage,
        backend: schema.messages.backend,
      })
      .from(schema.messages)
      .all() as { conversationId: string; usage: string | null; backend: string }[];

    let input = 0;
    let output = 0;
    let cached = 0;
    let thinking = 0;

    for (const row of allMsgs) {
      if (!convIds.includes(row.conversationId) || !row.usage) continue;
      try {
        const u = JSON.parse(row.usage) as Partial<Record<keyof typeof zero, number>>;
        input += Number(u.input) || 0;
        output += Number(u.output) || 0;
        cached += Number(u.cached) || 0;
        thinking += Number(u.thinking) || 0;
      } catch {
        /* skip malformed usage blob */
      }
    }

    return { input, output, cached, thinking };
  } catch (e) {
    logger.warn(`[messageStore] getCumulativeUsageByChat failed: ${e}`);
    return zero;
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
