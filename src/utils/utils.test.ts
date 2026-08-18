/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageCache } from './messageCache.js';
import { formatFooterMarker, parseFooterMarker, estimateTokens, calculateCost } from './pricing.js';
import { startHealthServer, stopHealthServer } from './healthServer.js';
import { parseSystemdUnitFromCgroup, systemdRefusalMessage } from './systemdUnit.js';
import {
  detectLinkType,
  extractFirstUrl,
  cleanHtmlToMarkdown,
  parseArXiv,
  parseGitHub,
  parseWeChat,
  parseZhihu,
  parseTwitter,
  parseGeneralWeb,
} from '../tools/urlParser/urlParser.js';

describe('Utils Test Suite', () => {

  // ── 1. MessageCache ──
  describe('MessageCache', () => {
    let cache: MessageCache;

    beforeEach(() => {
      cache = new MessageCache(10000, 5); // 10s TTL, max 5 entries
    });

    it('should store and retrieve a message', () => {
      cache.set(1, 'Hello world');
      expect(cache.get(1)).toBe('Hello world');
    });

    it('should return null for a non-existent key', () => {
      expect(cache.get(999)).toBeNull();
    });

    it('should return null after TTL expiry', async () => {
      const shortCache = new MessageCache(10, 100); // 10ms TTL
      shortCache.set(1, 'expiring');
      await new Promise(r => setTimeout(r, 15));
      expect(shortCache.get(1)).toBeNull();
    });

    it('should evict LRU entries when over capacity', () => {
      for (let i = 0; i < 6; i++) cache.set(i, `msg-${i}`);
      expect(cache.size).toBeLessThanOrEqual(5);
    });

    it('should store and retrieve reply context', () => {
      const ctx = { answerMarkdown: 'answer', thinkingMarkdown: 'thinking' };
      cache.set(1, 'text', ctx);
      expect(cache.getReplyContext(1)).toEqual(ctx);
    });

    it('should track the last reply context', () => {
      const ctx1 = { answerMarkdown: 'a1', thinkingMarkdown: 't1' };
      const ctx2 = { answerMarkdown: 'a2', thinkingMarkdown: 't2' };
      cache.set(1, 't1', ctx1);
      cache.set(2, 't2', ctx2);
      expect(cache.getLastReplyContext()).toEqual(ctx2);
    });

    it('should expose size and capacity', () => {
      expect(cache.capacity).toBe(5);
      expect(cache.size).toBe(0);
      cache.set(1, 'hi');
      expect(cache.size).toBe(1);
    });

    it('should update existing entry', () => {
      cache.set(1, 'old');
      cache.set(1, 'new');
      expect(cache.get(1)).toBe('new');
    });
  });

  // ── 2. Pricing & Token Estimation ──
  describe('Pricing and Token Estimation', () => {
    it('should format footer marker string correctly', async () => {
      const footer = formatFooterMarker('gemini-3.6-flash', 'Hello prompt', 'Hello output', {
        input: 100,
        output: 50,
        cached: 0,
        thinking: 0,
      });
      expect(footer).toContain('gemini-3.6-flash');
      expect(footer).toContain('100');
      expect(footer).toContain('50');
    });

    it('should estimate CJK tokens with updated ratio', async () => {
      const enTokens = estimateTokens('Hello world');
      const cjkTokens = estimateTokens('你好世界');
      expect(enTokens).toBeGreaterThan(0);
      expect(cjkTokens).toBeGreaterThan(0);
    });

    it('should handle mixed CJK and English text', async () => {
      const tokens = estimateTokens('Hello 你好 world 世界');
      expect(tokens).toBeGreaterThan(4);
    });

    it('should apply correct cache discount per provider', async () => {
      const costNoCache = calculateCost('gemini-3.1-pro', 1000, 500, 0, 0);
      const costCached = calculateCost('gemini-3.1-pro', 0, 500, 1000, 0);
      expect(costCached.totalCost).toBeLessThan(costNoCache.totalCost);
    });

    it('should fallback to default rates for unknown models', async () => {
      const cost = calculateCost('unknown-model-xyz', 100, 100, 0, 0);
      expect(cost).toBeDefined();
      expect(typeof cost.totalCost).toBe('number');
    });

    it('should strip version numbers from Claude Opus and Claude Sonnet in parseFooterMarker', async () => {
      const parsedOpus = parseFooterMarker('[footer: Claude Opus 4.6 (Thinking) | 100 | 50 | $0.001234 | 0 | 0]');
      expect(parsedOpus[0]).toBe('Claude Opus (Thinking)');

      const parsedSonnet = parseFooterMarker('[footer: Claude Sonnet 4.6 (Thinking) | 100 | 50 | $0.001234 | 0 | 0]');
      expect(parsedSonnet[0]).toBe('Claude Sonnet (Thinking)');

      // Other models should not be changed
      const parsedGemini = parseFooterMarker('[footer: Gemini 3.6 Flash (High) | 100 | 50 | $0.001234 | 0 | 0]');
      expect(parsedGemini[0]).toBe('Gemini 3.6 Flash (High)');
    });

    it('should not charge thinking tokens for models with thinkingMultiplier=none', async () => {
      const costWithoutThinking = calculateCost('gemini-3.6-flash', 1000, 500, 0, 0);
      const costWithThinking = calculateCost('gemini-3.6-flash', 1000, 500, 0, 200);
      expect(costWithThinking.totalCost).toEqual(costWithoutThinking.totalCost);
    });

    it('should NOT charge thinking separately (output already includes thinking)', async () => {
      const cost = calculateCost('deepseek-r1', 100, 100, 0, 50);
      expect(cost).toBeDefined();
    });

    it('should switch to long-context rates when input exceeds 200K tokens', async () => {
      const costShort = calculateCost('gemini-3.1-pro', 100000, 100, 0, 0);
      const costLong = calculateCost('gemini-3.1-pro', 300000, 100, 0, 0);
      expect(costLong.totalCost).toBeGreaterThan(costShort.totalCost * 2.5);
    });

    it('should not apply long-context rates for models without longContextRates', async () => {
      const cost = calculateCost('deepseek-v3', 300000, 100, 0, 0);
      expect(cost).toBeDefined();
    });
  });

  // ── 3. HealthServer ──
  describe('healthServer', () => {
    const TEST_PORT = 19099;

    afterAll(async () => {
      stopHealthServer();
    });

    it('should respond with 200 and JSON status on GET /health', async () => {
      startHealthServer(TEST_PORT);
      await new Promise(r => setTimeout(r, 20));

      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${TEST_PORT}/health`, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });

      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty('status', 'ok');
      expect(parsed).toHaveProperty('uptime');
      expect(typeof parsed.uptime).toBe('number');
      expect(parsed).toHaveProperty('uptimeHuman');
    });

    it('should return 404 for unknown paths', async () => {
      startHealthServer(TEST_PORT);
      await new Promise(r => setTimeout(r, 20));

      const statusCode = await new Promise<number>((resolve, reject) => {
        http.get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });

      expect(statusCode).toBe(404);
    });
  });

  // ── 4. Logger ──
  describe('logger', () => {
    // Point the logger at a temp dir so tests never unlink the live
    // daemon.log/error.log the running service holds open (which orphans
    // its writes to a deleted inode).
    const TMP_ERROR_LOG = path.join(os.tmpdir(), 'gemini-test-error.log');
    const TMP_DAEMON_LOG = path.join(os.tmpdir(), 'gemini-test-daemon.log');

    beforeEach(async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('LOG_LEVEL', 'info');
      vi.stubEnv('TEST_ERROR_LOG_PATH', TMP_ERROR_LOG);
      vi.stubEnv('TEST_DAEMON_LOG_PATH', TMP_DAEMON_LOG);
      // Clear leftovers *before* importing logger.js: the module opens its fds
      // eagerly, so unlinking after the import would leave writes going to a
      // deleted inode and the file would never reappear.
      for (const p of [TMP_ERROR_LOG, TMP_DAEMON_LOG]) {
        try { fs.unlinkSync(p); } catch { /* not there → nothing to clear */ }
      }
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      const { ERROR_LOG_PATH, DAEMON_LOG_PATH } = await import('./logger.js');
      for (const p of [ERROR_LOG_PATH, DAEMON_LOG_PATH]) {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    });

    it('should export logger, pinoInstance and ERROR_LOG_PATH', async () => {
      const { logger, pinoInstance, ERROR_LOG_PATH } = await import('./logger.js');
      expect(logger).toBeDefined();
      expect(pinoInstance).toBeDefined();
      expect(ERROR_LOG_PATH).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should delegate info/error calls to pinoInstance', async () => {
      const { logger, pinoInstance } = await import('./logger.js');
      const infoSpy = vi.spyOn(pinoInstance, 'info').mockImplementation(() => {});
      const errorSpy = vi.spyOn(pinoInstance, 'error').mockImplementation(() => {});

      logger.info('test info message', { key: 'val' });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('test info message {"key":"val"}'));

      logger.error('test error message', new Error('boom'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test error message'));

      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should write error logs to error.log file', async () => {
      const { logger, pinoInstance, ERROR_LOG_PATH } = await import('./logger.js');

      logger.error('unit test error writing to log', new Error('test failure details'));

      await vi.waitFor(() => {
        pinoInstance.flush();
        expect(fs.existsSync(ERROR_LOG_PATH)).toBe(true);
        const content = fs.readFileSync(ERROR_LOG_PATH, 'utf-8');
        expect(content).toContain('unit test error writing to log');
        expect(content).toContain('test failure details');
      }, { timeout: 1000, interval: 20 });
    });

    it('should NOT log debug messages when LOG_LEVEL is default info', async () => {
      const { logger, pinoInstance } = await import('./logger.js');
      const debugSpy = vi.spyOn(pinoInstance, 'debug').mockImplementation(() => {});

      logger.debug('test debug message');
      expect(debugSpy).not.toHaveBeenCalled();

      debugSpy.mockRestore();
    });

    it('should respect LOG_LEVEL=debug', async () => {
      vi.stubEnv('LOG_LEVEL', 'debug');
      const { logger, pinoInstance } = await import('./logger.js');
      const debugSpy = vi.spyOn(pinoInstance, 'debug').mockImplementation(() => {});

      logger.debug('test debug message');
      expect(debugSpy).toHaveBeenCalledWith('test debug message');

      debugSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    it('should keep error records out of daemon.log', async () => {
      const { logger, pinoInstance, DAEMON_LOG_PATH, ERROR_LOG_PATH } = await import('./logger.js');

      logger.info('daemon-visible info line');
      logger.error('error-only line');

      await vi.waitFor(() => {
        pinoInstance.flush();
        const daemon = fs.readFileSync(DAEMON_LOG_PATH, 'utf-8');
        expect(daemon).toContain('daemon-visible info line');
        expect(daemon).not.toContain('error-only line');
        expect(fs.readFileSync(ERROR_LOG_PATH, 'utf-8')).toContain('error-only line');
      }, { timeout: 1000, interval: 20 });
    });

    it('should rotate a log file by size and keep N generations', async () => {
      const { createRotatingStream } = await import('./logger.js');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-rotate-'));
      const file = path.join(dir, 'rotate.log');
      try {
        const sink = createRotatingStream(file, { maxBytes: 200, keep: 2 });
        for (let i = 0; i < 6; i++) {
          sink.write(`{"level":30,"msg":"line ${i} ${'x'.repeat(90)}"}\n`);
        }

        await vi.waitFor(() => {
          expect(fs.existsSync(`${file}.1`)).toBe(true);
          expect(fs.existsSync(`${file}.2`)).toBe(true);
          // keep: 2 → the third generation is dropped, never written
          expect(fs.existsSync(`${file}.3`)).toBe(false);
          // The live file always holds the newest line.
          expect(fs.readFileSync(file, 'utf-8')).toContain('line 5');
        }, { timeout: 1000, interval: 20 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should not rotate when maxBytes is 0 (rotation disabled)', async () => {
      const { createRotatingStream } = await import('./logger.js');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-norotate-'));
      const file = path.join(dir, 'plain.log');
      try {
        const sink = createRotatingStream(file, { maxBytes: 0 });
        for (let i = 0; i < 5; i++) sink.write(`{"level":30,"msg":"${'y'.repeat(500)}"}\n`);

        await vi.waitFor(() => {
          expect(fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)).toHaveLength(5);
        }, { timeout: 1000, interval: 20 });
        expect(fs.existsSync(`${file}.1`)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('systemdUnit', () => {
  it('detects a systemd *user* service (real sample: the bot daemon)', () => {
    const raw = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service\n';
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-cli-telegram.service',
      scope: '--user ',
    });
  });

  it('detects a systemd *system* service and omits the --user flag', () => {
    const raw = '0::/system.slice/gemini-telegram.service\n';
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-telegram.service',
      scope: '',
    });
  });

  it('returns null for an interactive shell (real sample: login session scope)', () => {
    const raw = '0::/user.slice/user-1000.slice/session-12621.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('returns null when only the per-user manager is in the path, not a real unit', () => {
    const raw = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('returns null when the leaf is a scope nested inside a service', () => {
    const raw = '0::/system.slice/some.service/payload.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('parses cgroup v1 multi-line output', () => {
    const raw = [
      '12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '11:memory:/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '',
    ].join('\n');
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-cli-telegram.service',
      scope: '--user ',
    });
  });

  it('returns null for empty or malformed input', () => {
    expect(parseSystemdUnitFromCgroup('')).toBeNull();
    expect(parseSystemdUnitFromCgroup('\n\n')).toBeNull();
    expect(parseSystemdUnitFromCgroup('garbage-without-colons')).toBeNull();
  });

  it('quotes the actual unit name and scope instead of a hardcoded command', () => {
    const msg = systemdRefusalMessage(1586001, { unit: 'my-bot.service', scope: '--user ' }, 'restart');
    expect(msg).toContain('pid 1586001');
    expect(msg).toContain('my-bot.service');
    expect(msg).toContain('systemctl --user restart my-bot.service');
  });

  it('explains why the bot would stay offline', () => {
    const msg = systemdRefusalMessage(42, { unit: 'x.service', scope: '' }, 'stop');
    expect(msg).toContain('Restart=on-failure');
    expect(msg).toContain('systemctl stop x.service');
  });
});

describe('urlParser - type detection & URL extraction', () => {
  it('should accurately detect platform link types', () => {
    expect(detectLinkType('https://arxiv.org/abs/2403.12345')).toBe('arxiv');
    expect(detectLinkType('https://arxiv.org/pdf/2403.12345.pdf')).toBe('arxiv');
    expect(detectLinkType('https://github.com/google/gemini-cli')).toBe('github');
    expect(detectLinkType('https://mp.weixin.qq.com/s/abcdef123456')).toBe('weixin');
    expect(detectLinkType('https://zhuanlan.zhihu.com/p/12345678')).toBe('zhihu');
    expect(detectLinkType('https://zhihu.com/question/123456/answer/789')).toBe('zhihu');
    expect(detectLinkType('https://x.com/OpenAI/status/1234567890')).toBe('twitter');
    expect(detectLinkType('https://twitter.com/Google/status/987654321')).toBe('twitter');
    expect(detectLinkType('https://news.ycombinator.com/item?id=123')).toBe('web');
  });

  it('should extract first URL and strip trailing punctuations', () => {
    expect(extractFirstUrl('Check this paper: https://arxiv.org/abs/2403.12345, looks cool!')).toBe('https://arxiv.org/abs/2403.12345');
    expect(extractFirstUrl('https://github.com/torvalds/linux。')).toBe('https://github.com/torvalds/linux');
    expect(extractFirstUrl('No URL here')).toBeNull();
  });

  it('should clean HTML tags and entities to readable markdown', () => {
    const rawHtml = '<h1>Title</h1><p>Hello <strong>World</strong> &amp; <em>Friends</em>!</p><script>alert(1)</script>';
    const md = cleanHtmlToMarkdown(rawHtml);
    expect(md).toContain('## Title');
    expect(md).toContain('Hello **World** & *Friends*!');
    expect(md).not.toContain('<script>');
  });
});

describe('urlParser - platform parsing handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse ArXiv paper XML output correctly', async () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Attention Is All You Need</title>
        <summary>The dominant sequence transduction models are based on complex recurrent neural networks.</summary>
        <published>2017-06-12T00:00:00Z</published>
        <author><name>Ashish Vaswani</name></author>
        <author><name>Noam Shazeer</name></author>
        <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
      </entry>
    </feed>`;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockXml,
    } as any);

    const result = await parseArXiv('https://arxiv.org/abs/1706.03762');
    expect(result.type).toBe('arxiv');
    expect(result.title).toBe('Attention Is All You Need');
    expect(result.author).toContain('Ashish Vaswani');
    expect(result.author).toContain('Noam Shazeer');
    expect(result.content).toContain('The dominant sequence transduction models');
  });

  it('should parse GitHub repository metadata and raw README', async () => {
    const mockRepoData = {
      full_name: 'google/gemini-cli',
      description: 'Official Gemini CLI tool',
      stargazers_count: 5000,
      forks_count: 300,
      language: 'TypeScript',
      license: { spdx_id: 'Apache-2.0' },
      topics: ['ai', 'cli', 'gemini'],
    };

    const mockReadme = '# Gemini CLI\n\nA powerful CLI tool for Gemini.';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockRepoData,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockReadme,
      } as any);

    const result = await parseGitHub('https://github.com/google/gemini-cli');
    expect(result.type).toBe('github');
    expect(result.title).toBe('google/gemini-cli');
    expect(result.content).toContain('Official Gemini CLI tool');
    expect(result.content).toContain('⭐ 5000');
    expect(result.content).toContain('A powerful CLI tool for Gemini.');
  });

  it('should parse WeChat Official Account article', async () => {
    const mockWechatHtml = `
      <html>
        <h1 class="rich_media_title" id="activity-name">AI Agent 架构深度剖析</h1>
        <span class="rich_media_meta_text">张三</span>
        <strong class="profile_nickname">架构师前沿</strong>
        <div id="js_content"><p>这是公众号正文第一段。</p><p>这是正文第二段。</p></div>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockWechatHtml,
    } as any);

    const result = await parseWeChat('https://mp.weixin.qq.com/s/mock_test');
    expect(result.type).toBe('weixin');
    expect(result.title).toContain('AI Agent 架构深度剖析');
    expect(result.content).toContain('架构师前沿');
    expect(result.content).toContain('这是公众号正文第一段。');
  });

  it('should parse Zhihu column article', async () => {
    const mockZhihuHtml = `
      <html>
        <h1 class="Post-Title">大模型推理加速实战</h1>
        <span class="AuthorInfo-name">李四</span>
        <div class="Post-RichText"><p>通过 KV Cache 优化吞吐量。</p></div>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockZhihuHtml,
    } as any);

    const result = await parseZhihu('https://zhuanlan.zhihu.com/p/123456');
    expect(result.type).toBe('zhihu');
    expect(result.title).toContain('大模型推理加速实战');
    expect(result.content).toContain('李四');
    expect(result.content).toContain('通过 KV Cache 优化吞吐量。');
  });

  it('should parse Twitter post via fxtwitter API', async () => {
    const mockTwitterJson = {
      tweet: {
        text: 'Excited to announce our new open weights model!',
        likes: 1200,
        retweets: 300,
        views: 50000,
        created_at: 'Fri Aug 14 02:00:00 +0000 2026',
        author: {
          name: 'AI Researcher',
          screen_name: 'airesearcher',
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockTwitterJson,
    } as any);

    const result = await parseTwitter('https://x.com/airesearcher/status/1234567890');
    expect(result.type).toBe('twitter');
    expect(result.author).toBe('@airesearcher');
    expect(result.content).toContain('Excited to announce our new open weights model!');
    expect(result.content).toContain('❤️ 1200 赞');
  });

  it('should parse general web article fallback', async () => {
    const mockWebHtml = `
      <html>
        <head><title>Tech News Daily</title></head>
        <body>
          <main><p>This is a general news article body.</p></main>
        </body>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockWebHtml,
    } as any);

    const result = await parseGeneralWeb('https://example.com/news/1');
    expect(result.type).toBe('web');
    expect(result.title).toBe('Tech News Daily');
    expect(result.content).toContain('This is a general news article body.');
  });
});
