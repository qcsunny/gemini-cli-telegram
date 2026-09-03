/**
 * @file agyModels.test.ts
 * @description Tests for the `agy models` CLI invocation: output parsing,
 * env/proxy injection, non-zero exit and timeout handling.
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
// getAgyPath caches; reset per test via AGY_PATH env
vi.mock('./agyCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agyCli.js')>();
  return {
    ...actual,
    getAgyPath: () => process.env['AGY_PATH'] || '/mock/agy',
    buildAgyEnv: (proxy?: string) => {
      const env: Record<string, string | undefined> = { ...actual.buildAgyEnv(proxy) };
      return env;
    },
  };
});

import { listAgyModels, parseAgyModelsOutput } from './agyModels.js';

function makeFakeChild(pid = 12345) {
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

const SAMPLE_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
].join('\n');

describe('parseAgyModelsOutput', () => {
  it('skips the banner and parses tab-separated entries', () => {
    const entries = parseAgyModelsOutput(SAMPLE_OUTPUT);
    expect(entries).toEqual([
      { id: 'gemini-3.8-flash-high', display: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', display: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.1-pro-low', display: 'Gemini 3.1 Pro (Low)' },
      { id: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    const entries = parseAgyModelsOutput('\n\nno-tab-here\n \tid-only\nok\tfine\n');
    expect(entries).toEqual([{ id: 'ok', display: 'fine' }]);
  });
});

describe('listAgyModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['AGY_PATH'] = '/mock/agy';
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    loadUserConfigSpy.mockReturnValue({ proxy: 'http://127.0.0.1:7890' });
  });

  afterEach(() => {
    delete process.env['AGY_PATH'];
    vi.useRealTimers();
  });

  it('spawns `agy models` with proxy-injected env and resolves entries', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listAgyModels();
    emitAndClose(child, SAMPLE_OUTPUT);

    const entries = await promise;
    expect(entries).toHaveLength(4);
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/agy',
      ['models'],
      expect.objectContaining({
        env: expect.objectContaining({
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
        }),
      }),
    );
  });

  it('strips Antigravity session vars from the child env', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    process.env['ANTIGRAVITY_AGENT'] = 'leaked';

    const promise = listAgyModels();
    emitAndClose(child, SAMPLE_OUTPUT);
    await promise;

    const env = spawnMock.mock.calls[0][2].env as Record<string, string | undefined>;
    expect(env['ANTIGRAVITY_AGENT']).toBeUndefined();
    expect(env['ANTIGRAVITY_CONVERSATION_ID']).toBeUndefined();
    delete process.env['ANTIGRAVITY_AGENT'];
  });

  it('rejects with stderr tail on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listAgyModels();
    child.stderr.emit('data', Buffer.from('line1\nboom\nfatal: network down', 'utf8'));
    child.emit('close', 1);

    await expect(promise).rejects.toThrow('exited with code 1');
    await expect(promise).rejects.toThrow('fatal: network down');
  });

  it('rejects when output has no parseable entries', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listAgyModels();
    emitAndClose(child, 'Fetching available models...\n(nothing)');

    await expect(promise).rejects.toThrow('no parseable model entries');
  });

  it('rejects on spawn error', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listAgyModels();
    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('failed to spawn agy');
  });

  it('kills the child and rejects on timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = listAgyModels();
    const expectation = expect(promise).rejects.toThrow('timed out');
    vi.advanceTimersByTime(30_000);

    await expectation;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
