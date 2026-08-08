#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(__dirname, '../../..', 'db.sqlite');
const dbPath = process.env.SQLITE_MCP_DB ?? DEFAULT_DB;

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = WAL');

const server = new McpServer({
  name: 'sqlite-readonly',
  version: '1.0.0',
});

server.registerTool(
  'query',
  {
    description:
      'Execute a read-only SELECT query against the project SQLite database (db.sqlite). Only SELECT / PRAGMA / EXPLAIN statements are allowed.',
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
    },
  },
  async ({ sql, limit }) => {
    const trimmed = sql.trim().toUpperCase();
    const allowed =
      trimmed.startsWith('SELECT') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.startsWith('EXPLAIN') ||
      trimmed.startsWith('WITH') ||
      trimmed.startsWith('VALUES');
    if (!allowed) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: only read-only statements are allowed. Got: ${sql}`,
          },
        ],
        isError: true,
      };
    }
    try {
      const stmt = db.prepare(sql);
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
              text: `Rows: ${sliced.length}${sliced.length < rows.length ? ` (truncated from ${rows.length})` : ''}\n${text}`,
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
    description: 'List all tables in the project SQLite database with row counts.',
  },
  async () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    const rows = tables.map((t: string) => {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number };
      return { table: t, rows: count.c };
    });
    return {
      content: [
        { type: 'text', text: rows.length ? JSON.stringify(rows, null, 2) : '(no tables)' },
      ],
    };
  },
);

server.registerTool(
  'schema',
  {
    description: 'Describe the columns of a table in the project SQLite database.',
    inputSchema: {
      table: z.string().describe('Table name.'),
    },
  },
  async ({ table }) => {
    try {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
      return {
        content: [{ type: 'text', text: JSON.stringify(cols, null, 2) }],
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
  console.error(`sqlite-readonly MCP server running on ${dbPath}`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
