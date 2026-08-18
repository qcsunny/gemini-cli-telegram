import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { runClaudeCli, getClaudePath } from './claude.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: vi.fn().mockReturnValue({
    routing: {
      'Claude CLI: Claude Opus 5': 'claude-opus-5',
    },
  }),
}));

vi.mock('../messageStore.js', () => ({
  saveMessage: vi.fn(),
}));

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
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.pid = 12345;
    mockChild.kill = vi.fn();

    (childProcess.spawn as any).mockReturnValue(mockChild);

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
    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'claude-opus-5', '--session-id', '4a62da02-d3cf-41c9-9ed3-fa5cf298e191', 'Hello Claude']),
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: expect.any(String),
          ANTHROPIC_AUTH_TOKEN: expect.any(String),
        }),
      }),
    );

    // Simulate streaming events
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
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();

    (childProcess.spawn as any).mockReturnValue(mockChild);

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
