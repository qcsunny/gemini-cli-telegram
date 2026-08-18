/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerInlineHandler, parseInlineModelAndPrompt, fuzzyMatchModels, runModelWithFallbackChain, compareModelName, stripInlineImages, buildInlineStreamingBlocks } from './inlineHandler.js';
import { displayModelName } from '../../../core/modelRegistry.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

// Mock agyCli
vi.mock('../../../agy/agyCli.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../agy/agyCli.js')>();
  return {
    ...mod,
    runAgyPrint: vi.fn().mockImplementation(async (opts: any) => {
      if (opts?.onChunk) {
        opts.onChunk('这是关于量子计算的测试回答。');
      }
      return {
        output: '这是关于量子计算的测试回答。',
      };
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue(['generated-image.png', '.system_generated']),
  stat: vi.fn().mockResolvedValue({ isFile: () => true, mtimeMs: Date.now() }),
}));

// Only override getAgyDataDir; keep all other userConfig exports intact.
vi.mock('../../../config/userConfig.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../config/userConfig.js')>();
  return { ...mod, getAgyDataDir: vi.fn().mockReturnValue('/tmp/agy-data') };
});

// Mock blocks formatter
vi.mock('../formatter/blocks.js', () => ({
  markdownToRichBlocks: vi.fn().mockImplementation((markdown: string) => ([
    { type: 'paragraph', text: markdown },
  ])),
  buildFinalBlocks: vi.fn().mockImplementation((content: string) => ([
    { type: 'paragraph', text: content },
  ])),
  buildFooterBlocksFromHtml: vi.fn().mockReturnValue([]),
}));

// Mock invest data fetcher (spawns value-invest-analysis subprocess)
vi.mock('./investDataFetcher.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./investDataFetcher.js')>();
  return {
    ...mod,
    fetchInvestAnalysis: vi.fn().mockResolvedValue({ ok: true, symbol: '600519', data: '{"grade":"A-","totalScore":68.4,"dimensions":[]}' }),
    getInvestProjectPath: vi.fn().mockReturnValue('/fake/invest'),
  };
});

describe('displayModelName', () => {
  it('should strip version number from Claude Opus', () => {
    expect(displayModelName('Claude Opus 4.6 (Thinking)')).toBe('Claude Opus (Thinking)');
  });

  it('should strip version number from Claude Sonnet', () => {
    expect(displayModelName('Claude Sonnet 4.6 (Thinking)')).toBe('Claude Sonnet (Thinking)');
  });

  it('should leave other model names unchanged', () => {
    expect(displayModelName('Gemini 3.6 Flash (High)')).toBe('Gemini 3.6 Flash (High)');
    expect(displayModelName('Web2API: Gemini 3.1 Pro Enhanced')).toBe('Web2API: Gemini 3.1 Pro Enhanced');
    expect(displayModelName('DeepSeek: Pro Thinking')).toBe('DeepSeek: Pro Thinking');
  });
});

describe('compareModelName', () => {
  it('should hide backend prefixes only in compare display', () => {
    expect(compareModelName('Web2API: Gemini 3.1 Pro Enhanced')).toBe('Gemini 3.1 Pro Enhanced');
    expect(compareModelName('OpenCode: Qwen 3.6 35B A3B')).toBe('Qwen 3.6 35B A3B');
  });

  it('should keep DeepSeek prefix since DeepSeek is a model family name', () => {
    expect(compareModelName('DeepSeek: Pro Thinking')).toBe('DeepSeek: Pro Thinking');
  });

  it('should leave unprefixed names unchanged', () => {
    expect(compareModelName('Gemini 3.6 Flash (High)')).toBe('Gemini 3.6 Flash (High)');
  });
});

describe('stripInlineImages', () => {
  it('should strip markdown images with non-http URLs but keep alt text (invalid-only)', () => {
    expect(stripInlineImages('![logo](data:image/png;base64,abc)', 'invalid-only')).toBe('logo');
    expect(stripInlineImages('![shot](/local/path.png)', 'invalid-only')).toBe('shot');
    expect(stripInlineImages('![shot](tg://photo?id=1)', 'invalid-only')).toBe('shot');
  });

  it('should keep http(s) markdown images in invalid-only mode', () => {
    const md = 'see ![diagram](https://example.com/a.png) above';
    expect(stripInlineImages(md, 'invalid-only')).toBe(md);
  });

  it('should strip all markdown images (keeping alt) in all mode', () => {
    expect(stripInlineImages('see ![diagram](https://example.com/a.png) above', 'all')).toBe('see diagram above');
  });

  it('should strip non-http HTML <img> tags in invalid-only mode and all <img> tags in all mode', () => {
    expect(stripInlineImages('<img src="file:///tmp/x.png"> text', 'invalid-only')).toBe(' text');
    expect(stripInlineImages('text <img src="https://example.com/a.png">', 'all')).toBe('text ');
    expect(stripInlineImages('text <img src="https://example.com/a.png">', 'invalid-only')).toBe('text <img src="https://example.com/a.png">');
  });

  it('should handle empty and image-free input', () => {
    expect(stripInlineImages('', 'all')).toBe('');
    expect(stripInlineImages('plain text, no images', 'invalid-only')).toBe('plain text, no images');
  });
});

describe('buildInlineStreamingBlocks', () => {
  it('uses ordinary paragraphs while thinking and when body starts', () => {
    const thinking = buildInlineStreamingBlocks({ prompt: 'Q', model: 'M', thought: 'step one' }) as any[];
    expect(thinking.some(block => block.type === 'details')).toBe(false);
    expect(JSON.stringify(thinking)).toContain('step one');

    const body = buildInlineStreamingBlocks({ prompt: 'Q', model: 'M', thought: 'step one', content: 'answer' }) as any[];
    expect(body.some(block => block.type === 'details')).toBe(false);
    expect(JSON.stringify(body)).toContain('Answer');
    expect(body.some(block => block.type === 'paragraph')).toBe(true);
  });
});

describe('runModelWithFallbackChain', () => {
  const defaultOptions: SessionOptions = { cwd: '/tmp', model: 'Gemini 3.5 Flash (Medium)' };

  it('should NOT return partial output as success when the user stops mid-stream', async () => {
    // web2api/deepseek/opencode backends RESOLVE (not reject) with partial
    // output and exitCode 1 on abort, leaving isTimeout undefined. The chain
    // must treat that as a stopped/failed run, not a "successful" answer.
    const originalImpl = (runAgyPrint as any).getMockImplementation();
    (runAgyPrint as any).mockImplementation(async (opts: any) => {
      if (opts?.signal?.aborted) {
        return { conversationId: 'conv', output: '部分回答', exitCode: 1, stderr: 'Aborted' };
      }
      return { conversationId: 'conv', output: '这是完整回答。', exitCode: 0 };
    });

    try {
      const ctrl = new AbortController();
      const result = await runModelWithFallbackChain('test', 'Gemini 3.5 Flash (Medium)', defaultOptions, ctrl.signal);
      // Signal not yet aborted → normal full answer.
      expect(result.result?.output).toBe('这是完整回答。');

      ctrl.abort();
      const stopped = await runModelWithFallbackChain('test', 'Gemini 3.5 Flash (Medium)', defaultOptions, ctrl.signal);
      expect(stopped.result).toBeNull();
      expect(stopped.modelUsed).toBe('Gemini 3.5 Flash (Medium)');
    } finally {
      (runAgyPrint as any).mockImplementation(originalImpl);
    }
  });

  it('should return full output when an aborted attempt yields empty partial output', async () => {
    const originalImpl = (runAgyPrint as any).getMockImplementation();
    let callCount = 0;
    (runAgyPrint as any).mockImplementation(async (opts: any) => {
      callCount++;
      // First attempt aborted by inactivity timeout (isTimeout set, no user stop).
      if (callCount === 1) {
        return { conversationId: 'conv', output: '', exitCode: 1, isTimeout: true, stderr: 'timeout' };
      }
      return { conversationId: 'conv', output: '重试后的完整回答。', exitCode: 0 };
    });

    try {
      const result = await runModelWithFallbackChain('test', 'Gemini 3.5 Flash (Medium)', defaultOptions);
      expect(result.result?.output).toBe('重试后的完整回答。');
      expect(callCount).toBe(2);
    } finally {
      (runAgyPrint as any).mockImplementation(originalImpl);
    }
  });
});


describe('parseInlineModelAndPrompt', () => {
  it('should parse any @keyword as family search', () => {
    const res = parseInlineModelAndPrompt('@flash 什么是量子计算', 'Gemini 3.5 Flash (Medium)');
    expect(res.family).toBe('flash');
    expect(res.model).toBe('Gemini 3.5 Flash (Medium)');
    expect(res.prompt).toBe('什么是量子计算');

    const res2 = parseInlineModelAndPrompt('@think 分析一下', 'Gemini 3.5 Flash');
    expect(res2.family).toBe('think');
    expect(res2.prompt).toBe('分析一下');
  });

  it('should parse /p:N and /pN project index and strip flag from prompt', () => {
    const mockProjects: any = [{ name: 'Project A', path: '/path/a' }, { name: 'Project B', path: '/path/b' }];
    const res1 = parseInlineModelAndPrompt('@pro /p:1 怎么重构代码', 'Gemini 3.5 Flash', mockProjects);
    expect(res1.family).toBe('pro');
    expect(res1.prompt).toBe('怎么重构代码');
    expect(res1.projectUsed).toEqual(mockProjects[0]);

    const res2 = parseInlineModelAndPrompt('@pro /p2 怎么写算法', 'Gemini 3.5 Flash', mockProjects);
    expect(res2.family).toBe('pro');
    expect(res2.prompt).toBe('怎么写算法');
    expect(res2.projectUsed).toEqual(mockProjects[1]);
  });

  it('should parse task prefixes and wrap prompt with instruction', () => {
    const res = parseInlineModelAndPrompt('/translate 你好世界', 'Gemini 3.5 Flash');
    expect(res.task).toBe('translate');
    expect(res.prompt).toContain('Translate the following content between Chinese and English');
    expect(res.prompt).toContain('你好世界');
  });

  it('should parse combined family + task prefixes in any order', () => {
    const res1 = parseInlineModelAndPrompt('@flash /summarize 量子计算', 'Gemini 3.5 Flash');
    expect(res1.family).toBe('flash');
    expect(res1.task).toBe('summarize');
    expect(res1.prompt).toContain('Summarize the following content concisely');
    expect(res1.prompt).toContain('量子计算');

    const res2 = parseInlineModelAndPrompt('/v @pro 这个报错', 'Gemini 3.5 Flash');
    expect(res2.family).toBe('pro');
    expect(res2.task).toBe('compare');
  });

  it('should mark /img as image task and wrap prompt with image instruction', () => {
    const res = parseInlineModelAndPrompt('/img 一只猫', 'Gemini 3.5 Flash');
    expect(res.task).toBe('image');
    expect(res.prompt).toContain('generate_image');
    expect(res.prompt).toContain('一只猫');
  });

  it('should keep unknown prefix in prompt', () => {
    const res = parseInlineModelAndPrompt('/unknown 什么情况', 'Gemini 3.5 Flash');
    expect(res.task).toBeUndefined();
    expect(res.family).toBeUndefined();
    expect(res.prompt).toBe('/unknown 什么情况');
  });

  it('should treat @p as a family search since project uses /p now', () => {
    const res = parseInlineModelAndPrompt('@p2 怎么写算法', 'Gemini 3.5 Flash', [{ id: 'a', name: 'Project A', path: '/a' }, { id: 'b', name: 'Project B', path: '/b' }]);
    expect(res.family).toBe('p2');
    expect(res.projectUsed).toBeUndefined();
    expect(res.prompt).toBe('怎么写算法');
  });
});

describe('fuzzyMatchModels', () => {
  const models = [
    'Gemini 3.6 Flash (High)',
    'Web2API: Gemini 3.1 Pro',
    'DeepSeek: Flash',
    'Claude Opus 4.6 (Thinking)',
    'Claude Sonnet 4.6 (Thinking)',
    'OpenCode: Nemotron 3 Ultra Free',
    'GPT-OSS 120B (Medium)',
    'OpenCode: DeepSeek V4 Flash Free',
  ];

  it('should match sonnet to Claude Sonnet model', () => {
    const res = fuzzyMatchModels('用 sonnet 解释一下', models, 5);
    expect(res).toContain('Claude Sonnet 4.6 (Thinking)');
    expect(res[0]).toBe('Claude Sonnet 4.6 (Thinking)');
  });

  it('should match nemo to OpenCode Nemotron', () => {
    const res = fuzzyMatchModels('nemo 写代码', models, 5);
    expect(res[0]).toBe('OpenCode: Nemotron 3 Ultra Free');
  });

  it('should match gpt to GPT-OSS 120B', () => {
    const res = fuzzyMatchModels('gpt 简述', models, 5);
    expect(res[0]).toBe('GPT-OSS 120B (Medium)');
  });

  it('should match flash with channel-prefixed models too', () => {
    const res = fuzzyMatchModels('/flash 提问', models, 5);
    expect(res).toContain('Gemini 3.6 Flash (High)');
    expect(res).toContain('DeepSeek: Flash');
    expect(res).toContain('OpenCode: DeepSeek V4 Flash Free');
  });

  it('should respect limit and drop no-match tokens', () => {
    const res = fuzzyMatchModels('量子计算 没有模型', models, 2);
    expect(res.length).toBe(0);
  });

  it('should return empty for empty query', () => {
    expect(fuzzyMatchModels('', models, 5)).toEqual([]);
    expect(fuzzyMatchModels('   ', models, 5)).toEqual([]);
  });
});

describe('registerInlineHandler', () => {
  let mockBot: any;
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;
  let inlineQueryHandler: ((ctx: any) => Promise<void>) | null = null;
  let chosenInlineResultHandler: ((ctx: any) => Promise<void>) | null = null;
  let callbackQueryHandler: ((ctx: any) => Promise<void>) | null = null;

  beforeEach(() => {
    inlineQueryHandler = null;
    chosenInlineResultHandler = null;
    callbackQueryHandler = null;
    mockBot = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'inline_query') {
          inlineQueryHandler = handler;
        }
        if (event === 'chosen_inline_result') {
          chosenInlineResultHandler = handler;
        }
        if (event === 'callback_query:data') {
          callbackQueryHandler = handler;
        }
      }),
    };

    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
      getOrCreate: vi.fn().mockImplementation(async (chatId: number) => mockSessionManager.getSession(chatId)),
      getProjects: vi.fn().mockReturnValue([]),
      getProjectsInConfigOrder: vi.fn().mockReturnValue([]),
    };

    defaultOptions = {
      model: 'Gemini 3.6 Flash (Medium)',
      cwd: '/test/dir',
    };
  });

  it('should register inline_query and chosen_inline_result event listeners on bot', () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);
    expect(mockBot.on).toHaveBeenCalledWith('inline_query', expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith('chosen_inline_result', expect.any(Function));
  });

  it('should deny unauthorized user if allowedUsers is configured', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions, {
      allowedUsers: [12345],
    });

    const mockCtx = {
      from: { id: 99999 },
      inlineQuery: { query: 'test query' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'unauthorized',
          title: expect.stringContaining('Unauthorized access'),
        }),
      ]),
      expect.objectContaining({ cache_time: 10 }),
    );
  });

  it('should return help cards when query is empty', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '   ' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'help-main',
          title: expect.stringContaining('Ask AI'),
        }),
      ]),
      expect.objectContaining({ cache_time: 0, is_personal: true }),
    );
  });

  it('should return placeholder cards for valid query', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^ai-/),
          title: expect.stringContaining('Ask'),
          input_message_content: expect.objectContaining({
            rich_message: expect.objectContaining({
              blocks: expect.any(Array),
            }),
          }),
          // Inline keyboard is required for Telegram to return inline_message_id
          // on chosen_inline_result (regression guard for 1056263).
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      ]),
      expect.objectContaining({ cache_time: 0 }),
    );
    // Question card was removed — results must NOT contain a prompt-/question card.
    const results = mockCtx.answerInlineQuery.mock.calls[0][0];
    expect(results.some((r: any) => r.id.startsWith('prompt-') || r.title.includes('question card'))).toBe(false);
  });

  it('should route /invest <symbol> as a normal AI query (project-tailored, not a card)', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/invest BTBT' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^ai-/),
          title: expect.stringContaining('Ask'),
        }),
      ]),
      expect.objectContaining({ cache_time: 0, is_personal: true }),
    );
    // /invest is handled as a normal AI query, not a scoring card.
    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/^investreq-/) }),
      ]),
      expect.any(Object),
    );
  });

  it('should NOT enable tool permissions for a plain AI query', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResult = callArg.find((r: any) => r.id.startsWith('ai-'));

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResult.id,
        from: { id: 12345 },
        query: '什么是量子计算？',
        inline_message_id: 'test_inline_msg_id_plain',
      },
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
    };
    const chosenPromise = chosenInlineResultHandler!(mockChosenCtx);
    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalled();
    });

    const agyCall = (runAgyPrint as any).mock.calls.find((c: any[]) => (c[0].prompt || '').includes('量子计算'));
    expect(agyCall).toBeDefined();
    expect(agyCall[0].allowTools).toBeFalsy();

    await chosenPromise;
  });

  it('should prefetch value-invest analysis data after clicking /invest card and pass it to the model', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const { fetchInvestAnalysis } = await import('./investDataFetcher.js');
    vi.mocked(fetchInvestAnalysis).mockResolvedValue({ ok: true, symbol: '600519', data: '{"grade":"A-","totalScore":68.4,"dimensions":[]}' });

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/invest 600519' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResult = callArg.find((r: any) => r.id.startsWith('ai-'));
    expect(aiResult).toBeDefined();

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResult.id,
        from: { id: 12345 },
        query: '/invest 600519',
        inline_message_id: 'test_inline_msg_id_invest',
      },
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
    };
    const chosenPromise = chosenInlineResultHandler!(mockChosenCtx);
    await vi.waitFor(() => {
      expect(fetchInvestAnalysis).toHaveBeenCalledWith('600519', expect.any(String));
    });
    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalled();
    });

    const agyCall = (runAgyPrint as any).mock.calls.find((c: any[]) => (c[0].prompt || '').includes('totalScore'));
    expect(agyCall).toBeDefined();
    expect(agyCall[0].prompt).toContain('```json');
    expect(agyCall[0].prompt).toContain('totalScore');
    expect(agyCall[0].prompt).toContain('深度价值投资分析');
    // /invest flow must enable model tools (auto-approve) so it can supplement missing data.
    expect(agyCall[0].allowTools).toBe(true);

    await chosenPromise;
  });

  it('should fall back to plain AI query when invest script fails', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const { fetchInvestAnalysis } = await import('./investDataFetcher.js');
    vi.mocked(fetchInvestAnalysis).mockResolvedValue({ ok: false, error: 'DATA_ERROR: boom' });

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/invest BAD' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResult = callArg.find((r: any) => r.id.startsWith('ai-'));

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResult.id,
        from: { id: 12345 },
        query: '/invest BAD',
        inline_message_id: 'test_inline_msg_id_invest_fail',
      },
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
    };
    const chosenPromise = chosenInlineResultHandler!(mockChosenCtx);
    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalled();
    });

    const agyCall = (runAgyPrint as any).mock.calls.find((c: any[]) => (c[0].prompt || '').includes('/invest'));
    expect(agyCall).toBeDefined();
    // Fallback keeps the plain /invest query, no injected JSON.
    expect(agyCall[0].prompt).not.toContain('```json');

    await chosenPromise;
  });

  it('should use a stop button on the initial placeholder card', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    const aiResult = callArg.find((r: any) => r.id.startsWith('ai-'));
    expect(aiResult.reply_markup.inline_keyboard[0][0]).toEqual({
      text: '⏹ Stop',
      callback_data: `inline_stop:${aiResult.id}`,
    });
  });

  it('should abort the running controller on inline_stop callback', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    // Hold the generation open so the controller stays registered when we
    // press the stop button (the default mock resolves synchronously).
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const originalImpl = (runAgyPrint as any).getMockImplementation();
    (runAgyPrint as any).mockImplementation(async (opts: any) => {
      if (opts?.onChunk) opts.onChunk('流式内容');
      await generationGate;
      if (opts?.signal?.aborted) {
        const err: any = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { output: '这是最终回答。' };
    });

    try {
      const inlineCtx = {
        from: { id: 12345 },
        inlineQuery: { query: '什么是量子计算？' },
        answerInlineQuery: vi.fn().mockResolvedValue(true),
      };
      await inlineQueryHandler!(inlineCtx);

      const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
      const aiResultId = callArg.find((r: any) => r.id.startsWith('ai-')).id;

      const mockChosenCtx = {
        me: { username: 'testbot' },
        chosenInlineResult: {
          result_id: aiResultId,
          from: { id: 12345 },
          query: '什么是量子计算？',
          inline_message_id: 'test_inline_msg_id_123',
        },
        api: {
          raw: { editMessageText: vi.fn().mockResolvedValue(true) },
        },
      };
      const chosenPromise = chosenInlineResultHandler!(mockChosenCtx);
      await vi.waitFor(() => {
        expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalled();
      });

      const stopCtx = {
        callbackQuery: {
          data: `inline_stop:${aiResultId}`,
          inline_message_id: 'test_inline_msg_id_123',
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        api: {
          raw: { editMessageText: vi.fn().mockResolvedValue(true) },
        },
      };

      await callbackQueryHandler!(stopCtx);

      // Release the gate so the aborted generation can finish unwinding.
      releaseGeneration();
      await chosenPromise;

      expect(stopCtx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Stop requested') }),
      );
      // The stopped generation edits its own message (via the chosen ctx):
      // partial output is preserved and folded, and the Stop button becomes
      // the Regenerate button.
      const stopEdits = (mockChosenCtx.api.raw.editMessageText.mock.calls as any[])
        .map((c) => c[0])
        .filter((p: any) => p?.rich_message?.markdown?.includes('生成已停止'));
      expect(stopEdits.length).toBeGreaterThan(0);
      const stopPayload = stopEdits[stopEdits.length - 1];
      expect(stopPayload.inline_message_id).toBe('test_inline_msg_id_123');
      expect(stopPayload.rich_message.markdown).toContain('流式内容');
      expect(stopPayload.rich_message.markdown).toContain('<details>');
      expect(stopPayload.reply_markup.inline_keyboard).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('Regenerate'), callback_data: expect.stringContaining(`inline_regenerate:${aiResultId}`) }),
          ]),
        ]),
      );
    } finally {
      (runAgyPrint as any).mockImplementation(originalImpl);
      releaseGeneration();
    }
  });

  it('should handle regenerate callback and re-run answer', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    // Trigger inline query first to populate pendingResults
    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResultId = callArg.find((r: any) => r.id.startsWith('ai-')).id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResultId,
        from: { id: 12345 },
        query: '什么是量子计算？',
        inline_message_id: 'test_inline_msg_id_123',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);

    // Wait for async runModelWithFallbackChain in background to complete
    await vi.waitFor(() => {
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'test_inline_msg_id_123',
          rich_message: expect.objectContaining({
            blocks: expect.any(Array),
          }),
        }),
      );
    });
  });

  it('should not edit when inline_message_id is missing', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: 'test' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const mockChosenCtx = {
      chosenInlineResult: {
        result_id: 'some-id',
        from: { id: 12345 },
        query: 'test',
        // no inline_message_id
      },
      api: {
        raw: {
          editMessageText: vi.fn(),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);
    expect(mockChosenCtx.api.raw.editMessageText).not.toHaveBeenCalled();
  });

  it('should handle regenerate callback and re-run answer', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResultId = callArg.find((r: any) => r.id.startsWith('ai-')).id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResultId,
        from: { id: 12345 },
        query: '什么是量子计算？',
        inline_message_id: 'test_inline_msg_id_123',
      },
      api: {
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);
    await vi.waitFor(() => {
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalled();
    });

    const regenCtx = {
      callbackQuery: {
        data: `inline_regenerate:${aiResultId}`,
        inline_message_id: 'test_inline_msg_id_123',
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      api: {
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await callbackQueryHandler!(regenCtx);
    await vi.waitFor(() => {
      expect(regenCtx.answerCallbackQuery).toHaveBeenCalled();
      expect(regenCtx.api.raw.editMessageText).toHaveBeenCalled();
    });
  });

  it('should answer callback query with alert for inline_thinking', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      callbackQuery: {
        data: 'inline_thinking',
        inline_message_id: 'test_inline_msg_id_123',
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    await callbackQueryHandler!(mockCtx);

    expect(mockCtx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it('should append model suggestion cards for fuzzy-matched queries', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '用 sonnet 解释一下量子计算' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    const suggestionCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    expect(suggestionCards.length).toBeGreaterThan(0);
    expect(suggestionCards[0].title).toContain('Answer with');
    expect(suggestionCards[0].title).toContain('Sonnet');
    expect(suggestionCards[0].reply_markup.inline_keyboard).toBeDefined();
  });

  it('should list all family models as m-cards (no primary/ai card) when @flash family keyword is used', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '@flash 什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    // Family mode: ONLY m- model cards, no ai- primary card, no prompt- card.
    const modelCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    expect(modelCards.length).toBeGreaterThan(0);
    expect(callArg.filter((r: any) => r.id.startsWith('ai-'))).toHaveLength(0);
    expect(callArg.filter((r: any) => r.id.startsWith('prompt-'))).toHaveLength(0);
    for (const card of modelCards) {
      expect(card.title).toMatch(/Flash|flash/i);
    }
  });

  it('should list deepseek family models when @deep keyword is used', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '@deep 你好' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    const suggestionCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    expect(suggestionCards.length).toBeGreaterThan(0);
    for (const card of suggestionCards) {
      expect(card.title).toMatch(/DeepSeek|deepseek/i);
    }
  });

  it('should list thinking models when @think keyword is used', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '@think 分析一下' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    const suggestionCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    expect(suggestionCards.length).toBeGreaterThan(0);
    for (const card of suggestionCards) {
      expect(card.title).toMatch(/Thinking|thinking/i);
    }
  });

  it('should run with the selected family model when an m-card is chosen', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '@think 分析一下' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const mCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    const mResultId = mCards[1].id;
    const { pendingResults } = await import('./inlineHandler.js');
    const chosenModel = pendingResults.get(mResultId)!.model;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: mResultId,
        from: { id: 12345 },
        query: '@think 分析一下',
        inline_message_id: 'test_inline_msg_id_456',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);

    // runAgyPrint must have been called with the model from the chosen card.
    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalledWith(
        expect.objectContaining({ model: chosenModel }),
      );
    });
  });

  it('should allow two model cards to run concurrently with independent results', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);
    (runAgyPrint as any).mockClear();

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '@think 分析一下' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const mCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    const cardA = mCards[0];
    const cardB = mCards[1];

    const chosenFor = (resultId: string, inlineMessageId: string) => ({
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '@think 分析一下',
        inline_message_id: inlineMessageId,
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
    });

    const { pendingResults } = await import('./inlineHandler.js');
    const modelA = pendingResults.get(cardA.id)!.model;
    const modelB = pendingResults.get(cardB.id)!.model;

    // Choose both cards without awaiting: they must run in parallel.
    const ctxA = chosenFor(cardA.id, 'inline_msg_A');
    const ctxB = chosenFor(cardB.id, 'inline_msg_B');
    const pA = chosenInlineResultHandler!(ctxA);
    const pB = chosenInlineResultHandler!(ctxB);
    await Promise.all([pA, pB]);

    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalledTimes(2);
    });

    const calls = (runAgyPrint as any).mock.calls.map((c: any[]) => c[0].model);
    expect(calls).toContain(modelA);
    expect(calls).toContain(modelB);

    // Each card edited its own inline message.
    expect(ctxA.api.raw.editMessageText).toHaveBeenCalled();
    expect(ctxB.api.raw.editMessageText).toHaveBeenCalled();
  });

  it('should not append suggestion cards for image task', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/img 一只猫' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    const callArg = mockCtx.answerInlineQuery.mock.calls[0][0];
    const suggestionCards = callArg.filter((r: any) => r.id.startsWith('m-'));
    expect(suggestionCards.length).toBe(0);
  });

  it('should render generated image in-place via rich_message media', async () => {
    // Return a conversationId so image artifact scanning runs
    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      if (opts?.onChunk) opts.onChunk('');
      return { output: '生成完成', conversationId: 'test-conv-123', exitCode: 0 };
    });

    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/img 一只猫' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    const aiResultId = callArg.find((r: any) => r.id.startsWith('ai-')).id;
    expect(callArg.find((r: any) => r.id.startsWith('ai-')).title).toContain('Click to generate image');

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResultId,
        from: { id: 12345 },
        query: '/img 一只猫',
        inline_message_id: 'test_inline_msg_id_123',
      },
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({
          message_id: 999,
          rich_message: {
            blocks: [
              {
                type: 'photo',
                photo: [
                  { file_id: 'photo_small', file_size: 100 },
                  { file_id: 'photo_large', file_size: 5000 },
                ],
              },
            ],
          },
        }),
        deleteMessage: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
          editMessageMedia: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);

    await vi.waitFor(() => {
      expect(mockChosenCtx.api.sendRichMessage).toHaveBeenCalledWith(
        12345,
        expect.objectContaining({
          markdown: expect.stringContaining('tg://photo?id='),
          media: expect.arrayContaining([
            expect.objectContaining({
              media: expect.objectContaining({ type: 'photo' }),
            }),
          ]),
        }),
      );
      // Transient relay message is deleted so the image only shows in-line.
      expect(mockChosenCtx.api.deleteMessage).toHaveBeenCalledWith(12345, 999);
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'test_inline_msg_id_123',
          rich_message: expect.objectContaining({
            markdown: expect.stringContaining('tg://photo?id='),
            media: expect.arrayContaining([
              expect.objectContaining({
                media: expect.objectContaining({ type: 'photo', media: 'photo_large' }),
              }),
            ]),
          }),
        }),
      );
      expect(mockChosenCtx.api.raw.editMessageMedia).not.toHaveBeenCalled();
    });
  });

  it('should render compare picker with pagination and dynamic buttons', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v 对比一下方案' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);
    const resultId = inlineCtx.answerInlineQuery.mock.calls[0][0][0].id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '/v 对比一下方案',
        inline_message_id: 'cmp_inline_msg',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };
    await chosenInlineResultHandler!(mockChosenCtx);

    // Initial page 0 cover mode should show default/page buttons
    await vi.waitFor(() => {
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'cmp_inline_msg',
          rich_message: expect.objectContaining({
            markdown: expect.stringContaining('⚖️ Multi-model comparison'),
          }),
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: expect.stringContaining('inline_cmp_default:') }),
              ]),
            ]),
          }),
        }),
      );
    });

    // Click page 2 button
    const pickCtxBase = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
      callbackQuery: { inline_message_id: 'cmp_inline_msg', data: '' },
    };
    await callbackQueryHandler!({ ...pickCtxBase, callbackQuery: { ...pickCtxBase.callbackQuery, data: `inline_cmp_page:${resultId}:1` } });

    // Page 2 should show different models
    await vi.waitFor(() => {
      expect(pickCtxBase.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'cmp_inline_msg',
          rich_message: expect.objectContaining({
            markdown: expect.stringContaining('1. Please pick model 1'),
          }),
        }),
      );
    });

    // Pick page 1 keyboard should have home button and next button
    const page2Page = pickCtxBase.api.raw.editMessageText.mock.calls[0][0];
    const page2Buttons = page2Page.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
    expect(page2Buttons.find((b) => b.text === '◀️ First')).toBeDefined();
    expect(page2Buttons.find((b) => b.text === 'Next ▶️')).toBeDefined();

    // Click previous page
    await callbackQueryHandler!({
      ...pickCtxBase,
      callbackQuery: { ...pickCtxBase.callbackQuery, data: 'inline_cmp_page:' + resultId + ':0' },
    });

    // Back to page 0 cover mode, should show browse models button
    await vi.waitFor(() => {
      const backPage = pickCtxBase.api.raw.editMessageText.mock.calls.slice(-1)[0][0];
      const backButtons = backPage.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
      expect(backButtons.find((b) => b.text === '◀️ Prev')).toBeUndefined();
      expect(backButtons.find((b) => b.text.includes('Browse/select models'))).toBeDefined();
    });
  });

  it('should allow selecting models across pages', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v 对比一下方案' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);
    const resultId = inlineCtx.answerInlineQuery.mock.calls[0][0][0].id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '/v 对比一下方案',
        inline_message_id: 'cmp_inline_msg',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };
    await chosenInlineResultHandler!(mockChosenCtx);

    // Pick button on page 1
    const pickCtxBase = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
      callbackQuery: { inline_message_id: 'cmp_inline_msg', data: '' },
    };
    await callbackQueryHandler!({
      ...pickCtxBase,
      callbackQuery: { ...pickCtxBase.callbackQuery, data: `inline_cmp_pick:${resultId}:0` },
    });

    // Select 2 models
    await callbackQueryHandler!({
      ...pickCtxBase,
      callbackQuery: { ...pickCtxBase.callbackQuery, data: `inline_cmp_pick:${resultId}:1` },
    });

    // Go to page 2 and pick another model
    await callbackQueryHandler!({
      ...pickCtxBase,
      callbackQuery: { ...pickCtxBase.callbackQuery, data: 'inline_cmp_page:' + resultId + ':1' },
    });
    await callbackQueryHandler!({
      ...pickCtxBase,
      callbackQuery: { ...pickCtxBase.callbackQuery, data: `inline_cmp_pick:${resultId}:4` },
    });

    // Start button should be available
    await vi.waitFor(() => {
      expect(pickCtxBase.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'cmp_inline_msg',
          rich_message: expect.objectContaining({
            markdown: expect.stringContaining('🚀 Start comparison'),
          }),
        }),
      );
    });
  });

  it('should mark /v as compare task with empty instruction', () => {
    const res = parseInlineModelAndPrompt('/v 这个方案如何', 'Gemini 3.6 Flash (Medium)');
    expect(res.task).toBe('compare');
    expect(res.prompt).toBe('这个方案如何');
  });

  it('should answer /v inline query with a single compare picker card', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v 对比一下方案' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const callArg = inlineCtx.answerInlineQuery.mock.calls[0][0];
    expect(callArg).toHaveLength(1);
    expect(callArg[0]).toMatchObject({
      id: expect.stringContaining('ai-'),
      title: expect.stringContaining('⚖️'),
    });
  });

  it('should parse multiple @family tags and filter candidates for /v @deepseek @pro', async () => {
    const res = parseInlineModelAndPrompt('/v @deepseek @pro 对比这两个族系', 'Gemini 3.6 Flash (Medium)');
    expect(res.task).toBe('compare');
    expect(res.families).toEqual(['deepseek', 'pro']);
    expect(res.prompt).toBe('对比这两个族系');
  });

  it('should filter candidate models when /v @family search is used', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v @deep 对比DeepSeek模型' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);

    const resultId = inlineCtx.answerInlineQuery.mock.calls[0][0][0].id;
    const mockChosenCtx = {
      from: { id: 12345 },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '/v @deep 对比DeepSeek模型',
        inline_message_id: 'cmp_deep_msg',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };
    await chosenInlineResultHandler!(mockChosenCtx);

    await vi.waitFor(() => {
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'cmp_deep_msg',
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: expect.stringContaining('inline_cmp_default:') }),
              ]),
            ]),
          }),
        }),
      );
    });
  });

  it('should render the compare picker when a compare card is chosen', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v 对比一下方案' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);
    const resultId = inlineCtx.answerInlineQuery.mock.calls[0][0][0].id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '/v 对比一下方案',
        inline_message_id: 'cmp_inline_msg',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };
    await chosenInlineResultHandler!(mockChosenCtx);

    await vi.waitFor(() => {
      expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          inline_message_id: 'cmp_inline_msg',
          rich_message: expect.objectContaining({
            markdown: expect.stringContaining('⚖️ Multi-model comparison'),
          }),
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: expect.stringContaining('inline_cmp_default:') }),
              ]),
            ]),
          }),
        }),
      );
    });
  });

  it('should run all selected models in parallel when compare starts', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);
    (runAgyPrint as any).mockClear();
    (runAgyPrint as any).mockResolvedValue({ output: '对比回答内容。' });

    const inlineCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '/v 对比一下方案' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };
    await inlineQueryHandler!(inlineCtx);
    const resultId = inlineCtx.answerInlineQuery.mock.calls[0][0][0].id;

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: resultId,
        from: { id: 12345 },
        query: '/v 对比一下方案',
        inline_message_id: 'cmp_inline_msg',
      },
      api: {
        editMessageTextInline: vi.fn().mockResolvedValue(true),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
        },
      },
    };
    await chosenInlineResultHandler!(mockChosenCtx);

    const pickCtxBase = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      api: {
        raw: { editMessageText: vi.fn().mockResolvedValue(true) },
      },
      callbackQuery: { inline_message_id: 'cmp_inline_msg', data: '' },
    };

    // First switch from page 0 cover mode to page 1 list mode
    await callbackQueryHandler!({ ...pickCtxBase, callbackQuery: { ...pickCtxBase.callbackQuery, data: `inline_cmp_page:${resultId}:1` } });

    // Grab the keyboard rows from the page 1 edit and click two model buttons.
    const page1Edit = pickCtxBase.api.raw.editMessageText.mock.calls[0][0];
    const buttons = page1Edit.reply_markup.inline_keyboard.flat() as Array<{ callback_data: string }>;
    const pickButtons = buttons.filter((b) => b.callback_data.startsWith('inline_cmp_pick:'));

    await callbackQueryHandler!({ ...pickCtxBase, callbackQuery: { ...pickCtxBase.callbackQuery, data: pickButtons[0].callback_data } });
    await callbackQueryHandler!({ ...pickCtxBase, callbackQuery: { ...pickCtxBase.callbackQuery, data: pickButtons[1].callback_data } });

    // Now click the start button that appeared.
    const startEdit = pickCtxBase.api.raw.editMessageText.mock.calls.slice(-1)[0][0];
    const startButtons = (startEdit.reply_markup.inline_keyboard.flat() as Array<{ callback_data: string }>).filter((b) => b.callback_data.startsWith('inline_cmp_start:'));
    expect(startButtons.length).toBe(1);

    await callbackQueryHandler!({ ...pickCtxBase, callbackQuery: { ...pickCtxBase.callbackQuery, data: startButtons[0].callback_data } });

    await vi.waitFor(() => {
      expect(runAgyPrint).toHaveBeenCalledTimes(2);
    });

    // Final flush includes pagination with regenerate button.
    await vi.waitFor(() => {
      expect(pickCtxBase.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          rich_message: expect.objectContaining({
            blocks: expect.any(Array),
          }),
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: expect.stringContaining('inline_page:') }),
              ]),
            ]),
          }),
        }),
      );
    });
  });
});
