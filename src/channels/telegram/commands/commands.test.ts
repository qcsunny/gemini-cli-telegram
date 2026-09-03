/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file commands.test.ts
 * @description Consolidated tests for Telegram command handlers (helpers, callbackRouter, settings, link summarizer, watchlist, invest, private image, sum) plus chat-message persistence.
 */




import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Bot, Context } from 'grammy';
import type { Message } from '@grammyjs/types';
import { execFile } from 'node:child_process';

// Command handlers & helpers
import { htmlToMarkdown, extractTitleFromMarkdown } from './helpers.js';
import { escapeHtml, truncate, formatWelcome, formatHelp, formatSessionStats } from '../ui.js';
import { is429Error, get429RetryAfter, record429Backoff, reset429Backoff, draftBackoffUntil } from '../bot/rateLimiter.js';
import { registerCallbackRouter } from './callbackRouter.js';
import { registerSettingsHandler } from './settingsHandler.js';
import { generateLinkSummary, registerLinkSummarizerCommands } from './linkSummarizerHandler.js';
import { buildWatchlistKeyboard, renderWatchlistCard, registerWatchlistCommands } from './watchlistHandler.js';
import { fetchInvestAnalysis, fetchInvestAnalyses, buildInvestPrompt, getInvestProjectPath } from './investDataFetcher.js';
import { registerInvestHandler } from './investHandler.js';
import { isPrivateImageRequest, handlePrivateImageRequest } from './privateImageHandler.js';
import { persistChatMessage, loadRecentMessages, trimChatMessages } from './sumHandler.js';
import { formatBackendsStatus, registerConfigHandlers } from './configHandlers.js';
import { getAllBackendHealthStatus, markBackendFailed, clearBackendHealth } from '../../../core/backendHealth.js';
import { registerContentHandlers } from './contentHandlers.js';
import { registerSessionHandlers } from './sessionHandlers.js';
import { closeDb } from '../../../db/index.js';
import * as inlineHandler from './inlineHandler.js';
import * as dailyBriefing from '../../../stock/service/dailyBriefing.js';
import * as agyCli from '../../../agy/agyCli.js';
import * as messageStore from '../../../agy/messageStore.js';
import * as fundProvider from '../../../stock/provider/fund.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

// Mocks
vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, execFile: vi.fn() };
});

vi.mock('../../../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn().mockResolvedValue({ exitCode: 0, output: '深度投资分析报告内容' }),
  getAvailableModels: vi.fn().mockResolvedValue(['Gemini 3.7 Flash (High)']),
  getDefaultModel: vi.fn().mockReturnValue('Gemini 3.7 Flash (High)'),
  clearWeb2ApiHistory: vi.fn(),
  clearDeepSeekHistory: vi.fn(),
  clearOpenCodeHistory: vi.fn(),
}));

vi.mock('../../../config/userConfig.js', () => ({
  getBrowseRoot: () => '/tmp/browse',
  getAnswerSaveDir: () => '/tmp/inbox',
  loadUserConfig: () => ({
    projects: [{ name: '价值投资分析专家', path: '/fake/invest-project' }],
    proxy: 'http://127.0.0.1:7890',
  }),
  getStockMarketApiKey: () => 'FAKE_FMP_KEY',
  getDefaultModel: () => 'Gemini 3.7 Flash (High)',
  getAgyDataDir: () => '/tmp/agy-data',
  getSummarizationConfig: () => ({ defaultCount: 100, maxCount: 500 }),
  getTuningConfig: () => ({
    cacheTtlMs: 86400000,
    cacheMaxSize: 1000,
    debounceIntervalMs: 350,
    modelRunHardTimeoutMs: 900000,
    modelRunInactivityMs: 600000,
    retriesPerModel: 3,
    maxHistoryMessages: 40,
  }),
}));

vi.mock('../../../core/modelRegistry.js', () => ({
  loadModelsConfig: vi.fn().mockReturnValue({ tiers: [] }),
}));

vi.mock('../../../utils/messageCache.js', () => ({
  messageCache: {
    getLastReplyContext: vi.fn().mockReturnValue(null),
    getLastReplyContextForChat: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../../../core/messageLoop.js', () => ({ processMessage: vi.fn() }));

const runModelSyncMock = vi.fn();

vi.mock('../../../core/modelSync.js', () => ({
  runModelSync: (...args: unknown[]) => runModelSyncMock(...args),
}));

vi.mock('../../../agy/messageStore.js', () => ({
  saveMessage: vi.fn(),
}));

vi.mock('../../../stock/provider/fund.js', () => ({
  getFundDataset: vi.fn().mockResolvedValue(null),
}));

/* ========================================================================= */
/* 1. helpers (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('htmlToMarkdown', () => {
  it('should convert bold tags', () => {
    expect(htmlToMarkdown('<b>hello</b>')).toBe('**hello**');
  });

  it('should convert italic tags', () => {
    expect(htmlToMarkdown('<i>italic</i>')).toBe('*italic*');
  });

  it('should convert links', () => {
    expect(htmlToMarkdown('<a href="https://x.com">link</a>')).toBe('[link](https://x.com)');
  });

  it('should convert code blocks', () => {
    const html = '<pre><code class="language-js">const x = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toContain('```js');
    expect(htmlToMarkdown(html)).toContain('const x = 1;');
  });

  it('should convert inline code', () => {
    expect(htmlToMarkdown('<code>var</code>')).toBe('`var`');
  });

  it('should convert headers', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toContain('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub');
  });

  it('should convert details/summary to blockquote', () => {
    const html = '<details><summary>Thought</summary><p>content</p></details>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('> **Thought**');
    expect(result).toContain('> content');
  });

  it('should convert blockquote', () => {
    expect(htmlToMarkdown('<blockquote>quote</blockquote>')).toContain('> quote');
  });

  it('should unescape HTML entities in code', () => {
    const html = '<code>&lt;div&gt;</code>';
    expect(htmlToMarkdown(html)).toBe('`<div>`');
  });

  it('should strip multiple newlines', () => {
    expect(htmlToMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('should trim result', () => {
    expect(htmlToMarkdown('  <b>hi</b>  ')).toBe('**hi**');
  });
});

describe('extractTitleFromMarkdown', () => {
  it('should extract first h1', () => {
    const md = 'some text\n# Main Title\n\ncontent';
    expect(extractTitleFromMarkdown(md)).toBe('Main Title');
  });

  it('should prefer h1 over h2', () => {
    const md = '## Sub Title\n# Main Title';
    expect(extractTitleFromMarkdown(md)).toBe('Main Title');
  });

  it('should fallback to h2 when no h1', () => {
    const md = 'intro\n## Section\ncontent';
    expect(extractTitleFromMarkdown(md)).toBe('Section');
  });

  it('should fallback to first line when no headings', () => {
    const md = 'Just a plain line\n\nmore text';
    expect(extractTitleFromMarkdown(md)).toBe('Just a plain line');
  });

  it('should skip YAML frontmatter', () => {
    const md = '---\ntitle: hidden\n---\n# Real Title\nbody';
    expect(extractTitleFromMarkdown(md)).toBe('Real Title');
  });

  it('should strip inline formatting from fallback', () => {
    const md = '**bold** and *italic* text';
    expect(extractTitleFromMarkdown(md)).toBe('bold and italic text');
  });

  it('should fallback to first line if no header exists', () => {
    expect(extractTitleFromMarkdown('just plain text')).toBe('just plain text');
  });

  it('should return empty for empty input', () => {
    expect(extractTitleFromMarkdown('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    expect(escapeHtml('<b>bold</b> & "quoted"')).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; "quoted"');
  });

  it('should return empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should leave safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('truncate', () => {
  it('should truncate long text with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('should not truncate short text', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
});

describe('formatWelcome & formatHelp & formatSessionStats', () => {
  it('should format welcome and help messages correctly', () => {
    expect(formatWelcome('Alice')).toContain('Alice');
    expect(formatWelcome()).toContain('Gemini CLI');
    expect(formatHelp()).toContain('/model');
    const stats = formatSessionStats({
      sessionId: 'session-abc-123',
      model: 'Gemini 3.5 Flash',
      turnCount: 42,
      project: { id: 'proj-1', name: 'My Project', path: '/home/project' },
      createdAt: new Date(),
      activeSessions: 3,
    });
    expect(stats).toContain('Gemini 3.5 Flash');
    expect(stats).toContain('42');
  });
});

describe('rateLimiter', () => {
  it('should detect 429 and manage backoff state', () => {
    draftBackoffUntil.clear();
    expect(is429Error(null)).toBe(false);
    expect(is429Error({ error_code: 429 })).toBe(true);
    expect(get429RetryAfter({ parameters: { retry_after: 15 } })).toBe(15);
    record429Backoff(1, 10);
    expect(draftBackoffUntil.has(1)).toBe(true);
    reset429Backoff(1);
    expect(draftBackoffUntil.has(1)).toBe(false);
  });
});

/* ========================================================================= */
/* 2. callbackRouter (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('registerCallbackRouter', () => {
  let mockBot: any;
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;
  let callbackHandler: ((ctx: any, next: any) => Promise<void>) | null = null;

  beforeEach(() => {
    callbackHandler = null;
    mockBot = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'callback_query:data') callbackHandler = handler;
      }),
    };
    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
      getOrCreate: vi.fn().mockResolvedValue({}),
      getProjectManager: vi.fn().mockReturnValue({
        getProjects: vi.fn().mockReturnValue([]),
        getProject: vi.fn().mockReturnValue(null),
      }),
      getChatScheduler: vi.fn().mockReturnValue({
        getTasksForChat: vi.fn().mockReturnValue([]),
      }),
      reset: vi.fn(),
      destroyAll: vi.fn(),
    };
    defaultOptions = { model: 'Gemini 3.6 Flash (High)', cwd: '/test' };
  });

  it('should hand off inline-message callbacks to the next middleware without answering', async () => {
    registerCallbackRouter(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const next = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      callbackQuery: {
        data: 'inline_regenerate:ai-123-456',
        inline_message_id: 'test_inline_msg_id_123',
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    await callbackHandler!(mockCtx, next);

    expect(next).toHaveBeenCalled();
    expect(mockCtx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('should handle regular chat callbacks without calling next', async () => {
    registerCallbackRouter(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const next = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      callbackQuery: {
        data: '/status',
        inline_message_id: undefined,
      },
      chat: { id: 12345 },
      from: { first_name: 'Test' },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    };

    await callbackHandler!(mockCtx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockCtx.answerCallbackQuery).toHaveBeenCalled();
    expect(mockCtx.editMessageText).toHaveBeenCalled();
  });
});

/* ========================================================================= */
/* 3. settingsHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('registerSettingsHandler', () => {
  let mockBot: any;
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;
  let callbackHandler: ((ctx: any, next: any) => Promise<void>) | null = null;

  beforeEach(() => {
    callbackHandler = null;
    mockBot = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'callback_query:data') callbackHandler = handler;
      }),
      command: vi.fn(),
    };
    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
    };
    defaultOptions = { model: 'Gemini 3.6 Flash (High)', cwd: '/test' };
  });

  it('should forward non-settings callbacks to the next middleware (must not swallow)', async () => {
    registerSettingsHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const next = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      callbackQuery: { data: '/project_select 1234', inline_message_id: undefined },
      chat: { id: 12345 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    await callbackHandler!(mockCtx, next);

    expect(next).toHaveBeenCalled();
    expect(mockCtx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('should handle settings-prefixed callbacks and not forward', async () => {
    registerSettingsHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const next = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      callbackQuery: { data: 'settings:parseMode:HTML', inline_message_id: undefined },
      chat: { id: 12345 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    };

    await callbackHandler!(mockCtx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockCtx.editMessageText).toHaveBeenCalled();
  });
});

/* ========================================================================= */
/* 4. linkSummarizerHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('linkSummarizerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockParsedArXiv: any = {
    url: 'https://arxiv.org/abs/1706.03762',
    type: 'arxiv',
    title: 'Attention Is All You Need',
    author: 'Ashish Vaswani et al.',
    abstract: 'Transformer architecture introduction.',
    content: 'Full content of the paper abstract and methodology.',
  };

  it('should generate link summary using fallback model chain', async () => {
    vi.spyOn(inlineHandler, 'runModelWithFallbackChain').mockResolvedValueOnce({
      result: { output: '### 📄 Attention Is All You Need 精读报告\n\n1. 研究动机：取代 RNN 提高并行计算效率。' } as any,
      modelUsed: 'Gemini 3.7 Flash (High)',
      isFallback: false,
    });

    const res = await generateLinkSummary(mockParsedArXiv);
    expect(res.markdown).toContain('Attention Is All You Need 精读报告');
    expect(res.markdown).toContain('研究动机');
    expect(res.modelUsed).toBe('Gemini 3.7 Flash (High)');
  });

  it('should register /read and /summary commands on the bot', () => {
    const bot = {
      command: vi.fn(),
    } as any;

    registerLinkSummarizerCommands(bot);
    expect(bot.command).toHaveBeenCalledWith(['read', 'summary'], expect.any(Function));
  });
});

/* ========================================================================= */
/* 5. watchlistHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('watchlistHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build watchlist keyboard with action and deletion buttons', () => {
    const kb = buildWatchlistKeyboard(['NVDA', 'AAPL']);
    expect(kb).toBeDefined();
  });

  it('should render empty card if user has no watchlist symbols', async () => {
    vi.spyOn(dailyBriefing, 'collectWatchlistMarketData').mockResolvedValueOnce({
      symbols: [],
      watchlistQuotes: [],
      macroQuotes: {},
    });

    const card = await renderWatchlistCard(12345);
    expect(card.text).toContain('您的自选股监控池为空');
  });

  it('should render watchlist card with quotes and action buttons', async () => {
    vi.spyOn(dailyBriefing, 'collectWatchlistMarketData').mockResolvedValueOnce({
      symbols: ['NVDA'],
      watchlistQuotes: [
        {
          symbol: 'NVDA',
          name: 'NVIDIA Corporation',
          price: 130.5,
          change: 3.5,
          changePercent: 2.75,
          market: 'NASDAQ',
          currency: 'USD',
        },
      ],
      macroQuotes: {},
    });

    const card = await renderWatchlistCard(12345);
    expect(card.text).toContain('我的自选股实时监控池 (1 只标的)');
    expect(card.text).toContain('NVDA');
  });

  it('should register watchlist commands on the bot', () => {
    const bot = {
      command: vi.fn(),
      on: vi.fn(),
    } as any;

    registerWatchlistCommands(bot);
    expect(bot.command).toHaveBeenCalledWith(['watchlist', 'wl'], expect.any(Function));
    expect(bot.on).toHaveBeenCalledWith('callback_query:data', expect.any(Function));
  });
});

/* ========================================================================= */
/* 6. investDataFetcher (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('investDataFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getInvestProjectPath', () => {
    it('resolves the value-invest-analysis project from user config', () => {
      expect(getInvestProjectPath()).toBe('/fake/invest-project');
    });
  });

  describe('fetchInvestAnalysis', () => {
    it('resolves ok:true with parsed JSON data on success', async () => {
      const fakeJson = JSON.stringify({ symbol: '600519', grade: 'A-', totalScore: 68.4 });
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, fakeJson, '');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('600519', '/fake/invest-project');
      expect(result.ok).toBe(true);
      expect(result.symbol).toBe('600519');
      expect(result.data).toBe(fakeJson);
      const opts = vi.mocked(execFile).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env['FMP_API_KEY']).toBe('FAKE_FMP_KEY');
    });

    it('resolves ok:false with error message on script failure', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(new Error('spawn ENOENT'), '', 'DATA_ERROR: boom');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('BAD', '/fake/invest-project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('resolves ok:false on non-JSON output', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, 'not-json', '');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('X', '/fake/invest-project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid JSON');
    });
  });

  describe('buildInvestPrompt', () => {
    it('injects only the analysis data and keeps the user question', () => {
      const prompt = buildInvestPrompt('请对 600519 做深度价值投资分析。', '{"grade":"A-"}');
      expect(prompt).toContain('```json');
      expect(prompt).toContain('{"grade":"A-"}');
      expect(prompt).toContain('请对 600519 做深度价值投资分析。');
      expect(prompt).not.toContain('报告要求');
      expect(prompt).not.toContain('六维度');
    });
  });
});

/* ========================================================================= */
/* 7. investHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('investHandler', () => {
  let commands: Record<string, Function>;
  let callbackHandler: Function | undefined;
  let mockBot: Partial<Bot>;
  let mockSessionManager: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    commands = {};
    callbackHandler = undefined;
    mockBot = {
      command: vi.fn((name: string | string[], handler: Function) => {
        if (Array.isArray(name)) {
          for (const n of name) commands[n] = handler;
        } else {
          commands[name] = handler;
        }
        return mockBot as any;
      }),
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'callback_query:data') callbackHandler = handler;
        return mockBot as any;
      }),
    };

    mockSessionManager = {
      getOrCreate: vi.fn().mockResolvedValue({
        conversationId: 'test-conv-uuid',
      }),
    };

    mockCtx = {
      match: '',
      chat: { id: 123456 },
      message: { message_thread_id: undefined },
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    registerInvestHandler(mockBot as Bot, mockSessionManager, {});
  });

  it('should register /invest and /compare commands', () => {
    expect(mockBot.command).toHaveBeenCalledWith(['invest', 'compare'], expect.any(Function));
    expect(commands['invest']).toBeDefined();
    expect(commands['compare']).toBeDefined();
    expect(callbackHandler).toBeDefined();
  });

  it('should show usage when no symbol is provided', async () => {
    mockCtx.match = '';
    await commands['invest'](mockCtx);
    expect(mockCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Invest Usage:'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });
});

/* ========================================================================= */
/* 8. privateImageHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
describe('privateImageHandler', () => {
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;

  beforeEach(() => {
    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
      getProjects: vi.fn().mockReturnValue([]),
      getProjectsInConfigOrder: vi.fn().mockReturnValue([]),
    };
    defaultOptions = { cwd: '/tmp', model: 'Gemini 3.5 Flash' };
  });

  it('should detect /img requests only', () => {
    expect(isPrivateImageRequest('/img 一只猫')).toBe(true);
    expect(isPrivateImageRequest('/img  一只猫  ')).toBe(true);
    expect(isPrivateImageRequest('/img')).toBe(true);
    expect(isPrivateImageRequest('你好')).toBe(false);
    expect(isPrivateImageRequest('/flash 你好')).toBe(false);
  });

  it('should return false when no /img prefix', async () => {
    const ctx = {
      message: { text: '你好' },
      chat: { id: 123 },
      reply: vi.fn(),
      api: { sendChatAction: vi.fn() },
    } as unknown as Context;

    const handled = await handlePrivateImageRequest(ctx, mockSessionManager, defaultOptions);
    expect(handled).toBe(false);
  });
});

/* ========================================================================= */
/* 9. sumHandler (consolidated into commands.test.ts) */
/* ========================================================================= */
function makeMsg(overrides: Partial<Message>): Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 999, type: 'group', title: 'Test Group' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    text: 'hello world',
    ...overrides,
  } as Message;
}

describe('sumHandler chat_messages persistence', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_TELEGRAM_DB_PATH', ':memory:');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
  });

  it('should persist a text message and load it back oldest-first', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: 'first' }), '2026-01-01T00:00:00Z');
    persistChatMessage(makeMsg({ message_id: 2, text: 'second' }), '2026-01-01T00:00:01Z');

    const messages = loadRecentMessages(999, 10);
    expect(messages).toEqual([
      { senderName: 'Alice', text: 'first', messageId: 1 },
      { senderName: 'Alice', text: 'second', messageId: 2 },
    ]);
  });

  it('should skip command messages (starting with /)', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: '/sum 5' }));
    persistChatMessage(makeMsg({ message_id: 2, text: 'a real message' }));

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('a real message');
  });

  it('should deduplicate on (chat_id, message_id)', () => {
    persistChatMessage(makeMsg({ message_id: 5, text: 'dup' }), '2026-01-01T00:00:00Z');
    persistChatMessage(makeMsg({ message_id: 5, text: 'dup again' }), '2026-01-01T00:00:01Z');

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('dup');
  });

  it('should persist media caption when text is absent', () => {
    persistChatMessage(
      makeMsg({ message_id: 7, text: undefined, caption: 'a photo caption' }),
      '2026-01-01T00:00:00Z',
    );

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('a photo caption');
  });

  it('should load only the most recent N messages and trim older ones', () => {
    for (let i = 1; i <= 5; i++) {
      persistChatMessage(makeMsg({ message_id: i, text: `msg-${i}` }), `2026-01-01T00:00:0${i}Z`);
    }

    const recent = loadRecentMessages(999, 3);
    expect(recent.map((m) => m.text)).toEqual(['msg-3', 'msg-4', 'msg-5']);

    trimChatMessages(999, 3);
    expect(loadRecentMessages(999, 10)).toHaveLength(3);
  });

  it('should be isolated per chat id', () => {
    persistChatMessage(makeMsg({ chat: { id: 1, type: 'group', title: 'G1' }, message_id: 1, text: 'chat1' }));
    persistChatMessage(makeMsg({ chat: { id: 2, type: 'group', title: 'G2' }, message_id: 1, text: 'chat2' }));

    expect(loadRecentMessages(1, 10)).toHaveLength(1);
    expect(loadRecentMessages(2, 10)).toHaveLength(1);
    expect(loadRecentMessages(3, 10)).toHaveLength(0);
  });

  it('should be a no-op when message is undefined', () => {
    persistChatMessage(undefined);
    expect(loadRecentMessages(999, 10)).toHaveLength(0);
  });

  it('should support filtering by target username (case-insensitive)', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: 'msg from bob', from: { id: 10, is_bot: false, first_name: 'Bob', username: 'Bob_The_Builder' } }));
    persistChatMessage(makeMsg({ message_id: 2, text: 'msg from alice', from: { id: 20, is_bot: false, first_name: 'Alice', username: 'AliceInWonderland' } }));
    persistChatMessage(makeMsg({ message_id: 3, text: 'another from bob', from: { id: 10, is_bot: false, first_name: 'Bob', username: 'Bob_The_Builder' } }));

    const bobMsgs = loadRecentMessages(999, 10, 'bob_the_builder');
    expect(bobMsgs).toEqual([
      { senderName: 'Bob', text: 'msg from bob', messageId: 1 },
      { senderName: 'Bob', text: 'another from bob', messageId: 3 },
    ]);

    const aliceMsgs = loadRecentMessages(999, 10, 'ALICEINWONDERLAND');
    expect(aliceMsgs).toEqual([
      { senderName: 'Alice', text: 'msg from alice', messageId: 2 },
    ]);
  });
});

describe('Backends Health Monitor and /backends command', () => {
  beforeEach(() => {
    clearBackendHealth();
  });

  afterEach(() => {
    clearBackendHealth();
  });

  it('should list all 8 backends as healthy by default', () => {
    const statuses = getAllBackendHealthStatus();
    expect(statuses).toHaveLength(8);
    expect(statuses.every((s) => s.isHealthy)).toBe(true);

    const { text, keyboard } = formatBackendsStatus();
    expect(text).toContain('Model Backends Health Monitor');
    expect(text).toContain('Google Antigravity (AGY)');
    expect(text).toContain('Claude CLI');
    expect(text).toContain('Codex CLI');
    expect(text).toContain('OpenCode Local Engine');
    expect(text).toContain('DeepSeek Proxy');
    expect(text).toContain('Web2API Proxy');
    expect(text).toContain('GLM Proxy (chatglm)');
    expect(text).toContain('Qwen Proxy (tongyi)');
    expect(text).toContain('正常运作 (Healthy)');
    expect(keyboard.inline_keyboard).toBeDefined();
  });

  it('should display cooldown state when a backend fails', () => {
    markBackendFailed('deepseek');
    const statuses = getAllBackendHealthStatus();
    const deepseek = statuses.find((s) => s.channel === 'deepseek');
    expect(deepseek?.isHealthy).toBe(false);
    expect(deepseek?.failCount).toBe(1);
    expect(deepseek?.cooldownRemainingSeconds).toBeGreaterThan(0);

    const { text } = formatBackendsStatus();
    expect(text).toContain('🔴 <b>DeepSeek Proxy</b>');
    expect(text).toContain('熔断冷却中');
  });

  it('should register /backends command on bot', () => {
    const bot = {
      command: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const sessionManager = {
      getSession: vi.fn(),
      getSessionCount: vi.fn().mockReturnValue(1),
    } as unknown as SessionManager;
    const defaultOptions = { model: 'Gemini 3.7 Flash (High)' } as SessionOptions;

    registerConfigHandlers(bot, sessionManager, defaultOptions);
    expect(bot.command).toHaveBeenCalledWith('backends', expect.any(Function));
  });

  describe('/model sync command', () => {
    function httpNoop() {
      return { status: 'up-to-date', removals: [], upgrades: [], mediaReplacements: [], appliedLocations: [] };
    }
    function httpAllUpToDate() {
      return { web2api: httpNoop(), glm: httpNoop(), qwen: httpNoop(), mimo: httpNoop(), deepseek: httpNoop() };
    }

    function getModelHandler() {
      const bot = { command: vi.fn(), on: vi.fn() } as unknown as Bot;
      const sessionManager = { getSession: vi.fn() } as unknown as SessionManager;
      registerConfigHandlers(bot, sessionManager, { model: 'Gemini 3.7 Flash (High)' } as SessionOptions);
      const calls = vi.mocked(bot.command).mock.calls;
      const modelCall = calls.find(([name]) => name === 'model');
      return modelCall![1] as (ctx: unknown) => Promise<void>;
    }

    function makeCtx(match: string) {
      return {
        chat: { id: 42 },
        match,
        reply: vi.fn().mockResolvedValue({ message_id: 777 }),
        api: { editMessageText: vi.fn().mockResolvedValue({}) },
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('replies pending then edits the message with upgrade details', async () => {
      const handler = getModelHandler();
      const ctx = makeCtx('sync');
      runModelSyncMock.mockResolvedValue({
        status: 'updated',
        upgrades: [
          { family: 'Flash', effort: 'High', from: 'Gemini 3.7 Flash (High)', to: 'Gemini 3.8 Flash (High)' },
        ],
        appliedLocations: ['默认模型 (model)'],
        modelsJsonUpdated: true,
        opCode: {
          status: 'up-to-date',
          removals: [],
          upgrades: [],
          additions: [],
          appliedLocations: [],
          modelsJsonUpdated: false,
        },
        http: httpAllUpToDate(),
      });

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('⏳ 正在从 agy / opencode / 远程后端获取可用模型列表…');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(
        42,
        777,
        expect.stringContaining('Gemini 3.7 Flash (High)'),
        { parse_mode: 'HTML' },
      );
      const text = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(text).toContain('→');
      expect(text).toContain('已升级');
      expect(text).toContain('热生效');
    });

    it('renders the HTTP backend section: upgrades, media merges, errors — one backend failing does not hide the rest', async () => {
      const handler = getModelHandler();
      const ctx = makeCtx('sync');
      runModelSyncMock.mockResolvedValue({
        status: 'up-to-date',
        upgrades: [],
        appliedLocations: [],
        modelsJsonUpdated: false,
        opCode: {
          status: 'up-to-date',
          removals: [],
          upgrades: [],
          additions: [],
          appliedLocations: [],
          modelsJsonUpdated: false,
        },
        http: {
          ...httpAllUpToDate(),
          web2api: {
            status: 'updated',
            removals: [],
            upgrades: [{
              display: 'Web2API: Gemini 3.7 Flash Thinking',
              newDisplay: 'Web2API: Gemini 3.8 Flash Thinking',
              routingId: 'gemini-3.7-flash-thinking',
              newRoutingId: 'gemini-3.8-flash-thinking',
            }],
            mediaReplacements: [],
            appliedLocations: ['路由表 (routing)'],
          },
          qwen: {
            status: 'updated',
            removals: [],
            upgrades: [],
            mediaReplacements: [{
              displays: ['Qwen: Image 2.0', 'Qwen: Image 3.0'],
              newDisplay: 'Qwen: Image',
              newRoutingId: 'qwen3.8-max-image',
            }],
            appliedLocations: ['路由表 (routing)'],
          },
          glm: {
            status: 'error',
            removals: [],
            upgrades: [],
            mediaReplacements: [],
            appliedLocations: [],
            error: 'glm /models 返回 HTTP 502',
          },
        },
      });

      await handler(ctx);

      const text = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      // the http section alone still triggers a rendered message
      expect(text).toContain('远程后端模型已同步');
      expect(text).toContain('Web2API: Gemini 3.8 Flash Thinking');
      expect(text).toContain('Qwen: Image 2.0 + Qwen: Image 3.0');
      expect(text).toContain('qwen3.8-max-image');
      expect(text).toContain('部分远程后端同步失败');
      expect(text).toContain('HTTP 502');
    });

    it('reports up-to-date without upgrade list', async () => {
      const handler = getModelHandler();
      const ctx = makeCtx(' SYNC');
      runModelSyncMock.mockResolvedValue({
        status: 'up-to-date',
        upgrades: [],
        appliedLocations: [],
        modelsJsonUpdated: false,
        opCode: {
          status: 'up-to-date',
          removals: [],
          upgrades: [],
          additions: [],
          appliedLocations: [],
          modelsJsonUpdated: false,
        },
        http: httpAllUpToDate(),
      });

      await handler(ctx);

      expect(ctx.api.editMessageText).toHaveBeenCalled();
      const text = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(text).toContain('已是最新版本');
    });

    it('reports failure when runModelSync throws', async () => {
      const handler = getModelHandler();
      const ctx = makeCtx('sync');
      runModelSyncMock.mockRejectedValue(new Error('agy models exited with code 1'));

      await handler(ctx);

      const text = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(text).toContain('/model sync 失败');
      expect(text).toContain('agy models exited with code 1');
    });

    it('does not interfere with numeric /model selection', async () => {
      const handler = getModelHandler();
      const ctx = {
        chat: { id: 42 },
        match: '1',
        reply: vi.fn().mockResolvedValue({}),
      };
      const sessionManager = {
        getSession: vi.fn(),
        getOrCreate: vi.fn().mockResolvedValue({ config: { setModel: vi.fn() } }),
      } as unknown as SessionManager;
      // getModelHandler used a bare sessionManager; re-register with a capable one for this path
      const bot = { command: vi.fn(), on: vi.fn() } as unknown as Bot;
      registerConfigHandlers(bot, sessionManager, { model: 'Gemini 3.7 Flash (High)' } as SessionOptions);
      const numericHandler = vi.mocked(bot.command).mock.calls.find(([name]) => name === 'model')![1] as (ctx: unknown) => Promise<void>;
      // getAvailableModels is mocked to return ['Gemini 3.7 Flash (High)']
      await numericHandler(ctx);
      expect(runModelSyncMock).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Gemini 3.7 Flash (High)'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
      expect(handler).toBeTypeOf('function');
    });
  });

  it('should register /export command on bot', () => {
    const bot = {
      command: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const sessionManager = {
      getSession: vi.fn(),
    } as unknown as SessionManager;
    const defaultOptions = { model: 'Gemini 3.7 Flash (High)' } as SessionOptions;

    registerContentHandlers(bot, sessionManager, defaultOptions);
    expect(bot.command).toHaveBeenCalledWith('export', expect.any(Function));
  });

  it('should register /usage and session alias commands on bot', () => {
    const bot = {
      command: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const sessionManager = {
      getSession: vi.fn(),
    } as unknown as SessionManager;
    const defaultOptions = { model: 'Gemini 3.7 Flash (High)' } as SessionOptions;

    registerSessionHandlers(bot, sessionManager, defaultOptions);
    expect(bot.command).toHaveBeenCalledWith('usage', expect.any(Function));
    expect(bot.command).toHaveBeenCalledWith(['new', 'reset', 'clear'], expect.any(Function));
  });
});
