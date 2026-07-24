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
      created_at TEXT NOT NULL
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
