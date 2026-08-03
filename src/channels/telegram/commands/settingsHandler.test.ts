/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerSettingsHandler } from './settingsHandler.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

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
