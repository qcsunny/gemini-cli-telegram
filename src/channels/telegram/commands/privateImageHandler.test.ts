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
    expect(runModelWithFallbackChain).toHaveBeenCalledWith(
      expect.stringContaining('generate_image'),
      expect.stringContaining('Gemini'),
      expect.anything(),
      undefined,
      expect.anything(),
    );
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

  it('should embed every generated image in a single rich message', async () => {
    vi.mocked(runModelWithFallbackChain).mockResolvedValue({
      result: { output: '生成完成', conversationId: 'conv-multi', exitCode: 0, durationMs: 5000 },
      modelUsed: 'Gemini 3.5 Flash',
      isFallback: false,
    });
    vi.mocked(findNewImageArtifacts).mockResolvedValue([
      '/tmp/agy-data/brain/conv-multi/img_1.png',
      '/tmp/agy-data/brain/conv-multi/img_2.png',
      '/tmp/agy-data/brain/conv-multi/img_3.png',
    ]);

    const ctx = {
      message: { text: '/img 三张美女图' },
      chat: { id: 1 },
      reply: vi.fn().mockResolvedValue(true),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
    } as unknown as Context;

    const handled = await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    expect(handled).toBe(true);
    const args = vi.mocked(ctx.api.sendRichMessage).mock.calls[0][1] as {
      markdown: string;
      media: Array<{ id: string; media: { type: string; media: unknown } }>;
    };
    expect(args.markdown.match(/tg:\/\/photo\?id=/g)?.length).toBe(3);
    expect(args.media).toHaveLength(3);
    expect(args.media.map((m) => m.id)).toEqual(['c0_0', 'c0_1', 'c0_2']);
    expect(args.markdown).toContain('共 3 张');
  });

  it('should split more than 10 images into multiple collages in one message', async () => {
    vi.mocked(runModelWithFallbackChain).mockResolvedValue({
      result: { output: '生成完成', conversationId: 'conv-many', exitCode: 0, durationMs: 5000 },
      modelUsed: 'Gemini 3.5 Flash',
      isFallback: false,
    });
    const paths = Array.from({ length: 25 }, (_, i) => `/tmp/agy-data/brain/conv-many/img_${i + 1}.png`);
    vi.mocked(findNewImageArtifacts).mockResolvedValue(paths);

    const ctx = {
      message: { text: '/img 很多图' },
      chat: { id: 1 },
      reply: vi.fn().mockResolvedValue(true),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
    } as unknown as Context;

    await handlePrivateImageRequest(ctx, mockSessionManager as SessionManager, defaultOptions);
    const args = vi.mocked(ctx.api.sendRichMessage).mock.calls[0][1] as {
      markdown: string;
      media: Array<{ id: string; media: { type: string; media: unknown } }>;
    };
    expect(args.markdown.match(/<tg-collage>/g)?.length).toBe(3);
    expect(args.media).toHaveLength(25);
    expect(args.media[0].id).toBe('c0_0');
    expect(args.media[10].id).toBe('c1_0');
    expect(args.media[20].id).toBe('c2_0');
    expect(args.markdown).toContain('共 25 张');
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
