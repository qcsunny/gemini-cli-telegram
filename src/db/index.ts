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
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as schema from './schema.js';
import { logger } from '../utils/logger.js';

let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let sqliteDb: InstanceType<typeof Database> | null = null;

/**
 * Returns default absolute path to the SQLite database file (~/.gemini-cli-telegram/db.sqlite).
 */
export function getDefaultDbPath(): string {
  if (process.env['GEMINI_TELEGRAM_DB_PATH']) {
    return process.env['GEMINI_TELEGRAM_DB_PATH'];
  }
  const home = typeof os.homedir === 'function' ? os.homedir() : '/tmp';
  const dir = path.join(home, '.gemini-cli-telegram');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'db.sqlite');
  } catch {
    const tmpBase = typeof os.tmpdir === 'function' ? os.tmpdir() : '/tmp';
    const tmpDir = path.join(tmpBase, '.gemini-cli-telegram');
    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch {
        /* ignore */
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

  // Automatically ensure tables exist on initialization
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      chat_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      conversation_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      conversation_id TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL
    );
  `);

  const instance = drizzle(sqlite, { schema });

  if (!dbPath) {
    sqliteDb = sqlite;
    dbInstance = instance;
  }

  logger.debug(`[db] Initialized SQLite database at ${targetPath}`);
  return instance;
}

/**
 * Safely closes active database connection.
 */
export function closeDb(): void {
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {
      /* ignore */
    }
    sqliteDb = null;
    dbInstance = null;
  }
}

export { schema };
