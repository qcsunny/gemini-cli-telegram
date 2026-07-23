/**
 * @file protobuf.ts
 * @description Protobuf parsing utilities for agy conversation databases.
 * Includes usage extraction, metadata decoding, and conversation history reading.
 */

import * as fssync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import type { AgyRunResult, ConversationTurn } from './types.js';

/** Directory where agy stores conversation SQLite files. */
export function getConversationsDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

export function parseVarint(data: Uint8Array, pos: number): { val: number; nextPos: number } {
  let val = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos];
    val |= (b & 0x7f) << shift;
    pos++;
    if (!(b & 0x80)) {
      break;
    }
    shift += 7;
  }
  return { val, nextPos: pos };
}

/** Exported for testing: manual protobuf decoder for agy usage metadata. */
export function extractUsageFromProto(m: Uint8Array): AgyRunResult['usage'] | null {
  let pos = 0;
  while (pos < m.length) {
    let pTag;
    try {
      pTag = parseVarint(m, pos);
    } catch (e) {
      break;
    }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;
    
    const wireType = tag & 7;
    const fieldNum = tag >> 3;
    
    if (fieldNum === 9 && wireType === 2) {
      // Found field 9! Let's decode it
      let pLen;
      try {
        pLen = parseVarint(m, pos);
      } catch (e) {
        break;
      }
      const len = pLen.val;
      pos = pLen.nextPos;
      if (pos + len > m.length) break;
      
      const subM = m.subarray(pos, pos + len);
      let subPos = 0;
      const usage = { input: 0, output: 0, cached: 0, thinking: 0 };
      
      while (subPos < subM.length) {
        let pSubTag;
        try {
          pSubTag = parseVarint(subM, subPos);
        } catch (e) {
          break;
        }
        const subTag = pSubTag.val;
        subPos = pSubTag.nextPos;
        if (subPos > subM.length) break;
        
        const subWireType = subTag & 7;
        const subFieldNum = subTag >> 3;
        
        if (subWireType === 0) { // Varint
          let pSubVal;
          try {
            pSubVal = parseVarint(subM, subPos);
          } catch (e) {
            break;
          }
          const val = pSubVal.val;
          subPos = pSubVal.nextPos;
          
          if (subFieldNum === 2) usage.input = val;
          else if (subFieldNum === 3) usage.output = val;
          else if (subFieldNum === 5) usage.cached = val;
          else if (subFieldNum === 10) usage.thinking = val;
        } else if (subWireType === 1) {
          subPos += 8;
        } else if (subWireType === 2) {
          let pSubLen;
          try {
            pSubLen = parseVarint(subM, subPos);
          } catch (e) {
            break;
          }
          subPos = pSubLen.nextPos + pSubLen.val;
        } else if (subWireType === 5) {
          subPos += 4;
        } else {
          subPos++;
        }
      }
      return usage;
    } else {
      // Skip this field
      if (wireType === 0) {
        let pVal;
        try {
          pVal = parseVarint(m, pos);
        } catch (e) {
          break;
        }
        pos = pVal.nextPos;
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 2) {
        let pLen;
        try {
          pLen = parseVarint(m, pos);
        } catch (e) {
          break;
        }
        pos = pLen.nextPos + pLen.val;
      } else if (wireType === 5) {
        pos += 4;
      } else {
        pos++;
      }
    }
  }
  return null;
}

/**
 * Exported for testing: full metadata protobuf decoder, extracting all known
 * fields for debugging. Returns a plain object with key/value pairs.
 */
export function extractMetadataFromProto(m: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let pos = 0;

  while (pos < m.length) {
    let pTag;
    try { pTag = parseVarint(m, pos); } catch { break; }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;

    const wireType = tag & 7;
    const fieldNum = tag >> 3;

    if (wireType === 0) {
      try {
        const v = parseVarint(m, pos);
        result[`field${fieldNum}`] = v.val;
        pos = v.nextPos;
      } catch { break; }
    } else if (wireType === 1) {
      result[`field${fieldNum}`] = Buffer.from(m.slice(pos, pos + 8)).toString('hex');
      pos += 8;
    } else if (wireType === 2) {
      try {
        const pLen = parseVarint(m, pos);
        const len = pLen.val;
        pos = pLen.nextPos;
        if (pos + len > m.length) break;
        const slice = m.subarray(pos, pos + len);
        const decoded = new TextDecoder().decode(slice);

        // Classify known string fields
        if (fieldNum === 4) {
          result['toolCall'] = decoded;
        } else if (fieldNum === 5) {
          if (!result['labels']) result['labels'] = [];
          (result['labels'] as string[]).push(decoded);
        } else if (fieldNum === 9) {
          result['field9_raw'] = decoded.slice(0, 120) + (decoded.length > 120 ? '...' : '');
        } else if (fieldNum === 12) {
          result['convId'] = decoded;
        } else if (fieldNum === 20) {
          result['convTree'] = decoded.slice(0, 120);
        } else if (fieldNum === 30) {
          result['title'] = decoded;
        } else if (fieldNum === 31) {
          result['description'] = decoded;
        } else {
          result[`field${fieldNum}`] = decoded.length > 100 ? decoded.slice(0, 100) + '...' : decoded;
        }
        pos += len;
      } catch { break; }
    } else if (wireType === 5) {
      result[`field${fieldNum}`] = Buffer.from(m.slice(pos, pos + 4)).toString('hex');
      pos += 4;
    } else {
      pos++;
    }
  }

  return result;
}

/** Exported for testing: reads agy DB and extracts usage metadata. */
export function readUsageFromDatabase(dbPath: string): AgyRunResult['usage'] | undefined {
  try {
    if (!fssync.existsSync(dbPath)) {
      return undefined;
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC').all() as any[];
    db.close();
    
    for (const row of rows) {
      if (row.metadata instanceof Uint8Array) {
        const usage = extractUsageFromProto(row.metadata);
        if (usage) {
          return usage;
        }
      }
    }
  } catch (e) {
    logger.warn(`[agyCli] readUsageFromDatabase failed: ${e}`);
  }
  return undefined;
}

/** Decode a blob as plain UTF-8 text, with null-bytes stripped and non-printable chars replaced. */
export function decodePlainText(b: Uint8Array): string {
  const decoded = new TextDecoder().decode(b);
  return decoded.replace(/\0+$/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '?');
}

export function stepTypeToRole(stepType: number): ConversationTurn['role'] {
  switch (stepType) {
    case 8: return 'user';
    case 9: return 'assistant';
    case 14: return 'thinking';
    case 15: return 'tool';
    case 17: return 'observation';
    case 23: return 'assistant';
    case 98: return 'title';
    default: return 'unknown';
  }
}

/**
 * Generic protobuf-to-text extractor. Walks all length-delimited (wire type 2)
 * fields and returns the longest plausible string.
 */
export function extractTextFromProto(m: Uint8Array): string | null {
  let pos = 0;
  const strings: string[] = [];

  while (pos < m.length) {
    let pTag;
    try {
      pTag = parseVarint(m, pos);
    } catch {
      break;
    }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;

    const wireType = tag & 7;

    if (wireType === 0) {
      try { const p = parseVarint(m, pos); pos = p.nextPos; } catch { break; }
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      try {
        const pLen = parseVarint(m, pos);
        const len = pLen.val;
        pos = pLen.nextPos;
        if (pos + len > m.length) break;

        const slice = m.subarray(pos, pos + len);
        const decoded = new TextDecoder().decode(slice);

        if (decoded.length >= 4 && isPlausibleText(decoded)) {
          strings.push(decoded);
        }

        pos += len;
      } catch { break; }
    } else if (wireType === 5) {
      pos += 4;
    } else {
      pos++;
    }
  }

  if (strings.length === 0) return null;
  return strings.reduce((a, b) => a.length >= b.length ? a : b);
}

/** Quick heuristic: >70% printable / whitespace / common Unicode characters. */
export function isPlausibleText(s: string): boolean {
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code <= 126) printable++;
    else if (code === 10 || code === 13 || code === 9) printable++;
    else if (code > 127) printable++;
  }
  return printable / s.length > 0.7;
}

/**
 * Reads the full conversation history from an agy SQLite database, decoding
 * each step's protobuf payload back into readable text.
 */
export function readConversationHistory(dbPath: string): ConversationTurn[] | null {
  try {
    if (!fssync.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT idx, step_type, status, step_payload, metadata, step_format, has_subtrajectory, error_details, permissions, task_details, render_info FROM steps ORDER BY idx ASC').all() as any[];
    db.close();

    const turns: ConversationTurn[] = [];

    for (const row of rows) {
      if (!(row.step_payload instanceof Uint8Array)) continue;

      const text = extractTextFromProto(row.step_payload);
      if (!text) continue;

      const stepType = Number(row.step_type);
      const role = stepTypeToRole(stepType);
      const md = row.metadata instanceof Uint8Array ? extractMetadataFromProto(row.metadata) : null;
      turns.push({
        role,
        content: text,
        stepType,
        idx: Number(row.idx),
        status: Number(row.status ?? 0),
        stepFormat: Number(row.step_format ?? 0),
        hasSubtrajectory: row.has_subtrajectory === 1 || row.has_subtrajectory === true,
        usage: ((md?.['usage'] ?? undefined) as ConversationTurn['usage']),
        metadata: md,
        errorDetails: row.error_details instanceof Uint8Array ? extractTextFromProto(row.error_details) ?? decodePlainText(row.error_details) : null,
        permissions: row.permissions instanceof Uint8Array ? extractTextFromProto(row.permissions) ?? decodePlainText(row.permissions) : null,
        taskDetails: row.task_details instanceof Uint8Array ? decodePlainText(row.task_details) : null,
        renderInfo: row.render_info instanceof Uint8Array ? decodePlainText(row.render_info) : null,
      });
    }

    return turns;
  } catch (e) {
    logger.warn(`[agyCli] readConversationHistory failed: ${e}`);
    return null;
  }
}
