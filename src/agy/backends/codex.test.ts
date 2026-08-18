import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { runCodex, getCodexPath, codexThreadMap } from './codex.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: vi.fn().mockReturnValue({
    routing: {
      'Codex: GPT-5.6 Sol': 'gpt-5.6-sol',
    },
  }),
}));

vi.mock('../messageStore.js', () => ({
  saveMessage: vi.fn(),
}));

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
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.pid = 54321;
    mockChild.kill = vi.fn();

    (childProcess.spawn as any).mockReturnValue(mockChild);

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
    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['exec', 'What is 2+2?', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-sol']),
      expect.objectContaining({
        env: expect.objectContaining({
          AGENTROUTER_API_KEY: expect.any(String),
        }),
      }),
    );

    // Simulate streaming events
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

    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();

    (childProcess.spawn as any).mockReturnValue(mockChild);

    const runPromise = runCodex({
      prompt: 'Followup question',
      model: 'Codex: GPT-5.6 Sol',
      conversationId: 'codex-conv-2',
    });

    expect(childProcess.spawn).toHaveBeenCalledWith(
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
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();

    (childProcess.spawn as any).mockReturnValue(mockChild);

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
