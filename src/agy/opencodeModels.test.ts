/**
 * @file opencodeModels.test.ts
 * @description Tests for parsing `opencode models opencode --verbose` output
 * (id line + pretty JSON block pairs) and the listOpenCodeModels CLI wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

let spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const loadUserConfigSpy = vi.fn();

vi.mock('../config/userConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/userConfig.js')>();
  return {
    ...actual,
    loadUserConfig: (...args: unknown[]) => loadUserConfigSpy(...args),
  };
});
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listOpenCodeModels, parseOpenCodeModelsOutput } from './opencodeModels.js';

function makeFakeChild(pid = 23456) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function emitAndClose(child: ReturnType<typeof makeFakeChild>, stdout: string, code = 0) {
  child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
  child.emit('close', code);
}

const SAMPLE_VERBOSE = [
  'opencode/big-pickle',
  '{',
  '  "id": "big-pickle",',
  '  "name": "Big Pickle",',
  '  "status": "active",',
  '  "cost": { "input": 0, "output": 0 }',
  '}',
  'opencode/muse-spark-1.3-contributor-free',
  '{',
  '  "id": "muse-spark-1.3-contributor-free",',
  '  "name": "Muse Spark 1.3 Free",',
  '  "status": "active",',
  '  "cost": { "input": 0, "output": 0 }',
  '}',
  'opencode/claude-fable-5',
  '{',
  '  "id": "claude-fable-5",',
  '  "name": "Claude Fable 5",',
  '  "status": "active",',
  '  "cost": { "input": 10, "output": 50 }',
  '}',
].join('\n');

describe('parseOpenCodeModelsOutput', () => {
  it('pairs id lines with their JSON blocks and extracts name/status/cost', () => {
    const entries = parseOpenCodeModelsOutput(SAMPLE_VERBOSE);
    expect(entries).toEqual([
      { id: 'opencode/big-pickle', name: 'Big Pickle', active: true, free: true },
      { id: 'opencode/muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', active: true, free: true },
      { id: 'opencode/claude-fable-5', name: 'Claude Fable 5', active: true, free: false },
    ]);
  });

  it('handles multi-segment ids like openrouter/openrouter/free', () => {
    const stdout = [
      'openrouter/openrouter/free',
      '{',
      '  "name": "OpenRouter Free",',
      '  "status": "active"',
      '}',
    ].join('\n');
    const entries = parseOpenCodeModelsOutput(stdout);
    expect(entries).toEqual([{ id: 'openrouter/openrouter/free', name: 'OpenRouter Free', active: true, free: false }]);
  });

  it('skips malformed JSON blocks and blocks without an id line', () => {
    const stdout = [
      'opencode/broken',
      '{',
      '  "name": "Broken",',
      '  "status": "active",',
      '  [truncated garbage',
      'opencode/ok',
      '{',
      '  "name": "OK",',
      '  "status": "active"',
      '}',
      '{',
      '  "name": "Orphan",',
      '  "status": "active"',
      '}',
    ].join('\n');
    const entries = parseOpenCodeModelsOutput(stdout);
    expect(entries).toEqual([{ id: 'opencode/ok', name: 'OK', active: true, free: false }]);
  });

  it('marks non-active status as inactive', () => {
    const stdout = ['opencode/deprecated', '{', '  "name": "Deprecated",', '  "status": "deprecated"', '}'].join('\n');
    const entries = parseOpenCodeModelsOutput(stdout);
    expect(entries[0]?.active).toBe(false);
  });

  it('returns [] on empty output', () => {
    expect(parseOpenCodeModelsOutput('')).toEqual([]);
    expect(parseOpenCodeModelsOutput('no models found')).toEqual([]);
  });
});

describe('listOpenCodeModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['OPENCODE_PATH'] = '/mock/opencode';
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    loadUserConfigSpy.mockReturnValue({ proxy: 'http://127.0.0.1:7890' });
  });

  afterEach(() => {
    delete process.env['OPENCODE_PATH'];
    vi.useRealTimers();
  });

  it('spawns `opencode models opencode --verbose` with proxy env and resolves entries', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listOpenCodeModels();
    emitAndClose(child, SAMPLE_VERBOSE);

    const entries = await promise;
    expect(entries).toHaveLength(3);
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/opencode',
      ['models', 'opencode', '--verbose'],
      expect.objectContaining({
        env: expect.objectContaining({
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
        }),
      }),
    );
  });

  it('rejects with stderr tail on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listOpenCodeModels();
    child.stderr.emit('data', Buffer.from('fatal: provider not found', 'utf8'));
    child.emit('close', 1);

    await expect(promise).rejects.toThrow('exited with code 1');
    await expect(promise).rejects.toThrow('fatal: provider not found');
  });

  it('rejects (safety gate) when no opencode/ entries parse', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listOpenCodeModels();
    emitAndClose(child, '(empty)');

    await expect(promise).rejects.toThrow('0 个 opencode/');
  });

  it('rejects on spawn error (opencode not installed)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listOpenCodeModels();
    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('failed to spawn opencode');
  });

  it('kills the child and rejects on timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listOpenCodeModels();
    const expectation = expect(promise).rejects.toThrow('timed out');
    vi.advanceTimersByTime(90_000);

    await expectation;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
