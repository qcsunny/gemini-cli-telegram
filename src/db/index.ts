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
/** Path of the DB file the cached connection is bound to (for path-aware reconnect). */
let dbInstancePath: string | null = null;

/** Current schema revision embedded in SQLite PRAGMA user_version. */
const SCHEMA_VERSION = 4;

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
 *
 * The connection is cached per database path. If the config-driven default path
 * changes after a SIGHUP (clearConfigCache), the cached connection is closed and
 * reopened against the new path automatically.
 */
export function getDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
  const targetPath = dbPath || getDefaultDbPath();
  // Reuse the cached connection only while it points at the same target path.
  if (dbInstance && sqliteDb && dbInstancePath === targetPath) {
    return dbInstance;
  }
  // Path changed (e.g. config reloaded → new db path): drop stale connection.
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch (e) {
      logger.warn(`[db] Error closing stale database connection: ${e}`);
    }
    sqliteDb = null;
    dbInstance = null;
  }
  let sqlite: InstanceType<typeof Database>;
  try {
    sqlite = new Database(targetPath);
  } catch (e) {
    // A corrupted/unopenable DB (or permission error) must surface clearly
    // instead of silently letting the daemon run with persistence disabled.
    logger.error(`[db] Failed to open SQLite database at ${targetPath}: ${e}`);
    throw e;
  }
  // SQLITE_BUSY handling: wait (ms) for concurrent writers instead of failing
  // immediately. Prevents silent message loss when two instances contend on WAL.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 268435456');
  sqlite.pragma('cache_size = -32000');
  const prevVersion = sqlite.pragma('user_version', { simple: true }) as number;

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
      backend TEXT NOT NULL CHECK(backend IN ('web2api','deepseek','glm','qwen','gemini-direct','opencode','claude','codex')),
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

  // Migration: allow all 8 backends ('opencode', 'claude', 'codex', 'glm', 'qwen') in the messages table CHECK
  // constraint. SQLite cannot ALTER a CHECK constraint, so rebuild the table
  // preserving all existing columns and data. Runs once on databases created
  // before new backends existed.
  try {
    const msgSql = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`).get() as { sql?: string } | undefined;
    if (msgSql?.sql && (!msgSql.sql.includes("'opencode'") || !msgSql.sql.includes("'claude'") || !msgSql.sql.includes("'codex'") || !msgSql.sql.includes("'glm'") || !msgSql.sql.includes("'qwen'"))) {
      const cols = sqlite.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      const colDefs = names.map((n) => {
        if (n === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
        if (n === 'conversation_id') return 'conversation_id TEXT NOT NULL';
        if (n === 'role') return "role TEXT NOT NULL CHECK(role IN ('user','assistant'))";
        if (n === 'content') return 'content TEXT NOT NULL';
        if (n === 'backend') return "backend TEXT NOT NULL CHECK(backend IN ('web2api','deepseek','glm','qwen','gemini-direct','opencode','claude','codex'))";
        if (n === 'created_at') return 'created_at TEXT NOT NULL';
        return `"${n}" TEXT`;
      });
      sqlite.transaction(() => {
        sqlite.exec(`CREATE TABLE messages_new (${colDefs.join(',\n')})`);
        sqlite.exec(`INSERT INTO messages_new (${names.join(',')}) SELECT ${names.join(',')} FROM messages`);
        sqlite.exec(`DROP TABLE messages`);
        sqlite.exec(`ALTER TABLE messages_new RENAME TO messages`);
      })();
      logger.info(`[db] Migrated 'messages' table to allow all backends (${names.length} columns, data preserved)`);
    }
  } catch (e: unknown) {
    logger.warn(`[db] messages CHECK constraint migration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Dynamically add usage column to messages table if it doesn't exist in legacy databases
  try {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN usage TEXT;`);
    logger.info(`[db] Successfully added 'usage' column to 'messages' table.`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes('duplicate column name')) {
      logger.warn(`[db] Notice on adding 'usage' column: ${message}`);
    }
  }

  // Dynamically add sender_username column to chat_messages table if it doesn't exist in legacy databases
  try {
    sqlite.exec(`ALTER TABLE chat_messages ADD COLUMN sender_username TEXT;`);
    logger.info(`[db] Successfully added 'sender_username' column to 'chat_messages' table.`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes('duplicate column name')) {
      logger.warn(`[db] Notice on adding 'sender_username' column: ${message}`);
    }
  }

  // v4: drop the legacy price-alerts table (feature removed — dead code).
  if (prevVersion < 4) {
    try {
      sqlite.exec(`DROP TABLE IF EXISTS alerts;`);
      logger.info('[db] Dropped legacy alerts table (feature removed)');
    } catch (e: unknown) {
      logger.warn(`[db] alerts table drop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Stamp the schema revision so future migrations can detect drift and
  // upgrade in a controlled, versioned manner.
  if (prevVersion !== SCHEMA_VERSION) {
    sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    logger.info(`[db] Schema version ${prevVersion} → ${SCHEMA_VERSION}`);
  }

  const instance = drizzle(sqlite, { schema });

  if (!dbPath) {
    sqliteDb = sqlite;
    dbInstance = instance;
    dbInstancePath = targetPath;
  }

  logger.debug(`[db] Initialized SQLite database at ${targetPath}`);
  return instance;
}

/**
 * Safely closes active database connection. Used by tests for cleanup and by
 * the daemon shutdown path.
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
    dbInstancePath = null;
  } else {
    dbInstance = null;
    dbInstancePath = null;
  }
}

/**
 * Performs SQLite WAL checkpoint maintenance to truncate the WAL journal and keep disk footprint small.
 */
export function walCheckpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE'): void {
  if (sqliteDb) {
    try {
      sqliteDb.pragma(`wal_checkpoint(${mode})`);
      logger.debug(`[db] Executed PRAGMA wal_checkpoint(${mode})`);
    } catch (e) {
      logger.warn(`[db] WAL checkpoint error: ${e}`);
    }
  }
}

export { schema };
