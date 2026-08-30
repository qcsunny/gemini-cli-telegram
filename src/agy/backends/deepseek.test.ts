// @vitest-environment node
/**
 * @file deepseek.test.ts
 * @description Tests for the DeepSeek (deepseek-web2api-free) backend against
 * a loopback HTTP server — what goes on the wire and what comes back:
 *  1. Display name → upstream model id via models.json `routing`.
 *  2. Unrouted names fall back to `defaultModels.deepseekId` from user config.
 *  3. `Authorization: Bearer <deepseekApiKey>`.
 *  4. `X-Conversation-Id` threads every turn of one Telegram conversation into
 *     a single upstream session (deepseek-web2api keys its cache on it).
 *  5. `reasoning_content` frames become a `<thinking time="…">` block ahead of
 *     the answer, with the measured duration stamped onto the stored copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../messageStore.js', () => ({
  saveMessage: vi.fn(),
  saveMessageTurn: vi.fn(),
  restoreAllHistories: vi.fn(),
  getHistory: vi.fn((map: Map<string, unknown[]>, convId: string) => {
    let h = map.get(convId);
    if (!h) { h = []; map.set(convId, h); }
    return h;
  }),
}));

const loadUserConfigMock = vi.fn<() => Record<string, unknown> | null>();
vi.mock('../../config/userConfig.js', () => ({
  getTuningConfig: vi.fn(() => ({ maxHistoryMessages: 40 })),
  getBackendUrl: () => url,
  loadUserConfig: () => loadUserConfigMock(),
  getDefaultModels: () => loadUserConfigMock()?.defaultModels ?? null,
}));

const routing: Record<string, string> = {
  'DeepSeek: V4 Flash': 'deepseek-v4-flash',
};
vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: () => ({ routing }),
}));

import { runDeepSeek } from './deepseek.js';
import type { AgyRunOptions } from '../types.js';

interface Captured { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

let server: http.Server;
let captured: Captured[];
let url = '';
/** SSE frames the fake upstream replies with; each entry is one `data:` line. */
let frames: unknown[];

beforeEach(async () => {
  captured = [];
  frames = [{ choices: [{ delta: { content: 'x=4 或 x=3。' } }] }];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  loadUserConfigMock.mockReturnValue({
    deepseekApiKey: 'sk-test-deepseek',
    defaultModels: { deepseekId: 'deepseek-v4' },
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function opts(overrides: Partial<AgyRunOptions> = {}): AgyRunOptions {
  return { prompt: 'x^2-7x+12=0 求根', cwd: '/tmp', ...overrides } as AgyRunOptions;
}

describe('runDeepSeek', () => {
  it('maps the display name onto the upstream model id', async () => {
    const res = await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'ds-a' }));
    expect(res.exitCode).toBe(0);
    expect(captured[0]!.body.model).toBe('deepseek-v4-flash');
    expect(captured[0]!.body.stream).toBe(true);
  });

  it('falls back to defaultModels.deepseekId for an unrouted display name', async () => {
    await runDeepSeek(opts({ model: 'DeepSeek: Nonexistent', conversationId: 'ds-b' }));
    expect(captured[0]!.body.model).toBe('deepseek-v4');
  });

  it('sends the configured API key', async () => {
    await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'ds-c' }));
    expect(captured[0]!.headers['authorization']).toBe('Bearer sk-test-deepseek');
  });

  it('sends no Authorization header when no key is configured', async () => {
    loadUserConfigMock.mockReturnValue({ defaultModels: { deepseekId: 'deepseek-v4' } });
    await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'ds-d' }));
    expect(captured[0]!.headers['authorization']).toBeUndefined();
  });

  it('threads one conversation onto a single upstream session via X-Conversation-Id', async () => {
    await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'tg-77' }));
    await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'tg-77', prompt: '那取较大根' }));
    expect(captured[0]!.headers['x-conversation-id']).toBe('tg-77');
    expect(captured[1]!.headers['x-conversation-id']).toBe('tg-77');
  });

  it('wraps reasoning_content in a timed thinking block ahead of the answer', async () => {
    frames = [
      { choices: [{ delta: { reasoning_content: '十字相乘' } }] },
      { choices: [{ delta: { content: 'x=4 或 x=3。' } }] },
    ];
    const res = await runDeepSeek(opts({ model: 'DeepSeek: V4 Flash', conversationId: 'ds-e' }));
    expect(res.output).toMatch(/^<thinking time="\d+\.\d">十字相乘<\/thinking>\n\nx=4 或 x=3。$/);
  });

  it('streams chunks without the thinking wrapper while a turn is in flight', async () => {
    frames = [
      { choices: [{ delta: { reasoning_content: '思考中' } }] },
      { choices: [{ delta: { content: 'x=4 或 x=3。' } }] },
    ];
    const chunks: string[] = [];
    await runDeepSeek(opts({
      model: 'DeepSeek: V4 Flash', conversationId: 'ds-f',
      onChunk: (t: string) => chunks.push(t),
    }));
    // The thinking pill is streamed as part of the chunk flow (live tag with
    // time 0.0) ahead of the answer body, so the draft shows the model
    // thinking in real time; buildOutput later stamps the measured duration
    // onto the stored copy.
    expect(chunks.join('')).toBe('<thinking time="0.0">思考中</thinking>\n\nx=4 或 x=3。');
  });
});

describe('models.json DeepSeek entries', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../config/models.json', import.meta.url), 'utf-8'));
  const routing = cfg.routing as Record<string, string>;
  const names = Object.keys(routing).filter((n) => n.startsWith('DeepSeek:'));

  it('routes DeepSeek display names and lists them together in one tier', () => {
    expect(names.length).toBeGreaterThan(0);
    const tiers = cfg.tiers as { priority: number; models: string[] }[];
    const listed = tiers.some((t) => names.every((n) => t.models.includes(n)));
    expect(listed).toBe(true);
  });
});
