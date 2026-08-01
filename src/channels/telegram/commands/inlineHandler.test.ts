/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerInlineHandler, parseInlineModelAndPrompt } from './inlineHandler.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

// Mock agyCli
vi.mock('../../../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn().mockImplementation(async (opts: any) => {
    if (opts?.onChunk) {
      opts.onChunk('这是关于量子计算的测试回答。');
    }
    return {
      output: '这是关于量子计算的测试回答。',
    };
  }),
}));

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

describe('parseInlineModelAndPrompt', () => {
  it('should parse model prefix correctly', () => {
    const res = parseInlineModelAndPrompt('/flash 什么是量子计算', 'Gemini 3.5 Flash (Medium)');
    expect(res.model).toBe('Gemini 3.6 Flash (High)');
    expect(res.prompt).toBe('什么是量子计算');
    expect(res.aliasUsed).toBe('/flash');
  });

  it('should parse @p:N and @pN project index and strip flag from prompt', () => {
    const mockProjects: any = [{ name: 'Project A', path: '/path/a' }, { name: 'Project B', path: '/path/b' }];
    const res1 = parseInlineModelAndPrompt('/pro @p:1 怎么重构代码', 'Gemini 3.5 Flash', mockProjects);
    expect(res1.model).toBe('Web2API: Gemini 3.1 Pro');
    expect(res1.prompt).toBe('怎么重构代码');
    expect(res1.projectUsed).toEqual(mockProjects[0]);

    const res2 = parseInlineModelAndPrompt('/pro @p2 怎么写算法', 'Gemini 3.5 Flash', mockProjects);
    expect(res2.model).toBe('Web2API: Gemini 3.1 Pro');
    expect(res2.prompt).toBe('怎么写算法');
    expect(res2.projectUsed).toEqual(mockProjects[1]);
  });

  it('should parse task prefixes and wrap prompt with instruction', () => {
    const res = parseInlineModelAndPrompt('/translate 你好世界', 'Gemini 3.5 Flash');
    expect(res.task).toBe('translate');
    expect(res.prompt).toContain('翻译成中文');
    expect(res.prompt).toContain('你好世界');
  });

  it('should parse combined model + task prefixes in any order', () => {
    const res1 = parseInlineModelAndPrompt('/flash /summarize 量子计算', 'Gemini 3.5 Flash');
    expect(res1.model).toBe('Gemini 3.6 Flash (High)');
    expect(res1.task).toBe('summarize');
    expect(res1.prompt).toContain('总结');
    expect(res1.prompt).toContain('量子计算');

    const res2 = parseInlineModelAndPrompt('/fix /pro 这个报错', 'Gemini 3.5 Flash');
    expect(res2.model).toBe('Web2API: Gemini 3.1 Pro');
    expect(res2.task).toBe('fix');
  });

  it('should mark /img as image task without wrapping prompt', () => {
    const res = parseInlineModelAndPrompt('/img 一只猫', 'Gemini 3.5 Flash');
    expect(res.task).toBe('image');
    expect(res.prompt).toBe('一只猫');
  });

  it('should keep unknown prefix in prompt', () => {
    const res = parseInlineModelAndPrompt('/unknown 什么情况', 'Gemini 3.5 Flash');
    expect(res.task).toBeUndefined();
    expect(res.prompt).toBe('/unknown 什么情况');
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
      getProjects: vi.fn().mockReturnValue([]),
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
          title: expect.stringContaining('未授权访问'),
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
      inlineQuery: { query: '/flash 什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await inlineQueryHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^ai-/),
          title: expect.stringContaining('点击发送并开始思考'),
          input_message_content: expect.objectContaining({
            rich_message: expect.objectContaining({
              markdown: expect.any(String),
            }),
          }),
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^prompt-/),
          title: expect.stringContaining('提问卡片'),
        }),
      ]),
      expect.objectContaining({ cache_time: 0 }),
    );
  });

  it('should edit placeholder with AI answer when inline result is chosen', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(mockChosenCtx.api.raw.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        inline_message_id: 'test_inline_msg_id_123',
        rich_message: expect.objectContaining({
          markdown: expect.any(String),
        }),
      }),
    );
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
    await new Promise((resolve) => setTimeout(resolve, 1500));

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
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(regenCtx.answerCallbackQuery).toHaveBeenCalled();
    expect(regenCtx.api.raw.editMessageText).toHaveBeenCalled();
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

  it('should render generated image in-place via editMessageMedia', async () => {
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
    expect(callArg.find((r: any) => r.id.startsWith('ai-')).title).toContain('点击生成图片');

    const mockChosenCtx = {
      me: { username: 'testbot' },
      chosenInlineResult: {
        result_id: aiResultId,
        from: { id: 12345 },
        query: '/img 一只猫',
        inline_message_id: 'test_inline_msg_id_123',
      },
      api: {
        sendPhoto: vi.fn().mockResolvedValue({
          photo: [
            { file_id: 'photo_small', file_size: 100 },
            { file_id: 'photo_large', file_size: 5000 },
          ],
        }),
        raw: {
          editMessageText: vi.fn().mockResolvedValue(true),
          editMessageMedia: vi.fn().mockResolvedValue(true),
        },
      },
    };

    await chosenInlineResultHandler!(mockChosenCtx);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(mockChosenCtx.api.sendPhoto).toHaveBeenCalled();
    expect(mockChosenCtx.api.raw.editMessageMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        inline_message_id: 'test_inline_msg_id_123',
        media: expect.objectContaining({
          type: 'photo',
          media: 'photo_large',
        }),
      }),
    );
  });
});
