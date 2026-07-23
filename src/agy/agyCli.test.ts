import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Build a minimal protobuf blob matching agy's usage metadata format.
 *
 * Protobuf schema (reverse-engineered):
 *   message UsageMetadata {
 *     optional int64 input  = 2;
 *     optional int64 output = 3;
 *     optional int64 cached = 5;
 *     optional int64 thinking = 10;
 *   }
 *
 *   message StepMetadata {
 *     optional UsageMetadata usage = 9;
 *   }
 */
function makeUsageBlob(input: number, output: number, cached: number, thinking: number): Buffer {
  const encodeVarint = (val: number): number[] => {
    const bytes: number[] = [];
    while (val >= 0x80) {
      bytes.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    bytes.push(val & 0x7f);
    return bytes;
  };

  const usageFields: number[] = [];
  const appendField = (fieldNum: number, val: number) => {
    const tag = (fieldNum << 3) | 0;
    usageFields.push(...encodeVarint(tag), ...encodeVarint(val));
  };
  appendField(2, input);
  appendField(3, output);
  appendField(5, cached);
  appendField(10, thinking);

  const tag9 = (9 << 3) | 2;
  return Buffer.from([...encodeVarint(tag9), ...encodeVarint(usageFields.length), ...usageFields]);
}

describe('extractUsageFromProto', () => {
  it('should parse a valid usage blob', { timeout: 30000 }, async () => {
    const { extractUsageFromProto } = await import('../agy/agyCli.js');
    const blob = makeUsageBlob(100, 200, 50, 25);
    const result = extractUsageFromProto(new Uint8Array(blob));
    expect(result).toEqual({ input: 100, output: 200, cached: 50, thinking: 25 });
  });

  it('should return null for empty buffer', async () => {
    const { extractUsageFromProto } = await import('../agy/agyCli.js');
    expect(extractUsageFromProto(new Uint8Array([]))).toBeNull();
  });

  it('should handle zero values', async () => {
    const { extractUsageFromProto } = await import('../agy/agyCli.js');
    const blob = makeUsageBlob(0, 0, 0, 0);
    const result = extractUsageFromProto(new Uint8Array(blob));
    expect(result).toEqual({ input: 0, output: 0, cached: 0, thinking: 0 });
  });

  it('should handle large token counts', async () => {
    const { extractUsageFromProto } = await import('../agy/agyCli.js');
    const blob = makeUsageBlob(999999, 888888, 777777, 666666);
    const result = extractUsageFromProto(new Uint8Array(blob));
    expect(result).toEqual({ input: 999999, output: 888888, cached: 777777, thinking: 666666 });
  });
});

describe('readUsageFromDatabase', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-db-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should read usage from a valid database', async () => {
    const { readUsageFromDatabase } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'valid.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, metadata BLOB);`);
    const blob = makeUsageBlob(42, 99, 10, 5);
    db.prepare('INSERT INTO steps (idx, status, metadata) VALUES (0, 0, ?)').run(blob);
    db.close();

    const result = readUsageFromDatabase(dbPath);
    expect(result).toEqual({ input: 42, output: 99, cached: 10, thinking: 5 });
  });

  it('should return undefined when database does not exist', async () => {
    const { readUsageFromDatabase } = await import('../agy/agyCli.js');
    const result = readUsageFromDatabase('/nonexistent/path.db');
    expect(result).toBeUndefined();
  });

  it('should return undefined when steps table is empty', async () => {
    const { readUsageFromDatabase } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'empty.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, metadata BLOB);`);
    db.close();

    const result = readUsageFromDatabase(dbPath);
    expect(result).toBeUndefined();
  });

  it('should return undefined when metadata is null', async () => {
    const { readUsageFromDatabase } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'null-metadata.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, metadata BLOB);`);
    db.prepare('INSERT INTO steps (idx, status, metadata) VALUES (0, 0, NULL)').run();
    db.close();

    const result = readUsageFromDatabase(dbPath);
    expect(result).toBeUndefined();
  });

  it('should use the latest step (highest idx)', async () => {
    const { readUsageFromDatabase } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'latest.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, metadata BLOB);`);
    // Insert older step first (idx=0), then newer step (idx=1)
    const oldBlob = makeUsageBlob(1, 2, 3, 4);
    const newBlob = makeUsageBlob(10, 20, 30, 40);
    db.prepare('INSERT INTO steps (idx, status, metadata) VALUES (0, 0, ?)').run(oldBlob);
    db.prepare('INSERT INTO steps (idx, status, metadata) VALUES (1, 0, ?)').run(newBlob);
    db.close();

    const result = readUsageFromDatabase(dbPath);
    // Should return the latest step (idx=1)
    expect(result).toEqual({ input: 10, output: 20, cached: 30, thinking: 40 });
  });
});

describe('readConversationHistory', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-conv-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a protobuf blob with a single string field (field 1, wire type 2). */
  function makePayloadBlob(text: string): Buffer {
    const encodeVarint = (val: number): number[] => {
      const bytes: number[] = [];
      while (val >= 0x80) {
        bytes.push((val & 0x7f) | 0x80);
        val >>>= 7;
      }
      bytes.push(val & 0x7f);
      return bytes;
    };
    const tag1 = (1 << 3) | 2; // field 1, wire type 2 (length-delimited)
    const textBytes = Buffer.from(text, 'utf-8');
    return Buffer.from([...encodeVarint(tag1), ...encodeVarint(textBytes.length), ...textBytes]);
  }

  it('should read user and assistant turns from a valid database', async () => {
    const { readConversationHistory } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'valid-conv.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB, step_format INTEGER, has_subtrajectory NUMERIC, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB);`);

    const userBlob = makePayloadBlob('What is TCP?');
    const asstBlob = makePayloadBlob('## TCP\n\nTCP is a transport layer protocol.');
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (0, 8, 1, ?, NULL, 0)').run(userBlob);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (1, 9, 0, ?, NULL, 1)').run(asstBlob);
    db.close();

    const result = readConversationHistory(dbPath);
    expect(result).toHaveLength(2);
    expect(result![0]).toMatchObject({ role: 'user', content: 'What is TCP?', stepType: 8, status: 1, stepFormat: 0 });
    expect(result![1]).toMatchObject({ role: 'assistant', content: '## TCP\n\nTCP is a transport layer protocol.', stepType: 9, status: 0, stepFormat: 1 });
  });

  it('should include thinking steps when present', async () => {
    const { readConversationHistory } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'include-think.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB, step_format INTEGER, has_subtrajectory NUMERIC, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB);`);

    const userBlob = makePayloadBlob('Hello');
    const thinkBlob = makePayloadBlob('thinking deep thoughts');
    const asstBlob = makePayloadBlob('Hi there!');
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (0, 8, 1, ?, NULL, 0)').run(userBlob);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (1, 14, 0, ?, NULL, 0)').run(thinkBlob);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (2, 9, 0, ?, NULL, 0)').run(asstBlob);
    db.close();

    const result = readConversationHistory(dbPath);
    expect(result).toHaveLength(3);
    expect(result![0].role).toBe('user');
    expect(result![1].role).toBe('thinking');
    expect(result![2].role).toBe('assistant');
  });

  it('should handle final output steps (type 23) as assistant', async () => {
    const { readConversationHistory } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'final-output.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB, step_format INTEGER, has_subtrajectory NUMERIC, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB);`);

    const userBlob = makePayloadBlob('Write code');
    const finalBlob = makePayloadBlob('```python\nprint("hello")\n```');
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (0, 8, 1, ?, NULL, 0)').run(userBlob);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, metadata, step_format) VALUES (1, 23, 0, ?, NULL, 0)').run(finalBlob);
    db.close();

    const result = readConversationHistory(dbPath);
    expect(result).toHaveLength(2);
    expect(result![1].role).toBe('assistant');
    expect(result![1].content).toContain('python');
  });

  it('should return null when database does not exist', async () => {
    const { readConversationHistory } = await import('../agy/agyCli.js');
    const result = readConversationHistory('/nonexistent/path.db');
    expect(result).toBeNull();
  });

  it('should return empty array when no user/assistant steps exist', async () => {
    const { readConversationHistory } = await import('../agy/agyCli.js');
    const dbPath = path.join(tmpDir, 'empty-conv.db');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB, step_format INTEGER, has_subtrajectory NUMERIC, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB);`);
    db.close();

    const result = readConversationHistory(dbPath);
    expect(result).toEqual([]);
  });
});

describe('isWeb2ApiModel / isDeepSeekModel', () => {
  it('should identify Web2API models', async () => {
    const { isWeb2ApiModel } = await import('../agy/agyCli.js');
    expect(isWeb2ApiModel('Web2API: Gemini 3.6 Flash')).toBe(true);
    expect(isWeb2ApiModel('Web2API: Gemini Auto')).toBe(true);
  });

  it('should not identify non-Web2API models', async () => {
    const { isWeb2ApiModel } = await import('../agy/agyCli.js');
    expect(isWeb2ApiModel('Gemini 3.6 Flash (High)')).toBe(false);
    expect(isWeb2ApiModel('DeepSeek: Pro')).toBe(false);
    expect(isWeb2ApiModel('Claude Opus 4.6 (Thinking)')).toBe(false);
  });

  it('should identify DeepSeek models', async () => {
    const { isDeepSeekModel } = await import('../agy/agyCli.js');
    expect(isDeepSeekModel('DeepSeek: Pro')).toBe(true);
    expect(isDeepSeekModel('DeepSeek: Flash Thinking')).toBe(true);
  });

  it('should not identify non-DeepSeek models', async () => {
    const { isDeepSeekModel } = await import('../agy/agyCli.js');
    expect(isDeepSeekModel('Gemini 3.6 Flash (High)')).toBe(false);
    expect(isDeepSeekModel('Web2API: Gemini Auto')).toBe(false);
  });
});

describe('getAvailableModels', () => {
  it('should return model list from config orderedModels when present', async () => {
    const { getAvailableModels } = await import('../agy/agyCli.js');
    const userConfig = await import('../config/userConfig.js');
    vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
      telegramBotToken: 'token',
      allowedUsers: [1],
      orderedModels: ['custom-a', 'custom-b'],
    } as any);

    const models = await getAvailableModels();
    expect(models).toEqual(['custom-a', 'custom-b']);
  });

  it('should fall back to default order when no config', async () => {
    const { getAvailableModels } = await import('../agy/agyCli.js');
    const userConfig = await import('../config/userConfig.js');
    vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);

    const models = await getAvailableModels();
    // Should return models from models.json defaultOrder
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });
});
