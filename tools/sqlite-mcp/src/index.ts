#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import Database from 'better-sqlite3';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(__dirname, '../../..', 'db.sqlite');
const projectDb = path.resolve(process.env.SQLITE_MCP_DB ?? DEFAULT_DB);
const agyConversationsDir = path.resolve(
  process.env.AGY_CONVERSATIONS_DIR ??
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations'),
);
const mihomoConfigDir = path.resolve(
  process.env.MIHOMO_CONFIG_DIR ?? '/mnt/pool/1000/docker/mihomo_1',
);

const dbCache = new Map<string, Database.Database>();

function resolveDbPath(dbParam?: string): string {
  let raw: string;
  if (dbParam === undefined || dbParam === '') {
    raw = projectDb;
  } else {
    raw = dbParam;
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }
  const resolved = path.resolve(raw);

  // Whitelist: the project db.sqlite itself, or any file inside the agy
  // conversations directory, or any SQLite database under the mihomo config
  // directory (e.g. cache.db). Anything else is rejected.
  if (resolved === projectDb) return resolved;
  const allowedDirs = [agyConversationsDir, mihomoConfigDir];
  for (const dir of allowedDirs) {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (resolved.startsWith(prefix)) return resolved;
  }

  throw new Error(
    `Path not allowed: ${resolved}. Whitelisted locations: project db (${projectDb}), agy conversations dir (${agyConversationsDir}), mihomo config dir (${mihomoConfigDir}).`,
  );
}

function getDb(dbPath: string): Database.Database {
  let db = dbCache.get(dbPath);
  if (!db) {
    db = new Database(dbPath, { readonly: true });
    dbCache.set(dbPath, db);
  }
  return db;
}

const dbParamSchema = z
  .string()
  .optional()
  .describe(
    `Optional path to a SQLite database. Omit for the project db.sqlite. Must be the project db.sqlite itself or a file under ${agyConversationsDir} or ${mihomoConfigDir}. Supports ~ expansion.`,
  );

function assertReadOnly(sql: string): string | null {
  const trimmed = sql.trim().toUpperCase();
  const allowed =
    trimmed.startsWith('SELECT') ||
    trimmed.startsWith('PRAGMA') ||
    trimmed.startsWith('EXPLAIN') ||
    trimmed.startsWith('WITH') ||
    trimmed.startsWith('VALUES');
  return allowed ? null : `Error: only read-only statements are allowed. Got: ${sql}`;
}

const server = new McpServer({
  name: 'sqlite-readonly',
  version: '1.0.0',
});

server.registerTool(
  'query',
  {
    description:
      'Execute a read-only SELECT query against a whitelisted SQLite database (default: project db.sqlite). Only SELECT / PRAGMA / EXPLAIN / WITH / VALUES statements are allowed.',
    inputSchema: {
      sql: z
        .string()
        .describe('SQL statement. Must start with SELECT, PRAGMA, EXPLAIN, WITH, or VALUES.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .default(100)
        .describe('Maximum rows to return (default 100, max 500).'),
      db: dbParamSchema,
    },
  },
  async ({ sql, limit, db }) => {
    const readOnlyError = assertReadOnly(sql);
    if (readOnlyError) {
      return {
        content: [{ type: 'text', text: readOnlyError }],
        isError: true,
      };
    }
    try {
      const dbPath = resolveDbPath(db);
      const conn = getDb(dbPath);
      const stmt = conn.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all();
        const sliced = rows.slice(0, limit);
        const text =
          sliced.length === 0
            ? '(empty result set)'
            : JSON.stringify(sliced, null, 2);
        return {
          content: [
            {
              type: 'text',
              text: `DB: ${dbPath}\nRows: ${sliced.length}${sliced.length < rows.length ? ` (truncated from ${rows.length})` : ''}\n${text}`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: 'Statement did not return rows.' }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'list_tables',
  {
    description:
      'List all tables in a whitelisted SQLite database with row counts (default: project db.sqlite).',
    inputSchema: {
      db: dbParamSchema,
    },
  },
  async ({ db }) => {
    try {
      const dbPath = resolveDbPath(db);
      const conn = getDb(dbPath);
      const tables = (conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]).map((r) => r.name);
      const rows = tables.map((t: string) => {
        const count = conn.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number };
        return { table: t, rows: count.c };
      });
      return {
        content: [
          {
            type: 'text',
            text: `DB: ${dbPath}\n${rows.length ? JSON.stringify(rows, null, 2) : '(no tables)'}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'schema',
  {
    description:
      'Describe the columns of a table in a whitelisted SQLite database (default: project db.sqlite).',
    inputSchema: {
      table: z.string().describe('Table name.'),
      db: dbParamSchema,
    },
  },
  async ({ table, db }) => {
    try {
      const dbPath = resolveDbPath(db);
      const conn = getDb(dbPath);
      const cols = conn.prepare(`PRAGMA table_info("${table}")`).all();
      return {
        content: [{ type: 'text', text: `DB: ${dbPath}\n${JSON.stringify(cols, null, 2)}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`sqlite-readonly MCP server running (project db: ${projectDb})`);
  console.error(`agy conversations whitelist dir: ${agyConversationsDir}`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
