// @vitest-environment node
/**
 * @file opencode.test.ts
 * @description Unit tests for the opencode backend session-reuse logic:
 *  1. findSessionIdByConvId finds an existing tagged session in opencode.db
 *  2. runOpenCode reuses --session when a session already exists
 *  3. runOpenCode tags a fresh session with --title when none exists
 *  4. db lookup failures degrade gracefully (still spawns a new session)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

let tmpDir = '';
let spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: vi.fn(() => ({
    routing: { 'OpenCode: DeepSeek V4 Flash Free': 'opencode/deepseek-v4-flash-free' },
  })),
}));

vi.mock('../../agy/conversationManager.js', () => ({
  opencodeHistories: new Map(),
  makeOpenCodeConvId: vi.fn(() => 'opencode-new-conv'),
}));

vi.mock('../../agy/messageStore.js', () => ({
  saveMessage: vi.fn(),
  saveMessageTurn: vi.fn(),
  deleteKnownConversation: vi.fn(),
}));

vi.mock('../../config/userConfig.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../config/userConfig.js')>();
  return {
    ...mod,
    getOpenCodeDbPath: vi.fn(() => path.join(tmpDir, 'opencode.db')),
  };
});

function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('opencode session reuse', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
    spawnMock = vi.fn(() => makeFakeChild());
  });

  afterEach(() => {
    vi.clearAllMocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('findSessionIdByConvId returns the id of a tagged session', async () => {
    const db = new Database(path.join(tmpDir, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER)`);
    db.prepare(`INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)`)
      .run('ses_abc123', 'gemini-cli-telegram:conv-1', 1000);
    db.close();

    const { findSessionIdByConvId } = await import('./opencode.js');
    expect(findSessionIdByConvId('conv-1')).toBe('ses_abc123');
    expect(findSessionIdByConvId('conv-2')).toBeNull();
  });

  it('findSessionIdByConvId returns null when db is missing (graceful)', async () => {
    const { findSessionIdByConvId } = await import('./opencode.js');
    expect(findSessionIdByConvId('conv-x')).toBeNull();
  });

  it('runOpenCode reuses --session when a tagged session exists', async () => {
    const db = new Database(path.join(tmpDir, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER)`);
    db.prepare(`INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)`)
      .run('ses_reuse', 'gemini-cli-telegram:conv-9', 1000);
    db.close();

    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-9',
      model: 'OpenCode: DeepSeek V4 Flash Free',
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('ses_reuse');
    expect(args.some(a => a.startsWith('--title'))).toBe(false);

    // Drive the child to completion so the promise resolves
    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);
    await p;
  });

  it('runOpenCode accumulates usage across multiple step_finish events (tool-chain replies)', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-usage',
      model: 'OpenCode: DeepSeek V4 Flash Free',
    });

    child.stdout.emit('data', JSON.stringify({
      type: 'step_finish',
      part: {
        reason: 'tool_use',
        tokens: { input: 133, output: 45, reasoning: 10, cache: { read: 23936, write: 0 } },
      },
    }) + '\n');
    child.stdout.emit('data', JSON.stringify({
      type: 'step_finish',
      part: {
        reason: 'stop',
        tokens: { input: 3888, output: 20, reasoning: 15, cache: { read: 24064, write: 5 } },
      },
    }) + '\n');
    child.emit('close', 0);

    const result = await p;
    expect(result.usage).toEqual({ input: 4021, output: 65, cached: 48005, thinking: 25 });
  });

  it('runOpenCode tags a new session with --title when none exists', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-new',
      model: 'OpenCode: DeepSeek V4 Flash Free',
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.some(a => a.startsWith('--title'))).toBe(true);
    expect(args.some(a => a.includes('conv-new'))).toBe(true);
    expect(args).not.toContain('--session');

    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);
    await p;
  });
});
