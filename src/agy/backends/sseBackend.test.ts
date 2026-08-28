// @vitest-environment node
/**
 * @file sseBackend.test.ts
 * @description Unit tests for the shared SSE backend (`runSseBackend`) against
 * a local loopback HTTP server — verifies what actually goes on the wire:
 *  1. `conversationIdHeader: true` sends `X-Conversation-Id: <convId>` so
 *     deepseek-web2api's session cache keys all turns of one Telegram
 *     conversation together.
 *  2. The default (web2api) spec sends no such header.
 *  3. Full history is replayed in `messages` (the stateful upstream diffs it
 *     server-side; it also serves as the cache-miss recovery path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../agy/messageStore.js', () => ({
  saveMessage: vi.fn(),
  saveMessageTurn: vi.fn(),
  getHistory: vi.fn((map: Map<string, any[]>, convId: string) => {
    let h = map.get(convId);
    if (!h) { h = []; map.set(convId, h); }
    return h;
  }),
}));

const getBackendUrlMock = vi.fn<(b: string) => string | undefined>();
vi.mock('../../config/userConfig.js', () => ({
  getTuningConfig: vi.fn(() => ({ maxHistoryMessages: 40 })),
  getBackendUrl: (b: string) => getBackendUrlMock(b),
}));

import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions } from '../types.js';

interface Captured {
  headers: http.IncomingHttpHeaders;
  body: any;
}

let server: http.Server;
let captured: Captured[];
let url = '';

beforeEach(async () => {
  captured = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
  getBackendUrlMock.mockReturnValue(url);
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: 'deepseek',
    label: 'DeepSeek',
    histories: new Map(),
    makeConvId: () => 'conv-1',
    resolveModelId: () => 'deepseek-v4-flash',
    authHeaders: () => ({}),
    timeoutMs: 5_000,
    openThinking: '<thinking time="0.0">',
    closeThinking: '</thinking>',
    buildOutput: ({ content }: { content: string }) => content,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<AgyRunOptions> = {}): AgyRunOptions {
  return {
    prompt: 'Solve: x^2-7x+12=0. Find the larger root.',
    cwd: '/tmp',
    ...overrides,
  } as AgyRunOptions;
}

describe('runSseBackend', () => {
  it('sends X-Conversation-Id when conversationIdHeader is set', async () => {
    const result = await runSseBackend(makeOpts({ conversationId: 'conv-42' }),
      makeSpec({ conversationIdHeader: true }) as any);
    expect(result.exitCode).toBe(0);
    expect(captured.length).toBe(1);
    expect(captured[0]!.headers['x-conversation-id']).toBe('conv-42');
  });

  it('omits X-Conversation-Id by default', async () => {
    await runSseBackend(makeOpts({ conversationId: 'conv-42' }), makeSpec() as any);
    expect(captured[0]!.headers['x-conversation-id']).toBeUndefined();
  });

  it('omits X-Conversation-Id when a spec without the flag is used', async () => {
    await runSseBackend(makeOpts({ conversationId: 'conv-42' }),
      makeSpec({ conversationIdHeader: false }) as any);
    expect(captured[0]!.headers['x-conversation-id']).toBeUndefined();
  });

  it('replays the full history (current prompt as the only message on turn one)', async () => {
    await runSseBackend(makeOpts(), makeSpec() as any);
    const msgs = captured[0]!.body.messages as { role: string; content: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Solve: x^2-7x+12=0. Find the larger root.' });
    expect(captured[0]!.body.stream).toBe(true);
  });

  it('replays the accumulated history on the next turn of the same conversation', async () => {
    const spec = makeSpec({ conversationIdHeader: true });
    await runSseBackend(makeOpts({ conversationId: 'conv-7' }), spec as any);
    await runSseBackend(makeOpts({ conversationId: 'conv-7', prompt: 'Now generalize it.' }), spec as any);
    expect(captured.length).toBe(2);
    const msgs = captured[1]!.body.messages as { role: string; content: string }[];
    expect(msgs).toEqual([
      { role: 'user', content: 'Solve: x^2-7x+12=0. Find the larger root.' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'Now generalize it.' },
    ]);
    // Same conversation → same header on every turn, so the stateful
    // upstream threads them into one server-side session.
    expect(captured[1]!.headers['x-conversation-id']).toBe('conv-7');
  });
});
