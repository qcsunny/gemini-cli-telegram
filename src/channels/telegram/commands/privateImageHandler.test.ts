/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import { isPrivateImageRequest, handlePrivateImageRequest } from './privateImageHandler.js';
import { runModelWithFallbackChain, findNewImageArtifacts } from './inlineHandler.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

vi.mock('../../../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue(['generated-image.png', '.system_generated']),
  stat: vi.fn().mockResolvedValue({ isFile: () => true, mtimeMs: Date.now() }),
}));

vi.mock('../../../config/userConfig.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../config/userConfig.js')>();
  return { ...mod, getAgyDataDir: vi.fn().mockReturnValue('/tmp/agy-data') };
});

vi.mock('./inlineHandler.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./inlineHandler.js')>();
  return {
    ...mod,
    runModelWithFallbackChain: vi.fn(),
    findNewImageArtifacts: vi.fn(),
    parseInlineModelAndPrompt: mod.parseInlineModelAndPrompt,
  };
});

describe('privateImageHandler', () => {
  let mockSessionManager: any;
  let defaultOptions: SessionOptions;

  beforeEach(() => {
    mockSessionManager = {
      getSession: vi.fn().mockReturnValue(null),
      getProjects: vi.fn().mockReturnValue([]),
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
      message: { text: '普通消息' },
      chat: { id: 1 },
    } as unknown as Context;
    const handled = await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    expect(handled).toBe(false);
  });

  it('should ask for a prompt when /img has no content', async () => {
    const ctx = {
      message: { text: '/img' },
      chat: { id: 1 },
      reply: vi.fn().mockResolvedValue(true),
    } as unknown as Context;
    const handled = await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('should generate and send the image as a rich message', async () => {
    vi.mocked(runModelWithFallbackChain).mockResolvedValue({
      result: { output: '生成完成', conversationId: 'conv-img-1', exitCode: 0, durationMs: 5000 },
      modelUsed: 'Gemini 3.5 Flash',
      isFallback: false,
    });
    vi.mocked(findNewImageArtifacts).mockResolvedValue(['/tmp/agy-data/brain/conv-img-1/img_1.png']);

    const ctx = {
      message: { text: '/img 一只猫' },
      chat: { id: 1 },
      reply: vi.fn().mockResolvedValue(true),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
    } as unknown as Context;

    const handled = await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    expect(handled).toBe(true);
    expect(runModelWithFallbackChain).toHaveBeenCalled();
    expect(ctx.api.sendRichMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        markdown: expect.stringContaining('tg://photo?id='),
        media: expect.arrayContaining([
          expect.objectContaining({
            media: expect.objectContaining({ type: 'photo' }),
          }),
        ]),
      }),
    );
  });

  it('should report when no image artifact was produced', async () => {
    vi.mocked(runModelWithFallbackChain).mockResolvedValue({
      result: { output: '无图', conversationId: 'conv-empty', exitCode: 0, durationMs: 1000 },
      modelUsed: 'Gemini 3.5 Flash',
      isFallback: false,
    });
    vi.mocked(findNewImageArtifacts).mockResolvedValue([]);

    const ctx = {
      message: { text: '/img 一只猫' },
      chat: { id: 1 },
      reply: vi.fn().mockResolvedValue(true),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: { sendRichMessage: vi.fn().mockResolvedValue(true) },
    } as unknown as Context;

    const handled = await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('未发现图片文件'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(ctx.api.sendRichMessage).not.toHaveBeenCalled();
  });
});
