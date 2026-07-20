/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot, buildChannelReply, clearDraftIds } from './bot.js';
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
      clearDraftIds();
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

    it('should successfully send Rich blocks (Option A) and clear draft ID', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('**bold** text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledWith({
        chat_id: chatId,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[0][0].rich_message;
      expect(parsed).toHaveProperty('blocks');
      expect(msgId).toBe(888);
    });

    it('should pass message_thread_id if available in the context', async () => {
      mockCtx.message = { message_thread_id: 42 };
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');

      await reply.sendRich!('Hello Forum!');
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: chatId,
        message_thread_id: 42,
        rich_message: { blocks: expect.any(Array) }
      }));

      await reply.sendRichDraft!('Hello Draft!');
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: chatId,
        message_thread_id: 42,
        rich_message: { blocks: expect.any(Array) }
      }));
    });

    it('should fallback to Option B (HTML) if Option A (blocks) throws', async () => {
      // Option A throws error
      mockCtx.api.raw.sendRichMessage.mockRejectedValueOnce(new Error('blocks not supported'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('some text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenLastCalledWith({
        chat_id: chatId,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[1][0].rich_message;
      expect(parsed).toHaveProperty('html');
      expect(msgId).toBe(888);
    });

    it('should fallback to Option C (Markdown) if Option A and B throw', async () => {
      // Option A throws, then Option B throws
      mockCtx.api.raw.sendRichMessage
        .mockRejectedValueOnce(new Error('blocks fail'))
        .mockRejectedValueOnce(new Error('HTML fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('some text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(3);
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[2][0].rich_message;
      expect(parsed).toHaveProperty('markdown');
      expect(msgId).toBe(888);
    });

    it('should fallback to Option D (plain HTML) if A/B/C all throw', async () => {
      mockCtx.api.raw.sendRichMessage
        .mockRejectedValueOnce(new Error('blocks fail'))
        .mockRejectedValueOnce(new Error('HTML fail'))
        .mockRejectedValueOnce(new Error('Markdown fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('**bold** text');

      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('<b>bold</b>'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
      expect(msgId).toBe(999);
    });

    it('should generate and reuse draft ID across sendRichDraft calls', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');

      const firstDraftId = await reply.sendRichDraft!('draft text 1');
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledWith({
        chat_id: chatId,
        draft_id: firstDraftId,
        rich_message: expect.any(Object),
      });
      let parsed = mockCtx.api.raw.sendRichMessageDraft.mock.calls[0][0].rich_message;
      expect(parsed).toHaveProperty('blocks');

      const secondDraftId = await reply.sendRichDraft!('draft text 2');
      expect(secondDraftId).toBe(firstDraftId);
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenLastCalledWith({
        chat_id: chatId,
        draft_id: firstDraftId,
        rich_message: expect.any(Object),
      });
      parsed = mockCtx.api.raw.sendRichMessageDraft.mock.calls[1][0].rich_message;
      expect(parsed).toHaveProperty('blocks');
    });

    it('should fallback to Option B (HTML) in sendRichDraft if Option A (blocks) throws', async () => {
      mockCtx.api.raw.sendRichMessageDraft.mockRejectedValueOnce(new Error('blocks draft fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const draftId = await reply.sendRichDraft!('draft text');

      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenLastCalledWith({
        chat_id: chatId,
        draft_id: draftId,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.sendRichMessageDraft.mock.calls[1][0].rich_message;
      expect(parsed).toHaveProperty('html');
    });

    it('should successfully edit Rich blocks (Option A)', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.raw.editMessageText).toHaveBeenCalledWith({
        chat_id: chatId,
        message_id: 100,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.editMessageText.mock.calls[0][0].rich_message;
      expect(parsed).toHaveProperty('blocks');
    });

    it('should promote ephemeral draft preview to a real message when finalization is reached via editRich', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');

      // Simulate draft is active (this sets a draft ID in draftIds map for the chatId)
      const draftId = await reply.sendRichDraft!('some draft');
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(1);

      // Now call editRich (simulating finalization edit)
      const finalizedId = await reply.editRich!(draftId, 'final text');

      // A streamed draft is an ephemeral preview that is NOT persisted by Telegram.
      // Finalization MUST materialize it into a real message via sendRichMessage
      // (not another sendRichMessageDraft, which would just refresh the preview and
      // leave the first message swallowed).
      expect(mockCtx.api.raw.editMessageText).not.toHaveBeenCalled();
      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalledTimes(1);
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chat_id: chatId,
          rich_message: expect.objectContaining({
            blocks: expect.any(Array),
          }),
        })
      );
      // The real persisted message id is returned so callers can track it.
      expect(finalizedId).toBe(888);
    });

    it('should fallback to edit Option B (HTML) if Option A (blocks) throws', async () => {
      mockCtx.api.raw.editMessageText.mockRejectedValueOnce(new Error('blocks edit fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.raw.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.editMessageText).toHaveBeenLastCalledWith({
        chat_id: chatId,
        message_id: 100,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.editMessageText.mock.calls[1][0].rich_message;
      expect(parsed).toHaveProperty('html');
    });

    it('should fallback to edit Option D (safeEdit HTML) if Option A/B/C all throw', async () => {
      mockCtx.api.raw.editMessageText
        .mockRejectedValueOnce(new Error('blocks edit fail'))
        .mockRejectedValueOnce(new Error('HTML edit fail'))
        .mockRejectedValueOnce(new Error('Markdown edit fail'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editRich!(100, '**bold** text');

      expect(mockCtx.api.editMessageText).toHaveBeenCalledWith(
        chatId,
        100,
        expect.stringContaining('<b>bold</b>'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
    });

    it('should redirect sendPlain to sendRichDraft when parseMode is RichText', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const draftId = await reply.sendPlain('streaming text');

      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalled();
      expect(draftId).toBeDefined();
    });

    it('should redirect editPlain to sendRichDraft when parseMode is RichText', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.editPlain(100, 'streaming update');

      expect(mockCtx.api.raw.sendRichMessageDraft).toHaveBeenCalled();
    });

    it('should trigger circuit breaker and fall back to plain editing if sendRichDraft fails twice', async () => {
      mockCtx.api.raw.sendRichMessageDraft.mockRejectedValue(new Error('Draft rate limit'));
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      
      // Attempt sending drafts, which fail
      await reply.sendPlain('stream chunk 1');
      await reply.editPlain(100, 'stream chunk 2');

      // Verify it handles failures gracefully and does not throw to the caller
      expect(mockCtx.reply).toHaveBeenCalled();
      
      // Verify subsequent calls directly bypass sendRichMessageDraft (it won't be called more times after threshold is hit)
      mockCtx.api.raw.sendRichMessageDraft.mockClear();
      await reply.sendPlain('stream chunk 3');
      expect(mockCtx.api.raw.sendRichMessageDraft).not.toHaveBeenCalled();
    });
  });
});
