/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerCallbackRouter } from './callbackRouter.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

// Mock out heavy deps pulled in by callbackRouter imports.
vi.mock('../../../agy/agyCli.js', () => ({
  getAvailableModels: vi.fn().mockResolvedValue(['Gemini 3.6 Flash (High)']),
  runAgyPrint: vi.fn(),
}));
vi.mock('../../../config/userConfig.js', () => ({
  getBrowseRoot: vi.fn().mockReturnValue('/tmp/browse'),
  getAnswerSaveDir: vi.fn().mockReturnValue('/tmp/inbox'),
  loadUserConfig: vi.fn().mockReturnValue({}),
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
