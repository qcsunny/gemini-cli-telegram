/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot, buildChannelReply } from './bot.js';
import { processMessage } from '../../core/messageLoop.js';
import * as fs from 'fs/promises';

const mockBot = {
  use: vi.fn(),
  on: vi.fn(),
  command: vi.fn(),
  api: {
    setMyCommands: vi.fn().mockResolvedValue(true),
    getFile: vi.fn().mockResolvedValue({ file_path: 'fake/path.jpg' }),
  },
  catch: vi.fn(),
};

vi.mock('grammy', () => {
  return {
    Bot: vi.fn(() => mockBot),
  };
});

vi.mock('@grammyjs/runner', () => ({
  run: vi.fn(),
  sequentialize: vi.fn(),
}));

vi.mock('../../core/messageLoop.js');
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/logger.js');
vi.mock('undici', () => ({
  ProxyAgent: vi.fn(),
  fetch: vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8))
  }),
}));

describe('TelegramBot', () => {
  let botInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token';
    botInstance = new TelegramBot('fake-token');
  });

  it('should register handlers for message and callback_query:data', () => {
    const registeredEvents = mockBot.on.mock.calls.map((call: any) => call[0]);
    expect(registeredEvents).toContain('message:text');
    expect(registeredEvents).toContain('message:photo');
    expect(registeredEvents).toContain('message:voice');
    expect(registeredEvents).toContain('callback_query:data');
  });

  it('should handle photo messages through the main message handler', async () => {
    const messageHandlerCall = mockBot.on.mock.calls.find((call: any) => call[0] === 'message:photo');
    expect(messageHandlerCall).toBeDefined();
    const messageHandler = messageHandlerCall![1];
    
    const mockCtx = {
      chat: { id: 123 },
      message: { 
        photo: [{ file_id: 'photo-id-1' }, { file_id: 'photo-id-2' }],
        caption: 'look at this'
      },
      reply: vi.fn().mockResolvedValue({ message_id: 456 }),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: mockBot.api,
      session: { 
        busy: false,
        abortController: new AbortController(),
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8))
    });

    vi.spyOn(botInstance.sessionManager, 'getOrCreate').mockResolvedValue(mockCtx.session);

    await messageHandler(mockCtx);

    expect(mockBot.api.getFile).toHaveBeenCalledWith('photo-id-2');
    expect(fs.writeFile).toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledWith(
      mockCtx.session,
      expect.objectContaining({
        text: 'look at this',
        media: [expect.objectContaining({ type: 'photo' })]
      }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('should handle voice messages through the main message handler', async () => {
    const messageHandlerCall = mockBot.on.mock.calls.find((call: any) => call[0] === 'message:voice');
    expect(messageHandlerCall).toBeDefined();
    const messageHandler = messageHandlerCall![1];
    
    const mockCtx = {
      chat: { id: 123 },
      message: { 
        voice: { file_id: 'voice-id', mime_type: 'audio/ogg' },
      },
      reply: vi.fn().mockResolvedValue({ message_id: 456 }),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      api: mockBot.api,
      session: { 
        busy: false,
        abortController: new AbortController(),
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8))
    });

    vi.spyOn(botInstance.sessionManager, 'getOrCreate').mockResolvedValue(mockCtx.session);

    await messageHandler(mockCtx);

    expect(mockBot.api.getFile).toHaveBeenCalledWith('voice-id');
    expect(processMessage).toHaveBeenCalledWith(
      mockCtx.session,
      expect.objectContaining({
        media: [expect.objectContaining({ type: 'voice', mimeType: 'audio/ogg' })]
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  describe('buildChannelReply Rich Messages & Fallbacks', () => {
    let mockCtx: any;
    const chatId = 12345;

    beforeEach(() => {
      mockCtx = {
        reply: vi.fn().mockResolvedValue({ message_id: 999 }),
        replyWithDocument: vi.fn().mockResolvedValue(undefined),
        api: {
          deleteMessage: vi.fn().mockResolvedValue(true),
          editMessageText: vi.fn().mockResolvedValue(true),
          raw: {
            sendRichMessage: vi.fn().mockResolvedValue({ message_id: 888 }),
            sendRichMessageDraft: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue(true),
          },
        },
      };
    });

    it('should successfully send Rich Blocks (Option A) and clear draft ID', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('**bold** text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledWith({
        chat_id: chatId,
        blocks: expect.any(Array),
      });
      expect(msgId).toBe(888);
    });

    it('should fallback to Option B (Markdown) if Option A (Blocks) throws', async () => {
      // Option A throws error
      mockCtx.api.raw.sendRichMessage.mockRejectedValueOnce(new Error('Blocks not supported'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('some text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenLastCalledWith({
        chat_id: chatId,
        markdown: expect.any(String),
      });
      expect(msgId).toBe(888);
    });

    it('should fallback to Option C (HTML) if both Option A and Option B throw', async () => {
      // Option A throws, then Option B throws
      mockCtx.api.raw.sendRichMessage
        .mockRejectedValueOnce(new Error('Blocks fail'))
        .mockRejectedValueOnce(new Error('Markdown fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('**bold** text');

      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('<b>bold</b>'),
        { parse_mode: 'HTML' }
      );
      expect(msgId).toBe(999);
    });

    it('should generate and reuse draft ID across sendRichDraft calls', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      
      const firstDraftId = await reply.sendRichDraft!('draft text 1');
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledWith({
        chat_id: chatId,
        draft_id: firstDraftId,
        blocks: expect.any(Array),
      });

      const secondDraftId = await reply.sendRichDraft!('draft text 2');
      expect(secondDraftId).toBe(firstDraftId);
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenLastCalledWith({
        chat_id: chatId,
        draft_id: firstDraftId,
        blocks: expect.any(Array),
      });
    });

    it('should fallback to Option B in sendRichDraft if Option A throws', async () => {
      mockCtx.api.raw.sendRichMessageDraft.mockRejectedValueOnce(new Error('Blocks draft fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const draftId = await reply.sendRichDraft!('draft text');

      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenLastCalledWith({
        chat_id: chatId,
        draft_id: draftId,
        markdown: expect.any(String),
      });
    });

    it('should successfully edit Rich Blocks (Option A)', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.raw.editMessageText).toHaveBeenCalledWith({
        chat_id: chatId,
        message_id: 100,
        blocks: expect.any(Array),
      });
    });

    it('should fallback to edit Option B (Markdown) if Option A throws', async () => {
      mockCtx.api.raw.editMessageText.mockRejectedValueOnce(new Error('Blocks edit fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.raw.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.editMessageText).toHaveBeenLastCalledWith({
        chat_id: chatId,
        message_id: 100,
        markdown: expect.any(String),
      });
    });

    it('should fallback to edit Option C (HTML) if Option A and Option B throw', async () => {
      mockCtx.api.raw.editMessageText
        .mockRejectedValueOnce(new Error('Blocks edit fail'))
        .mockRejectedValueOnce(new Error('Markdown edit fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.editMessageText).toHaveBeenCalledWith(
        chatId,
        100,
        expect.stringContaining('<b>bold</b>'),
        { parse_mode: 'HTML' }
      );
    });
  });
});
