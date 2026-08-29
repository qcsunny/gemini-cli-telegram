// @vitest-environment node
/**
 * @file glm.test.ts
 * @description Tests for the GLM (chatglm.cn / HelloGML) backend against a
 * loopback HTTP server — what actually goes on the wire and what comes back:
 *  1. Display name → upstream model id via models.json `routing`.
 *  2. `Authorization: Bearer <glmKey>` from `backends.glmKey`.
 *  3. `reasoning_content` frames become a `<thinking time="…">` block that
 *     precedes the answer, which is how the Telegram renderer splits the
 *     thinking pill from the reply body.
 *  4. An empty upstream reply (HTTP 200, no content — chatglm's way of saying
 *     "rate limited") fails the run instead of sending a blank message.
 *  5. No `X-Conversation-Id`: HelloGML threads turns by fingerprinting the
 *     replayed history, so the full history is what it needs.
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
  'GLM: 5.3 Ultra Thinking': 'glm-5.3-deep-thinking',
  'GLM: Flash': 'glm-5.3-flash',
};
vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: () => ({ routing }),
}));

import { runGlm } from './glm.js';
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
  loadUserConfigMock.mockReturnValue({ backends: { glmKey: 'sk-test-glm' } });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function opts(overrides: Partial<AgyRunOptions> = {}): AgyRunOptions {
  return { prompt: '2+2=?', cwd: '/tmp', ...overrides } as AgyRunOptions;
}

describe('runGlm', () => {
  it('maps the display name onto the upstream model id', async () => {
    const res = await runGlm(opts({ model: 'GLM: 5.3 Ultra Thinking', conversationId: 'glm-a' }));
    expect(res.exitCode).toBe(0);
    expect(captured[0]!.body.model).toBe('glm-5.3-deep-thinking');
    expect(captured[0]!.body.stream).toBe(true);
  });

  it('falls back to glm-5.3-flash for an unrouted display name', async () => {
    await runGlm(opts({ model: 'GLM: Nonexistent', conversationId: 'glm-b' }));
    expect(captured[0]!.body.model).toBe('glm-5.3-flash');
  });

  it('sends the configured API key and no conversation-id header', async () => {
    await runGlm(opts({ model: 'GLM: Flash', conversationId: 'glm-c' }));
    expect(captured[0]!.headers['authorization']).toBe('Bearer sk-test-glm');
    expect(captured[0]!.headers['x-conversation-id']).toBeUndefined();
  });

  it('wraps reasoning_content in a timed thinking block ahead of the answer', async () => {
    frames = [
      { choices: [{ delta: { reasoning_content: '先算 2+2' } }] },
      { choices: [{ delta: { reasoning_content: '，得 4' } }] },
      { choices: [{ delta: { content: '答案是 4。' } }] },
    ];
    const res = await runGlm(opts({ model: 'GLM: Flash', conversationId: 'glm-d' }));
    expect(res.exitCode).toBe(0);
    expect(res.output).toMatch(/^<thinking time="\d+\.\d">先算 2\+2，得 4<\/thinking>\n\n答案是 4。$/);
  });

  it('returns the bare answer when the model did not reason', async () => {
    const res = await runGlm(opts({ model: 'GLM: Flash', conversationId: 'glm-e' }));
    expect(res.output).toBe('答案是 4。');
    expect(res.output).not.toContain('<thinking');
  });

  it('fails the run when upstream replies 200 with no content', async () => {
    frames = [];
    const res = await runGlm(opts({ model: 'GLM: Flash', conversationId: 'glm-f' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('GLM 上游返回空内容');
  });
});

describe('models.json GLM entries', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../config/models.json', import.meta.url), 'utf-8'));

  it('routes six ids — the plain no-thinking depths were retired', () => {
    const glm = Object.entries(cfg.routing as Record<string, string>)
      .filter(([name]) => name.startsWith('GLM:'));
    expect(glm.length).toBe(6);
    expect(new Set(glm.map(([, id]) => id)).size).toBe(6);
    for (const [name] of glm) expect(name).not.toBe('GLM: 5.3');
    for (const [name] of glm) expect(name).not.toBe('GLM: Flash');
    for (const [, id] of glm) expect(id).toMatch(/^glm-5\.3(-flash)?(-(deep-)?(thinking|research))?$/);
  });

  it('lists every routed GLM model in the remote tier and describes it', () => {
    const names = Object.keys(cfg.routing as Record<string, string>).filter((n) => n.startsWith('GLM:'));
    const remote = (cfg.tiers as { priority: number; models: string[] }[]).find((t) => t.priority === 4);
    for (const name of names) {
      expect(remote?.models).toContain(name);
      expect(cfg.descriptions[name]).toBeTruthy();
    }
  });

  it('keeps "deep" out of the display names so @deep stays a DeepSeek shortcut', () => {
    const names = Object.keys(cfg.routing as Record<string, string>).filter((n) => n.startsWith('GLM:'));
    for (const name of names) expect(name.toLowerCase()).not.toContain('deep');
  });
});
