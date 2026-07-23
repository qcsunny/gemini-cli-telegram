/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file conversationStore.ts
 * @description Persistent mapping store connecting Telegram `chatId` to `agy` conversation UUIDs,
 * working directory paths (cwd), creation timestamps, and selected model overrides.
 * Powered by Better-SQLite3 & Drizzle ORM.
 */

import * as fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { getAgyConversationsPath } from '../config/userConfig.js';

/**
 * Persisted entry structure mapping a Telegram chat ID to an agy conversation context.
 */
interface StoreEntry {
  conversationId: string;
  cwd: string;
  createdAt: string;
  model?: string;
}

type Store = Record<string, StoreEntry>;

let migrationDone = false;

/**
 * Migrates legacy `agy-conversations.json` file entries to SQLite table if present.
 */
async function migrateLegacyJsonIfNeeded(): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;

  try {
    const jsonPath = getAgyConversationsPath();
    const raw = await fs.readFile(jsonPath, 'utf-8').catch(() => null);
    if (!raw) return;

    const legacyStore = JSON.parse(raw) as Store;
    const db = getDb();

    for (const [chatIdStr, entry] of Object.entries(legacyStore)) {
      if (!entry.conversationId) continue;
      db.insert(schema.conversations)
        .values({
          chatId: chatIdStr,
          conversationId: entry.conversationId,
          cwd: entry.cwd || '',
          createdAt: entry.createdAt || new Date().toISOString(),
          model: entry.model,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }
    logger.info('[conversationStore] Migrated legacy agy-conversations.json into SQLite DB.');
  } catch (e) {
    logger.warn(`[conversationStore] Legacy JSON migration warning: ${e}`);
  }
}

/**
 * Return the agy conversation UUID for a given Telegram chat ID, or null if
 * no conversation has been started yet.
 */
export async function getConversationId(chatId: number): Promise<string | null> {
  await migrateLegacyJsonIfNeeded();
  const db = getDb();
  const row = db
    .select({ conversationId: schema.conversations.conversationId })
    .from(schema.conversations)
    .where(eq(schema.conversations.chatId, String(chatId)))
    .get();

  return row?.conversationId ?? null;
}

/**
 * Return the saved working directory for a chat, or null.
 */
export async function getCwd(chatId: number): Promise<string | null> {
  await migrateLegacyJsonIfNeeded();
  const db = getDb();
  const row = db
    .select({ cwd: schema.conversations.cwd })
    .from(schema.conversations)
    .where(eq(schema.conversations.chatId, String(chatId)))
    .get();

  return row?.cwd ?? null;
}

/**
 * Return the stored model override for a given Telegram chat ID, or null.
 */
export async function getStoredModel(chatId: number): Promise<string | null> {
  await migrateLegacyJsonIfNeeded();
  const db = getDb();
  const row = db
    .select({ model: schema.conversations.model })
    .from(schema.conversations)
    .where(eq(schema.conversations.chatId, String(chatId)))
    .get();

  return row?.model ?? null;
}

/**
 * Save or update the agy conversation UUID, cwd and optional model for a given chat.
 */
export async function setConversation(
  chatId: number,
  conversationId: string,
  cwd: string,
  model?: string,
): Promise<void> {
  await migrateLegacyJsonIfNeeded();
  const db = getDb();
  const chatIdStr = String(chatId);

  const existing = db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.chatId, chatIdStr))
    .get();

  const newConvId = conversationId || existing?.conversationId || '';
  const newCwd = cwd || existing?.cwd || '';
  const newCreatedAt = existing?.createdAt || new Date().toISOString();
  const newModel = model !== undefined ? model : existing?.model;
  const now = new Date().toISOString();

  db.insert(schema.conversations)
    .values({
      chatId: chatIdStr,
      conversationId: newConvId,
      cwd: newCwd,
      createdAt: newCreatedAt,
      model: newModel,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.conversations.chatId,
      set: {
        conversationId: newConvId,
        cwd: newCwd,
        model: newModel,
        updatedAt: now,
      },
    })
    .run();

  logger.debug(`[conversationStore] Saved chatId=${chatId} → conv=${newConvId}, model=${newModel}`);
}

/**
 * Delete the stored conversation for a chat (e.g. on /reset).
 */
export async function deleteConversation(chatId: number): Promise<void> {
  await migrateLegacyJsonIfNeeded();
  const db = getDb();
  db.delete(schema.conversations)
    .where(eq(schema.conversations.chatId, String(chatId)))
    .run();

  logger.info(`[conversationStore] Deleted conversation for chatId=${chatId}`);
}
