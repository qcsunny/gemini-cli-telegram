import * as fssync from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getConversationsDir, extractTextFromProto, decodePlainText, extractMetadataFromProto } from './protobuf.js';
import { getAgyDataDir } from '../config/userConfig.js';

export interface SummaryRecord {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string | null;
  workspace_uris: string | null;
  status: string;
  source: string;
  project_id: string;
  agent_name: string;
  parent_conversation_id: string | null;
  nesting_depth: number;
  battle_id: string | null;
  winning_conversation_id: string | null;
  not_fully_idle: number;
  killed: number;
  last_user_input_time: string | null;
  last_user_input_step_index: number | null;
  app_data_dir: string | null;
}

export interface DebugDump {
  dbPath: string;
  tables: Record<string, unknown[]>;
  summary: {
    totalSteps: number;
    roles: Record<string, number>;
    hasErrors: boolean;
    durationMs: number;
  };
}

export interface SummaryDump {
  dbPath: string;
  totalConversations: number;
  conversations: SummaryRecord[];
  stats: {
    totalConversations: number;
    withTitle: number;
    withPreview: number;
    killed: number;
    avgSteps: number;
    oldestConversation: string | null;
    newestConversation: string | null;
  };
  durationMs: number;
}

function decodeBlob(val: unknown): unknown {
  if (val instanceof Uint8Array) {
    const text = decodePlainText(val);
    if (text.length > 0 && text.length < 10000) return text;
    return `[BLOB ${val.length} bytes]`;
  }
  return val;
}

function decodeMetadataBlob(val: unknown): unknown {
  if (val instanceof Uint8Array) {
    if (val.length === 0) return null;
    return extractMetadataFromProto(val);
  }
  return val;
}

function decodeStepPayloadBlob(val: unknown): unknown {
  if (val instanceof Uint8Array) {
    if (val.length === 0) return null;
    const text = extractTextFromProto(val);
    const fields = extractMetadataFromProto(val);
    const result: Record<string, unknown> = {};
    if (text) result['text'] = text;
    if (Object.keys(fields).length > 0) result['fields'] = fields;
    return Object.keys(result).length > 0 ? result : decodeBlob(val);
  }
  return val;
}

function decodeDataBlob(val: unknown): unknown {
  if (val instanceof Uint8Array) {
    if (val.length === 0) return null;
    const text = extractTextFromProto(val);
    if (text) return text;
    const meta = extractMetadataFromProto(val);
    if (Object.keys(meta).length > 0) return meta;
    return decodeBlob(val);
  }
  return val;
}

export function dumpConversationDb(dbPath: string): DebugDump {
  const startTime = Date.now();
  if (!fssync.existsSync(dbPath)) {
    return { dbPath, tables: {}, summary: { totalSteps: 0, roles: {}, hasErrors: false, durationMs: 0 } };
  }

  const db = new Database(dbPath, { readonly: true });
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const tables: Record<string, unknown[]> = {};

  for (const { name } of tableNames) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[];
    const colNames = columns.map(c => c.name).join(', ');
    const rows = db.prepare(`SELECT ${colNames} FROM ${name}`).all() as Record<string, unknown>[];

    tables[name] = rows.map(row => {
      const decoded: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (key === 'metadata') {
          decoded[key] = decodeMetadataBlob(val);
        } else if (key === 'step_payload') {
          decoded[key] = decodeStepPayloadBlob(val);
        } else if (key === 'data') {
          decoded[key] = decodeDataBlob(val);
        } else {
          decoded[key] = decodeBlob(val);
        }
      }
      return decoded;
    });
  }

  db.close();

  const steps = tables['steps'] || [];
  const roles: Record<string, number> = {};
  let hasErrors = false;
  for (const s of steps) {
    const r = stepTypeLabel(Number((s as Record<string, unknown>)['step_type']));
    roles[r] = (roles[r] || 0) + 1;
    if (Number((s as Record<string, unknown>)['status']) !== 0) hasErrors = true;
  }

  return {
    dbPath,
    tables,
    summary: {
      totalSteps: steps.length,
      roles,
      hasErrors,
      durationMs: Date.now() - startTime,
    },
  };
}

export function dumpConversation(conversationId: string): DebugDump {
  const convDir = getConversationsDir();
  const dbPath = path.join(convDir, `${conversationId}.db`);
  return dumpConversationDb(dbPath);
}

export function dumpSummaries(): SummaryDump {
  const startTime = Date.now();
  const dbPath = path.join(getAgyDataDir(), 'conversation_summaries.db');

  if (!fssync.existsSync(dbPath)) {
    return {
      dbPath,
      totalConversations: 0,
      conversations: [],
      stats: {
        totalConversations: 0,
        withTitle: 0,
        withPreview: 0,
        killed: 0,
        avgSteps: 0,
        oldestConversation: null,
        newestConversation: null,
      },
      durationMs: Date.now() - startTime,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC').all() as SummaryRecord[];
  db.close();

  for (const r of rows) {
    if (r.workspace_uris) {
      try {
        r.workspace_uris = JSON.parse(decodeURIComponent(r.workspace_uris));
      } catch { /* keep raw */ }
    }
  }

  const total = rows.length;
  const withTitle = rows.filter(r => r.title && r.title.trim().length > 0).length;
  const withPreview = rows.filter(r => r.preview && r.preview.trim().length > 0).length;
  const killed = rows.filter(r => r.killed === 1).length;
  const totalSteps = rows.reduce((s, r) => s + (r.step_count || 0), 0);

  const times = rows.map(r => r.last_modified_time).filter(Boolean) as string[];
  times.sort();

  return {
    dbPath,
    totalConversations: total,
    conversations: rows,
    stats: {
      totalConversations: total,
      withTitle,
      withPreview,
      killed,
      avgSteps: total > 0 ? Math.round(totalSteps / total) : 0,
      oldestConversation: times[0] || null,
      newestConversation: times[times.length - 1] || null,
    },
    durationMs: Date.now() - startTime,
  };
}

export function dumpAll(): { summaries: SummaryDump; conversations: { id: string; dump: DebugDump }[] } {
  const summaries = dumpSummaries();
  const convs = listConversations().slice(0, 5).map(c => ({
    id: c.id,
    dump: dumpConversationDb(c.dbPath),
  }));
  return { summaries, conversations: convs };
}

export function listConversations(): { id: string; dbPath: string }[] {
  const convDir = getConversationsDir();
  if (!fssync.existsSync(convDir)) return [];
  return fssync.readdirSync(convDir)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ id: f.replace(/\.db$/, ''), dbPath: path.join(convDir, f) }));
}

function stepTypeLabel(st: number): string {
  switch (st) {
    case 8: return 'user';
    case 9: return 'assistant';
    case 14: return 'thinking';
    case 15: return 'tool';
    case 17: return 'observation';
    case 23: return 'assistant(23)';
    case 98: return 'title';
    default: return `unknown(${st})`;
  }
}

export async function debugDumpToFile(conversationId: string, outputPath?: string): Promise<string> {
  const dump = dumpConversation(conversationId);
  const out = outputPath || `/tmp/agy-debug-${conversationId}.json`;
  const json = JSON.stringify(dump, null, 2);
  await fssync.promises.writeFile(out, json, 'utf8');
  return out;
}

export async function debugSummariesToFile(outputPath?: string): Promise<string> {
  const dump = dumpSummaries();
  const out = outputPath || '/tmp/agy-summaries-debug.json';
  const json = JSON.stringify(dump, null, 2);
  await fssync.promises.writeFile(out, json, 'utf8');
  return out;
}
