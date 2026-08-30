// @vitest-environment node
/**
 * @file mimo.test.ts
 * @description Tests for the MiMo (aistudio.xiaomimimo.com / mimo-2api) backend
 * against a loopback HTTP server — what goes on the wire and what comes back:
 *  1. Display name → upstream model id via models.json `routing`.
 *  2. Unrouted names fall back to `mimo-v2.5-pro`.
 *  3. `Authorization: Bearer <mimoKey>` from `backends.mimoKey`.
 *  4. No `X-Conversation-Id`: mimo-2api is stateless, history is replayed in
 *     full from the client (unlike deepseek's session cache).
 *  5. `reasoning_content` frames become a `<thinking time="…">` block ahead of
 *     the answer — the thinking chain only survives via streaming.
 *  6. models.json carries exactly one routed MiMo entry in the remote tier.
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
}));

const routing: Record<string, string> = {
  'MiMo: 2.5 Pro': 'mimo-v2.5-pro',
};
vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: () => ({ routing }),
}));

import { runMiMo } from './mimo.js';
import type { AgyRunOptions } from '../types.js';

interface Captured { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

let server: http.Server;
let captured: Captured[];
let url = '';
/** SSE frames the fake upstream replies with; each entry is one `data:` line. */
let frames: unknown[];

beforeEach(async () => {
  captured = [];
  frames = [{ choices: [{ delta: { content: '答案是 4。' } }] }];
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
  loadUserConfigMock.mockReturnValue({ backends: { mimoKey: 'sk-test-mimo' } });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function opts(overrides: Partial<AgyRunOptions> = {}): AgyRunOptions {
  return { prompt: '2+2=?', cwd: '/tmp', ...overrides } as AgyRunOptions;
}

describe('runMiMo', () => {
  it('maps the display name onto the upstream model id', async () => {
    const res = await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-a' }));
    expect(res.exitCode).toBe(0);
    expect(captured[0]!.body.model).toBe('mimo-v2.5-pro');
    expect(captured[0]!.body.stream).toBe(true);
  });

  it('falls back to mimo-v2.5-pro for an unrouted display name', async () => {
    await runMiMo(opts({ model: 'MiMo: Nonexistent', conversationId: 'mimo-b' }));
    expect(captured[0]!.body.model).toBe('mimo-v2.5-pro');
  });

  it('sends the configured API key', async () => {
    await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-c' }));
    expect(captured[0]!.headers['authorization']).toBe('Bearer sk-test-mimo');
  });

  it('sends no Authorization header when no key is configured', async () => {
    loadUserConfigMock.mockReturnValue(null);
    await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-d' }));
    expect(captured[0]!.headers['authorization']).toBeUndefined();
  });

  it('sends no X-Conversation-Id (mimo-2api is stateless)', async () => {
    await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-e' }));
    expect(captured[0]!.headers['x-conversation-id']).toBeUndefined();
  });

  it('wraps reasoning_content in a timed thinking block ahead of the answer', async () => {
    frames = [
      { choices: [{ delta: { reasoning_content: '先算 2+2' } }] },
      { choices: [{ delta: { reasoning_content: '，得 4' } }] },
      { choices: [{ delta: { content: '答案是 4。' } }] },
    ];
    const res = await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-f' }));
    expect(res.output).toMatch(/^<thinking time="\d+\.\d">先算 2\+2，得 4<\/thinking>\n\n答案是 4。$/);
  });

  it('replays the accumulated history across turns of one conversation', async () => {
    await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-g' }));
    await runMiMo(opts({ model: 'MiMo: 2.5 Pro', conversationId: 'mimo-g', prompt: '那乘 3 呢？' }));
    const msgs = captured[1]!.body.messages as { role: string; content: string }[];
    expect(msgs).toEqual([
      { role: 'user', content: '2+2=?' },
      { role: 'assistant', content: '答案是 4。' },
      { role: 'user', content: '那乘 3 呢？' },
    ]);
  });
});

describe('models.json MiMo entries', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../config/models.json', import.meta.url), 'utf-8'));
  const routing = cfg.routing as Record<string, string>;
  const names = Object.keys(routing).filter((n) => n.startsWith('MiMo:'));

  it('routes exactly one MiMo id', () => {
    expect(names).toEqual(['MiMo: 2.5 Pro']);
    expect(routing['MiMo: 2.5 Pro']).toBe('mimo-v2.5-pro');
  });

  it('lists the MiMo model in the remote tier with a description', () => {
    const remote = (cfg.tiers as { priority: number; models: string[] }[]).find((t) => t.priority === 4);
    expect(remote?.models).toContain('MiMo: 2.5 Pro');
    expect(cfg.descriptions['MiMo: 2.5 Pro']).toBeTruthy();
  });
});
