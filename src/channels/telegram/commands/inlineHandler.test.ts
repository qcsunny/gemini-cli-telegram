/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerInlineHandler } from './inlineHandler.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

// Mock agyCli
vi.mock('../../../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn().mockResolvedValue({
    output: '这是关于量子计算的测试回答。',
  }),
}));

describe('registerInlineHandler', () => {
  let mockBot: any;
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;
  let registeredHandler: ((ctx: any) => Promise<void>) | null = null;

  beforeEach(() => {
    registeredHandler = null;
    mockBot = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'inline_query') {
          registeredHandler = handler;
        }
      }),
    };

    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
    };

    defaultOptions = {
      model: 'Gemini 3.6 Flash (Medium)',
      cwd: '/test/dir',
    };
  });

  it('should register inline_query event listener on bot', () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);
    expect(mockBot.on).toHaveBeenCalledWith('inline_query', expect.any(Function));
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

    await registeredHandler!(mockCtx);

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

  it('should return help card when query is empty', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '   ' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await registeredHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'help',
          title: expect.stringContaining('Gemini/AI 模型'),
        }),
      ]),
      expect.objectContaining({ cache_time: 5 }),
    );
  });

  it('should generate AI answer card for valid query', async () => {
    registerInlineHandler(mockBot as unknown as Bot, mockSessionManager as unknown as SessionManager, defaultOptions);

    const mockCtx = {
      from: { id: 12345 },
      inlineQuery: { query: '什么是量子计算？' },
      answerInlineQuery: vi.fn().mockResolvedValue(true),
    };

    await registeredHandler!(mockCtx);

    expect(mockCtx.answerInlineQuery).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^ai-/),
          title: expect.stringContaining('什么是量子计算'),
          input_message_content: expect.objectContaining({
            message_text: expect.stringContaining('这是关于量子计算的测试回答。'),
          }),
        }),
      ]),
      expect.objectContaining({ cache_time: 2 }),
    );
  });
});
