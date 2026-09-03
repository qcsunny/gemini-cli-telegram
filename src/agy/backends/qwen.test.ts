// @vitest-environment node
/**
 * @file qwen.test.ts
 * @description Tests for the Qwen (chat.qwen.ai / Qwen2API) backend against a
 * loopback HTTP server — what goes on the wire and what comes back:
 *  1. Display name → upstream model id via models.json `routing`.
 *  2. `Authorization: Bearer <qwenKey>` from `backends.qwenKey`.
 *  3. `reasoning_content` frames become a `<thinking time="…">` block ahead of
 *     the answer, which is how the Telegram renderer splits the thinking pill
 *     from the reply body.
 *  4. The x5sec captcha wall (HTTP 200 whose body is a `punish?…` URL) fails the
 *     run instead of rendering the link as the model's answer.
 *  5. `-image` / `-video` ids download the generated asset into `mediaFiles` and
 *     strip its markdown wrapper out of the text.
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
  'Qwen: 3.8 Max': 'qwen3.8-max-thinking',
  'Qwen: Image 2.0': 'qwen-image-2.0-image',
  'Qwen: Image 3.0': 'qwen-image-3.0-image',
  'Qwen: Video': 'qwen3.8-max-video',
};
vi.mock('../../core/modelRegistry.js', () => ({
  loadModelsConfig: () => ({ routing }),
}));

import { runQwen } from './qwen.js';
import type { AgyRunOptions } from '../types.js';

interface Captured { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

let server: http.Server;
let captured: Captured[];
let url = '';
/** SSE frames the fake upstream replies with; each entry is one `data:` line. */
let frames: unknown[];
/** Bytes served on `/asset.png` — stands in for Qwen's generated-asset CDN. */
const asset = Buffer.alloc(2048, 7);

beforeEach(async () => {
  captured = [];
  frames = [{ choices: [{ delta: { content: '答案是 4。' } }] }];
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/asset')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(asset);
      return;
    }
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
  url = `${origin()}/v1`;
  loadUserConfigMock.mockReturnValue({ backends: { qwenKey: 'sk-test-qwen' } });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function opts(overrides: Partial<AgyRunOptions> = {}): AgyRunOptions {
  return { prompt: '2+2=?', cwd: '/tmp', ...overrides } as AgyRunOptions;
}

/** The loopback origin the fake asset CDN is reachable on. */
function origin(): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('runQwen', () => {
  it('maps the display name onto the upstream model id', async () => {
    const res = await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-a' }));
    expect(res.exitCode).toBe(0);
    expect(captured[0]!.body.model).toBe('qwen3.8-max-thinking');
    expect(captured[0]!.body.stream).toBe(true);
  });

  it('falls back to qwen3.8-max-thinking for an unrouted display name', async () => {
    await runQwen(opts({ model: 'Qwen: Nonexistent', conversationId: 'qwen-b' }));
    expect(captured[0]!.body.model).toBe('qwen3.8-max-thinking');
  });

  it('sends the configured API key', async () => {
    await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-c' }));
    expect(captured[0]!.headers['authorization']).toBe('Bearer sk-test-qwen');
  });

  it('pins thinking_mode to Auto so the turn never burns the manual-Thinking quota', async () => {
    await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-c2' }));
    // Auto is Qwen2API's middleware default and is exempt from the
    // 2-per-hour manual Thinking quota; pinning it guards against upstream
    // changing that default later.
    expect(captured[0]!.body.thinking_mode).toBe('Auto');
  });

  it('wraps reasoning_content in a timed thinking block ahead of the answer', async () => {
    frames = [
      { choices: [{ delta: { reasoning_content: '先算 2+2' } }] },
      { choices: [{ delta: { reasoning_content: '，得 4' } }] },
      { choices: [{ delta: { content: '答案是 4。' } }] },
    ];
    const res = await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-d' }));
    expect(res.output).toMatch(/^<thinking time="\d+\.\d">先算 2\+2，得 4<\/thinking>\n\n答案是 4。$/);
  });

  it('fails the run when upstream replies 200 with no content', async () => {
    frames = [];
    const res = await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-e' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Qwen 上游返回空内容');
  });

  it('turns the x5sec captcha wall into an error instead of an answer', async () => {
    frames = [{ choices: [{ delta: { content: '{"url":"https://chat.qwen.ai//api/v2/chat/completions/_____tmd_____/punish?x5secdata=abc&x5step=2"}' } }] }];
    const res = await runQwen(opts({ model: 'Qwen: Image 3.0', conversationId: 'qwen-f' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('x5sec');
    expect(res.output).toBe('');
  });

  it('downloads a generated image into mediaFiles and strips its markdown', async () => {
    frames = [{ choices: [{ delta: { content: `好的，这是图片：\n![image](${origin()}/asset.png)` } }] }];
    const res = await runQwen(opts({ model: 'Qwen: Image 3.0', conversationId: 'qwen-g' }));
    expect(res.exitCode).toBe(0);
    expect(res.mediaModel).toBe(true);
    expect(res.mediaFiles).toHaveLength(1);
    expect(res.mediaFiles![0]!.type).toBe('photo');
    expect(fs.statSync(res.mediaFiles![0]!.path).size).toBe(asset.length);
    expect(res.output).toBe('好的，这是图片：');
    expect(res.output).not.toContain('asset.png');
    fs.unlinkSync(res.mediaFiles![0]!.path);
  });

  it('downloads a generated video and drops the <video> wrapper', async () => {
    frames = [{ choices: [{ delta: { content: `\n<video controls="controls">\n${origin()}/asset.mp4\n</video>\n\n[Download Video](${origin()}/asset.mp4)\n` } }] }];
    const res = await runQwen(opts({ model: 'Qwen: Video', conversationId: 'qwen-h' }));
    expect(res.mediaFiles).toHaveLength(1);
    expect(res.mediaFiles![0]!.type).toBe('video');
    expect(res.output).toBe('');
    fs.unlinkSync(res.mediaFiles![0]!.path);
  });

  it('suppresses text chunks for media models so no raw URL reaches the draft', async () => {
    frames = [{ choices: [{ delta: { content: `![image](${origin()}/asset.png)` } }] }];
    const chunks: string[] = [];
    const res = await runQwen(opts({ model: 'Qwen: Image 3.0', conversationId: 'qwen-i', onChunk: (t: string) => chunks.push(t) }));
    expect(chunks).toHaveLength(0);
    fs.unlinkSync(res.mediaFiles![0]!.path);
  });

  it('streams text chunks normally for non-media models', async () => {
    const chunks: string[] = [];
    await runQwen(opts({ model: 'Qwen: 3.8 Max', conversationId: 'qwen-j', onChunk: (t: string) => chunks.push(t) }));
    expect(chunks.join('')).toBe('答案是 4。');
  });
});

describe('models.json Qwen entries', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../../config/models.json', import.meta.url), 'utf-8'));
  const names = Object.keys(cfg.routing as Record<string, string>).filter((n) => n.startsWith('Qwen:'));

  it('routes exactly the four requested ids', () => {
    // Qwen: Image merges the retired qwen-image-2.0-image / qwen-image-3.0-image
    // into one entry routed to the top live variant (qwen3.8-max-image).
    expect(new Set(Object.entries(cfg.routing as Record<string, string>)
      .filter(([n]) => n.startsWith('Qwen:')).map(([, id]) => id)))
      .toEqual(new Set(['qwen3.8-max-thinking', 'qwen3.8-max-image', 'qwen3.8-max-video']));
    expect((cfg.routing as Record<string, string>)['Qwen: Image']).toBe('qwen3.8-max-image');
  });

  it('lists every routed Qwen model in the remote tier and describes it', () => {
    const remote = (cfg.tiers as { priority: number; models: string[] }[]).find((t) => t.priority === 4);
    for (const name of names) {
      expect(remote?.models).toContain(name);
      expect(cfg.descriptions[name]).toBeTruthy();
    }
  });

  it('keeps the media ids at the end of the tier so text fallback hits them last', () => {
    const remote = (cfg.tiers as { priority: number; models: string[] }[]).find((t) => t.priority === 4)!;
    const routing = cfg.routing as Record<string, string>;
    const lastText = Math.max(...remote.models
      .map((m, i) => (m.startsWith('Qwen:') && !/-(image|video)$/.test(routing[m]!) ? i : -1)));
    const firstMedia = Math.min(...remote.models
      .map((m, i) => (m.startsWith('Qwen:') && /-(image|video)$/.test(routing[m]!) ? i : Infinity)));
    expect(firstMedia).toBeGreaterThan(lastText);
  });
});
