/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file index.ts
 * @description Database initialization and Drizzle ORM setup for better-sqlite3.
 */

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as schema from './schema.js';
import { logger } from '../utils/logger.js';
import { getDbPath } from '../config/userConfig.js';

let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let sqliteDb: InstanceType<typeof Database> | null = null;

/**
 * Returns default absolute path to the SQLite database file.
 * Internal — use getDb() instead.
 */
function getDefaultDbPath(): string {
  if (process.env['GEMINI_TELEGRAM_DB_PATH']) {
    return process.env['GEMINI_TELEGRAM_DB_PATH'];
  }
  const dbPath = getDbPath();
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dbPath;
  } catch {
    logger.warn('[db] Failed to create db directory, falling back to /tmp');
    const tmpDir = path.join('/tmp', 'gemini-cli-telegram');
    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch (e2) {
        logger.warn(`[db] Failed to create tmp directory: ${e2}`);
      }
    }
    return path.join(tmpDir, 'db.sqlite');
  }
}

/**
 * Get or initialize the Drizzle ORM database instance.
 * Accepts optional custom file path or in-memory sqlite instance string (e.g. ':memory:') for tests.
 */
export function getDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
  if (dbInstance && !dbPath) {
    return dbInstance;
  }

  const targetPath = dbPath || getDefaultDbPath();
  const sqlite = new Database(targetPath);
  sqlite.pragma('journal_mode = WAL');

  // Automatically ensure the conversations table exists on initialization
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      chat_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model TEXT,
      updated_at TEXT
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      backend TEXT NOT NULL CHECK(backend IN ('web2api','deepseek','gemini-direct','opencode')),
      created_at TEXT NOT NULL,
      usage TEXT
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS model_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      conversation_id TEXT,
      model TEXT,
      title TEXT,
      answer_markdown TEXT NOT NULL,
      thinking_markdown TEXT,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_outputs_chat_msg ON model_outputs(chat_id, message_id);
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_states (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      sender_name TEXT,
      sender_username TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_chat_msg ON chat_messages(chat_id, message_id);
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_symbol ON watchlists(telegram_user_id, symbol);
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      condition TEXT NOT NULL CHECK(condition IN ('gte','lte')),
      target_price INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Dynamically add usage column to messages table if it doesn't exist in legacy databases
  try {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN usage TEXT;`);
    logger.info(`[db] Successfully added 'usage' column to 'messages' table.`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column name')) {
      logger.warn(`[db] Notice on adding 'usage' column: ${e.message}`);
    }
  }

  // Dynamically add sender_username column to chat_messages table if it doesn't exist in legacy databases
  try {
    sqlite.exec(`ALTER TABLE chat_messages ADD COLUMN sender_username TEXT;`);
    logger.info(`[db] Successfully added 'sender_username' column to 'chat_messages' table.`);
  } catch (e: any) {
    if (!e.message?.includes('duplicate column name')) {
      logger.warn(`[db] Notice on adding 'sender_username' column: ${e.message}`);
    }
  }

  const instance = drizzle(sqlite, { schema });

  if (!dbPath) {
    sqliteDb = sqlite;
    dbInstance = instance;
  }

  logger.debug(`[db] Initialized SQLite database at ${targetPath}`);
  return instance;
}

/**
 * Safely closes active database connection. Used by tests for cleanup.
 */
export function closeDb(): void {
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch (e) {
      logger.warn(`[db] Error closing database: ${e}`);
    }
    sqliteDb = null;
    dbInstance = null;
  }
}

export { schema };
