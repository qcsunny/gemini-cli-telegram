/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file protobuf.test.ts
 * @description Unit tests for src/agy/protobuf.ts: the manual protobuf
 * wire-format decoder (extractUsageFromProto) and the SQLite readers
 * (getMaxStepIdx / readUsageFromDatabase / readConversationHistory).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fssync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  extractUsageFromProto,
  getMaxStepIdx,
  readUsageFromDatabase,
  readConversationHistory,
} from './protobuf.js';

/* ---------------- manual protobuf wire-format builders ---------------- */

/** Encode an unsigned integer as a protobuf base-128 varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function tag(fieldNum: number, wireType: number): number {
  return (fieldNum << 3) | wireType;
}

/** varint field (wire type 0). */
function vField(fieldNum: number, value: number): number[] {
  return [tag(fieldNum, 0), ...varint(value)];
}

/** length-delimited field (wire type 2). */
function sField(fieldNum: number, bytes: number[]): number[] {
  return [tag(fieldNum, 2), ...varint(bytes.length), ...bytes];
}

const u8 = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);

/**
 * agy usage metadata (reverse-engineered schema):
 *   message StepMetadata  { UsageMetadata usage = 9; }
 *   message UsageMetadata { int64 input = 2; int64 output = 3;
 *                           int64 cached = 5; int64 thinking = 10; }
 */
function usageBlob(input: number, output: number, cached: number, thinking: number): Uint8Array {
  const sub = [
    ...vField(2, input),
    ...vField(3, output),
    ...vField(5, cached),
    ...vField(10, thinking),
  ];
  return u8([tag(9, 2), ...varint(sub.length), ...sub]);
}

/* ---------------- sqlite fixture helpers ---------------- */

let tmpDir: string;

const STEPS_MINIMAL =
  'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER, metadata BLOB)';
const STEPS_FULL =
  'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB, step_format INTEGER, has_subtrajectory INTEGER, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB)';

function openDb(file: string, schema: string) {
  const db = new Database(path.join(tmpDir, file));
  db.exec(schema);
  return db;
}

/** Protobuf step payload with one length-delimited UTF-8 string field. */
function textPayload(text: string, fieldNum = 1): Buffer {
  return Buffer.from(sField(fieldNum, [...Buffer.from(text, 'utf8')]));
}

/** Protobuf step payload with several length-delimited UTF-8 string fields. */
function textPayloads(fields: Array<[number, string]>): Buffer {
  const bytes: number[] = [];
  for (const [fieldNum, text] of fields) {
    bytes.push(...sField(fieldNum, [...Buffer.from(text, 'utf8')]));
  }
  return Buffer.from(bytes);
}

beforeAll(() => {
  tmpDir = fssync.mkdtempSync(path.join(os.tmpdir(), 'agy-protobuf-test-'));
});

afterAll(() => {
  fssync.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- extractUsageFromProto ---------------- */

describe('extractUsageFromProto', () => {
  it('parses a normal usage message (field 9 with nested varint fields 2/3/5/10)', () => {
    const msg = usageBlob(100, 50, 30, 10);
    expect(extractUsageFromProto(msg)).toEqual({ input: 100, output: 50, cached: 30, thinking: 10 });
  });

  it('parses multi-byte varint values (>127 need 2+ bytes)', () => {
    // Guard: the encoder must really produce multi-byte varints for these values.
    expect(varint(300)).toEqual([0xac, 0x02]);
    expect(varint(16384)).toEqual([0x80, 0x80, 0x01]);
    expect(varint(200000)).toEqual([0xc0, 0x9a, 0x0c]);

    const msg = usageBlob(300, 1000, 16384, 200000);
    expect(extractUsageFromProto(msg)).toEqual({ input: 300, output: 1000, cached: 16384, thinking: 200000 });
  });

  it('decodes a raw hand-built multi-byte varint (input=300 as 0xAC 0x02)', () => {
    const raw = u8([tag(9, 2), 3, tag(2, 0), 0xac, 0x02]);
    expect(extractUsageFromProto(raw)).toEqual({ input: 300, output: 0, cached: 0, thinking: 0 });
  });

  it('accepts a truncated varint as a partial value (no validation in parseVarint)', () => {
    // Declares sub-message length 2 but field 2's varint needs 3 bytes; the
    // decoder silently keeps only the first byte (0xAC & 0x7F = 44).
    const raw = u8([tag(9, 2), 2, tag(2, 0), 0xac, 0x02]);
    expect(extractUsageFromProto(raw)).toEqual({ input: 44, output: 0, cached: 0, thinking: 0 });
  });

  it('returns null for an empty Uint8Array', () => {
    expect(extractUsageFromProto(new Uint8Array(0))).toBeNull();
  });

  it('returns a zeroed usage object when the field-9 tag has no length byte left', () => {
    // Truncated at the tag: parseVarint finds no length bytes and yields len=0.
    expect(extractUsageFromProto(u8([tag(9, 2)]))).toEqual({ input: 0, output: 0, cached: 0, thinking: 0 });
  });

  it('returns a zeroed usage object when field 9 carries an empty sub-message', () => {
    expect(extractUsageFromProto(u8([tag(9, 2), 0]))).toEqual({ input: 0, output: 0, cached: 0, thinking: 0 });
  });

  it('returns null when the declared field-9 length runs past the end of the buffer', () => {
    expect(extractUsageFromProto(u8([tag(9, 2), 5, tag(2, 0), 42]))).toBeNull();
  });

  it('returns null for garbage bytes or messages without a field-9 length-delimited field', () => {
    expect(extractUsageFromProto(u8([0xff, 0xff]))).toBeNull();
    expect(extractUsageFromProto(u8([tag(1, 0), 42]))).toBeNull();
  });

  it('does not treat field 9 with a varint wire type as usage', () => {
    expect(extractUsageFromProto(u8([tag(9, 0), 42]))).toBeNull();
  });

  it('skips unknown top-level fields before field 9', () => {
    const sub = [...vField(2, 100), ...vField(3, 50), ...vField(5, 30), ...vField(10, 10)];
    const msg = u8([
      ...vField(1, 99),
      ...sField(2, [...Buffer.from('junk', 'utf8')]),
      tag(9, 2), ...varint(sub.length), ...sub,
    ]);
    expect(extractUsageFromProto(msg)).toEqual({ input: 100, output: 50, cached: 30, thinking: 10 });
  });

  it('skips unknown sub-fields inside the usage message (varint, string, fixed64, fixed32)', () => {
    const sub = [
      ...vField(1, 99),
      ...sField(4, [0x68, 0x69]),
      tag(6, 1), 0, 0, 0, 0, 0, 0, 0, 0,
      tag(7, 5), 0, 0, 0, 0,
      ...vField(2, 100),
      ...vField(3, 200),
      ...vField(5, 50),
      ...vField(10, 25),
    ];
    const msg = u8([tag(9, 2), ...varint(sub.length), ...sub]);
    expect(extractUsageFromProto(msg)).toEqual({ input: 100, output: 200, cached: 50, thinking: 25 });
  });
});

/* ---------------- getMaxStepIdx ---------------- */

describe('getMaxStepIdx', () => {
  it('returns -1 for a nonexistent db path', () => {
    expect(getMaxStepIdx(path.join(tmpDir, 'does-not-exist.db'))).toBe(-1);
  });

  it('returns -1 for a corrupt (non-sqlite) file', () => {
    const p = path.join(tmpDir, 'corrupt.db');
    fssync.writeFileSync(p, 'definitely not a sqlite database file, just plain text.');
    expect(getMaxStepIdx(p)).toBe(-1);
  });

  it('returns -1 when the steps table has no rows', () => {
    const db = openDb('max-empty.db', STEPS_MINIMAL);
    db.close();
    expect(getMaxStepIdx(path.join(tmpDir, 'max-empty.db'))).toBe(-1);
  });

  it('returns the largest stored idx', () => {
    const db = openDb('max-rows.db', STEPS_MINIMAL);
    const ins = db.prepare('INSERT INTO steps (idx) VALUES (?)');
    for (const i of [3, 7, 12]) ins.run(i);
    db.close();
    expect(getMaxStepIdx(path.join(tmpDir, 'max-rows.db'))).toBe(12);
  });
});

/* ---------------- readUsageFromDatabase ---------------- */

describe('readUsageFromDatabase', () => {
  it('returns undefined when the db does not exist', () => {
    expect(readUsageFromDatabase(path.join(tmpDir, 'nope.db'))).toBeUndefined();
  });

  it('returns undefined when the file is a valid sqlite db without a steps table', () => {
    const db = new Database(path.join(tmpDir, 'usage-notable.db'));
    db.exec('CREATE TABLE other (x INTEGER)');
    db.close();
    expect(readUsageFromDatabase(path.join(tmpDir, 'usage-notable.db'))).toBeUndefined();
  });

  it('sums usage across all steps when fromIdx is -1 (default)', () => {
    const db = openDb('usage-all.db', STEPS_MINIMAL);
    const ins = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    ins.run(0, 15, usageBlob(1, 2, 3, 4));
    ins.run(1, 23, usageBlob(10, 20, 30, 40));
    db.close();
    expect(readUsageFromDatabase(path.join(tmpDir, 'usage-all.db')))
      .toEqual({ input: 11, output: 22, cached: 33, thinking: 44 });
  });

  it('only sums steps with idx > fromIdx (exclusive)', () => {
    const db = openDb('usage-fromidx.db', STEPS_MINIMAL);
    const ins = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    ins.run(0, 15, usageBlob(100, 100, 100, 100));
    ins.run(1, 23, usageBlob(200, 200, 200, 200));
    ins.run(2, 15, usageBlob(1, 2, 3, 4));
    db.close();
    const p = path.join(tmpDir, 'usage-fromidx.db');
    expect(readUsageFromDatabase(p, 1)).toEqual({ input: 1, output: 2, cached: 3, thinking: 4 });
    expect(readUsageFromDatabase(p, 0)).toEqual({ input: 201, output: 202, cached: 203, thinking: 204 });
    expect(readUsageFromDatabase(p, 2)).toBeUndefined();
  });

  it('returns undefined when steps after fromIdx carry only all-zero usage', () => {
    // field 9 with an empty sub-message decodes to a zeroed (non-null) usage object.
    const db = openDb('usage-zero.db', STEPS_MINIMAL);
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(0, 15, u8([tag(9, 2), 0]));
    db.close();
    expect(readUsageFromDatabase(path.join(tmpDir, 'usage-zero.db'))).toBeUndefined();
  });

  it('ignores steps whose metadata is NULL or has no field-9 usage message', () => {
    const db = openDb('usage-nof9.db', STEPS_MINIMAL);
    const ins = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    ins.run(0, 15, null);
    ins.run(1, 15, Buffer.from([tag(1, 0), 42]));
    ins.run(2, 15, usageBlob(5, 6, 7, 8));
    db.close();
    expect(readUsageFromDatabase(path.join(tmpDir, 'usage-nof9.db')))
      .toEqual({ input: 5, output: 6, cached: 7, thinking: 8 });
  });
});

/* ---------------- readConversationHistory ---------------- */

describe('readConversationHistory', () => {
  it('returns null when the db does not exist', () => {
    expect(readConversationHistory(path.join(tmpDir, 'nope-conv.db'))).toBeNull();
  });

  it('returns an empty array for an empty steps table', () => {
    const db = openDb('conv-empty.db', STEPS_FULL);
    db.close();
    expect(readConversationHistory(path.join(tmpDir, 'conv-empty.db'))).toEqual([]);
  });

  it('maps step types to roles and preserves idx order', () => {
    const db = openDb('conv-roles.db', STEPS_FULL);
    const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
    const rows: Array<[number, number, string]> = [
      [0, 8, 'user question text'],
      [1, 9, 'assistant reply text'],
      [2, 14, 'thinking inner monologue'],
      [3, 15, 'tool call result text'],
      [4, 17, 'observation after tool'],
      [5, 23, 'final output message'],
      [6, 98, 'conversation title here'],
      [7, 3, 'unknown step type row'],
    ];
    for (const [idx, stepType, text] of rows) ins.run(idx, stepType, textPayload(text));
    db.close();

    const turns = readConversationHistory(path.join(tmpDir, 'conv-roles.db'));
    expect(turns).not.toBeNull();
    expect(turns!.map(t => t.role)).toEqual(
      ['user', 'assistant', 'thinking', 'tool', 'observation', 'assistant', 'title', 'unknown'],
    );
    expect(turns!.map(t => t.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(turns!.map(t => t.stepType)).toEqual([8, 9, 14, 15, 17, 23, 98, 3]);
  });

  it('uses the longest plausible length-delimited string as content', () => {
    const db = openDb('conv-longest.db', STEPS_FULL);
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
      .run(0, 9, textPayloads([[1, 'hi'], [2, 'hello world'], [3, 'the longest string of all']]));
    db.close();

    const turns = readConversationHistory(path.join(tmpDir, 'conv-longest.db'));
    expect(turns).toHaveLength(1);
    expect(turns![0].content).toBe('the longest string of all');
  });

  it('skips rows with NULL payloads or payloads without plausible strings', () => {
    const db = openDb('conv-skip.db', STEPS_FULL);
    const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
    ins.run(0, 8, null);
    ins.run(1, 9, Buffer.from([1, 2, 3]));
    ins.run(2, 8, textPayloads([[1, 'hi']]));
    ins.run(3, 9, textPayload('only visible turn text'));
    db.close();

    const turns = readConversationHistory(path.join(tmpDir, 'conv-skip.db'));
    expect(turns).toHaveLength(1);
    expect(turns![0]).toMatchObject({ role: 'assistant', content: 'only visible turn text', idx: 3 });
  });

  it('maps column values and decodes blob/text columns', () => {
    const db = openDb('conv-cols.db', STEPS_FULL);
    const ins = db.prepare(`INSERT INTO steps
      (idx, step_type, status, step_payload, metadata, step_format, has_subtrajectory,
       error_details, permissions, task_details, render_info)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(
      0, 8, 1,
      textPayload('user message here'),
      Buffer.from([tag(9, 2), 2, tag(2, 0), 2]),
      2, 1,
      Buffer.from('error blob text', 'utf8'),
      null,
      Buffer.from('plain task details', 'utf8'),
      null,
    );
    // A TEXT-stored task_details is not a Uint8Array and is dropped (null).
    ins.run(1, 8, 0, textPayload('second message here'), null, 0, 0, null, null, 'stored as text', null);
    db.close();

    const turns = readConversationHistory(path.join(tmpDir, 'conv-cols.db'));
    expect(turns).toHaveLength(2);
    const turn = turns![0];
    expect(turn).toMatchObject({
      role: 'user',
      content: 'user message here',
      stepType: 8,
      idx: 0,
      status: 1,
      stepFormat: 2,
      hasSubtrajectory: true,
    });
    expect(turn.errorDetails).toBe('error blob text');
    expect(turn.permissions).toBeNull();
    expect(turn.taskDetails).toBe('plain task details');
    expect(turn.renderInfo).toBeNull();
    // extractMetadataFromProto stores the nested field-9 message under the
    // 'field9' key, never under 'usage', so turn.usage is always undefined.
    expect(turn.metadata).toEqual({ field9: { field2: 2 } });
    expect(turn.usage).toBeUndefined();
    expect(turns![1].taskDetails).toBeNull();
  });
});