// @vitest-environment node
/**
 * @file backends.test.ts
 * @description Consolidated unit tests for external CLI backends:
 *  1. Claude CLI Backend (runClaudeCli, getClaudePath, stream-json parsing)
 *  2. Codex CLI Backend (runCodex, getCodexPath, exec resume, token usage)
 *  3. OpenCode Backend (runOpenCode, session reuse, DB live part streaming)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

process.env['OPENCODE_PART_POLL_MS'] = '10';

import { runClaudeCli, getClaudePath } from './claude.js';
import { runCodex, getCodexPath, codexThreadMap } from './codex.js';

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
    routing: {
      'Claude CLI: Claude Opus 5': 'claude-opus-5',
      'Codex: GPT-5.6 Sol': 'gpt-5.6-sol',
      'OpenCode: DeepSeek V4 Flash Free': 'opencode/deepseek-v4-flash-free',
    },
  })),
}));

vi.mock('../../agy/conversationManager.js', () => ({
  opencodeHistories: new Map(),
  makeOpenCodeConvId: vi.fn(() => 'opencode-new-conv'),
  codexHistories: new Map(),
  makeCodexConvId: vi.fn(() => 'codex-new-conv'),
  claudeHistories: new Map(),
  makeClaudeConvId: vi.fn(() => 'claude-new-conv'),
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

function makeFakeChild(pid = 12345) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('Claude CLI Backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should resolve a valid executable path', () => {
    const p = getClaudePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('should spawn claude with correct flags and parse stream-json events', async () => {
    const mockChild = makeFakeChild(12345);
    spawnMock.mockReturnValue(mockChild);

    const onEvent = vi.fn();
    const onChunk = vi.fn();
    const onActivity = vi.fn();
    const onSpawn = vi.fn();

    const runPromise = runClaudeCli({
      prompt: 'Hello Claude',
      model: 'Claude CLI: Claude Opus 5',
      conversationId: '4a62da02-d3cf-41c9-9ed3-fa5cf298e191',
      onEvent,
      onChunk,
      onActivity,
      onSpawn,
    });

    expect(onSpawn).toHaveBeenCalledWith(12345);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'claude-opus-5', '--session-id', '4a62da02-d3cf-41c9-9ed3-fa5cf298e191', 'Hello Claude']),
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: expect.any(String),
          ANTHROPIC_AUTH_TOKEN: expect.any(String),
        }),
      }),
    );

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Thinking step 1...' },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello! I am Claude.' },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'result',
      result: 'Hello! I am Claude.',
      is_error: false,
      usage: {
        input_tokens: 15,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 10 },
      },
    }) + '\n'));

    mockChild.emit('close', 0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('Hello! I am Claude.');
    expect(result.usage).toEqual({
      input: 15,
      output: 20,
      cached: 5,
      thinking: 10,
    });
    expect(onChunk).toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'thought', content: 'Thinking step 1...' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', content: 'Hello! I am Claude.' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('should handle error result and exit code', async () => {
    const mockChild = makeFakeChild();
    spawnMock.mockReturnValue(mockChild);

    const runPromise = runClaudeCli({
      prompt: 'Failing prompt',
      model: 'Claude CLI: Claude Opus 5',
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'result',
      result: 'Not logged in · Please run /login',
      is_error: true,
    }) + '\n'));

    mockChild.emit('close', 1);

    const result = await runPromise;
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('Not logged in · Please run /login');
  });
});

describe('Codex CLI Backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexThreadMap.clear();
  });

  it('should resolve a valid executable path', () => {
    const p = getCodexPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('should spawn codex with exec and parse stream events', async () => {
    const mockChild = makeFakeChild(54321);
    spawnMock.mockReturnValue(mockChild);

    const onEvent = vi.fn();
    const onChunk = vi.fn();
    const onActivity = vi.fn();
    const onSpawn = vi.fn();

    const runPromise = runCodex({
      prompt: 'What is 2+2?',
      model: 'Codex: GPT-5.6 Sol',
      conversationId: 'codex-conv-1',
      onEvent,
      onChunk,
      onActivity,
      onSpawn,
    });

    expect(onSpawn).toHaveBeenCalledWith(54321);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['exec', 'What is 2+2?', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-sol']),
      expect.objectContaining({
        env: expect.objectContaining({
          AGENTROUTER_API_KEY: expect.any(String),
        }),
      }),
    );

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-xyz-789',
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'reasoning', text: 'Computing 2+2...' },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: '2 + 2 = 4' },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 15,
      },
    }) + '\n'));

    mockChild.emit('close', 0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('2 + 2 = 4');
    expect(result.usage).toEqual({
      input: 100,
      output: 30,
      cached: 20,
      thinking: 15,
    });
    expect(codexThreadMap.get('codex-conv-1')).toBe('thread-xyz-789');
    expect(onChunk).toHaveBeenCalledWith('2 + 2 = 4');
    expect(onActivity).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'thought', content: 'Computing 2+2...' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', content: '2 + 2 = 4' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('should resume session when threadId is recorded', async () => {
    codexThreadMap.set('codex-conv-2', 'thread-recorded-123');

    const mockChild = makeFakeChild();
    spawnMock.mockReturnValue(mockChild);

    const runPromise = runCodex({
      prompt: 'Followup question',
      model: 'Codex: GPT-5.6 Sol',
      conversationId: 'codex-conv-2',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['exec', 'resume', 'thread-recorded-123', 'Followup question', '--json', '--skip-git-repo-check']),
      expect.anything(),
    );

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Followup answer' },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.completed',
    }) + '\n'));

    mockChild.emit('close', 0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('Followup answer');
  });

  it('should handle failure exit code and error events', async () => {
    const mockChild = makeFakeChild();
    spawnMock.mockReturnValue(mockChild);

    const runPromise = runCodex({
      prompt: 'Error prompt',
      model: 'Codex: GPT-5.6 Sol',
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Authentication error' },
    }) + '\n'));

    mockChild.emit('close', 1);

    const result = await runPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Authentication error');
  });
});

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

  it('runOpenCode attaches files with --file', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'Describe the attached image',
      cwd: '/tmp',
      conversationId: 'conv-file',
      model: 'OpenCode: DeepSeek V4 Flash Free',
      extraFiles: ['/tmp/example.png', '/tmp/example.pdf'],
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--file', '/tmp/example.png',
      '--file', '/tmp/example.pdf',
    ]));

    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\\n');
    child.emit('close', 0);
    await p;
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
    expect(args.some(a => a === '--session')).toBe(false);

    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);
    await p;
  });

  it('runOpenCode embeds reasoning and tool calls as a <thinking> block in output', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const thoughtEvents: string[] = [];
    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-think',
      model: 'OpenCode: DeepSeek V4 Flash Free',
      onEvent: (event) => { if (event.type === 'thought') thoughtEvents.push(event.content || ''); },
    });

    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { type: 'reasoning', text: 'let me think' } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'bash', state: { input: { command: 'git status' } } } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { type: 'text', text: 'the answer' } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);

    const result = await p;
    expect(result.output).toContain('<thinking time="');
    expect(result.output).toContain('let me think');
    expect(result.output).toContain('[bash] git status');
    expect(result.output).toMatch(/<\/thinking>\n\nthe answer/);
    expect(thoughtEvents).toContain('[bash] git status\n');
  });

  it('runOpenCode does not emit a thinking block when there is no reasoning', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-nothink',
      model: 'OpenCode: DeepSeek V4 Flash Free',
    });

    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { type: 'text', text: 'plain answer' } }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);

    const result = await p;
    expect(result.output).toBe('plain answer');
  });

  it('runOpenCode consumes a final text JSON line without a trailing newline', async () => {
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const p = runOpenCode({
      prompt: 'hello',
      cwd: '/tmp',
      conversationId: 'conv-final-line',
      model: 'OpenCode: DeepSeek V4 Flash Free',
    });

    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { type: 'text', text: 'final answer' } }));
    child.emit('close', 0);

    const result = await p;
    expect(result.output).toBe('final answer');
  });

  it('runOpenCode streams growing reasoning and text parts from the database', async () => {
    const db = new Database(path.join(tmpDir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_live', 'gemini-cli-telegram:conv-live', Date.now());
    db.close();

    process.env['OPENCODE_PART_POLL_MS'] = '2';
    const { runOpenCode } = await import('./opencode.js');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const thoughts: string[] = [];
    const chunks: string[] = [];
    const p = runOpenCode({
      prompt: 'hello', cwd: '/tmp', conversationId: 'conv-live', model: 'OpenCode: DeepSeek V4 Flash Free',
      onChunk: chunk => chunks.push(chunk),
      onEvent: event => { if (event.type === 'thought') thoughts.push(event.content || ''); },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const writeDb = new Database(path.join(tmpDir, 'opencode.db'));
    const now = Date.now();
    writeDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_live', 'ses_live', now, now, JSON.stringify({ role: 'assistant' }));
    writeDb.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('part_reason', 'msg_live', 'ses_live', now, now, JSON.stringify({ type: 'reasoning', text: 'think' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    writeDb.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify({ type: 'reasoning', text: 'thinking' }), Date.now(), 'part_reason');
    writeDb.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('part_text', 'msg_live', 'ses_live', now + 1, now + 1, JSON.stringify({ type: 'text', text: 'ans' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    writeDb.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify({ type: 'text', text: 'answer' }), Date.now(), 'part_text');
    writeDb.close();
    await new Promise(resolve => setTimeout(resolve, 10));

    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\n');
    child.emit('close', 0);
    const result = await p;
    expect(thoughts).toEqual(['think', 'ing']);
    expect(chunks).toEqual(['ans', 'wer']);
    expect(result.output).toContain('thinking');
    expect(result.output).toContain('answer');
  });
});
