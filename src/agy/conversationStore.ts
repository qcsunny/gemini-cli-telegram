/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
/**
 * @file conversationStore.ts
 * @description Persistent mapping store connecting Telegram `chatId` to `agy` conversation UUIDs,
 * working directory paths (cwd), creation timestamps, and selected model overrides.
 * Stored locally at `~/.gemini-cli-telegram/agy-conversations.json`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../utils/logger.js';

/**
 * Returns the absolute path to the local conversation store JSON file.
 */
function getStorePath(): string {
  return path.join(
    os.homedir(),
    '.gemini-cli-telegram',
    'agy-conversations.json',
  );
}

/**
 * Persisted entry structure mapping a Telegram chat ID to an agy conversation context.
 */
interface StoreEntry {
  conversationId: string;
  cwd: string;
  createdAt: string;
  model?: string;
}

type Store = Record<string, StoreEntry>; // key = chatId (string)

let _cache: Store | null = null;

async function loadStore(): Promise<Store> {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(getStorePath(), 'utf-8');
    _cache = JSON.parse(raw) as Store;
  } catch {
    _cache = {};
  }
  return _cache;
}

async function saveStore(store: Store): Promise<void> {
  _cache = store;
  const storePath = getStorePath();
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Return the agy conversation UUID for a given Telegram chat ID, or null if
 * no conversation has been started yet.
 */
export async function getConversationId(chatId: number): Promise<string | null> {
  const store = await loadStore();
  return store[String(chatId)]?.conversationId ?? null;
}

/**
 * Return the saved working directory for a chat, or null.
 */
export async function getCwd(chatId: number): Promise<string | null> {
  const store = await loadStore();
  return store[String(chatId)]?.cwd ?? null;
}

/**
 * Return the stored model override for a given Telegram chat ID, or null.
 */
export async function getStoredModel(chatId: number): Promise<string | null> {
  const store = await loadStore();
  return store[String(chatId)]?.model ?? null;
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
  const store = await loadStore();
  const existing = store[String(chatId)];
  store[String(chatId)] = {
    conversationId: conversationId || existing?.conversationId || '',
    cwd: cwd || existing?.cwd || '',
    createdAt: existing?.createdAt || new Date().toISOString(),
    model: model !== undefined ? model : existing?.model,
  };
  await saveStore(store);
  logger.debug(`[conversationStore] Saved chatId=${chatId} → conv=${conversationId}, model=${model}`);
}

/**
 * Delete the stored conversation for a chat (e.g. on /reset).
 */
export async function deleteConversation(chatId: number): Promise<void> {
  const store = await loadStore();
  delete store[String(chatId)];
  await saveStore(store);
  logger.info(`[conversationStore] Deleted conversation for chatId=${chatId}`);
}

/**
 * Return a map of all stored conversations (for /status or debugging).
 */
export async function getAllConversations(): Promise<Store> {
  return loadStore();
}
