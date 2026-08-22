/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file bot.test.ts
 * @description Unit tests for the Telegram bot wiring: middleware, sequentialization, media handling, and rate-limit helpers.
 */




import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot, buildChannelReply, record429Backoff, reset429Backoff, is429Error, get429RetryAfter } from './bot.js';
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
      const mockRaw = {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 888 }),
        sendRichMessageDraft: vi.fn().mockResolvedValue({}),
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      mockCtx = {
        reply: vi.fn().mockResolvedValue({ message_id: 999 }),
        replyWithDocument: vi.fn().mockResolvedValue(undefined),
        api: {
          deleteMessage: vi.fn().mockResolvedValue(true),
          editMessageText: vi.fn().mockImplementation((chatId, messageId, textOrRichMessage, other) => {
            return mockRaw.editMessageText({
              chat_id: chatId,
              message_id: messageId,
              ...(typeof textOrRichMessage === 'string'
                ? { text: textOrRichMessage }
                : { rich_message: textOrRichMessage }),
              ...(other || {}),
            });
          }),
          sendRichMessage: vi.fn().mockImplementation((chatId, richMessage, other) => {
            return mockRaw.sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...(other || {}),
            });
          }),
          sendRichMessageDraft: vi.fn().mockImplementation((chatId, draftId, richMessage, other) => {
            return mockRaw.sendRichMessageDraft({
              chat_id: chatId,
              draft_id: draftId,
              rich_message: richMessage,
              ...(other || {}),
            });
          }),
          raw: mockRaw,
        },
      };
    });

    it('should successfully send Rich Blocks (Option A) and clear draft ID', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('**bold** text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: chatId,
        rich_message: expect.any(Object),
      }));
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
      // Streaming draft is sent as native blocks (fast typewriter path); the
      // lightweight per-frame builder is used, not the finalize pipeline.
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        chat_id: chatId,
        message_thread_id: 42,
        rich_message: { blocks: expect.any(Array) }
      }));
    });

    it('should fallback to Option B (HTML) if Option A (blocks) throws', async () => {
      // Option A (blocks) throws error
      mockCtx.api.raw.sendRichMessage.mockRejectedValueOnce(new Error('blocks not supported'));

      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const msgId = await reply.sendRich!('some text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        chat_id: chatId,
        rich_message: expect.any(Object),
      }));
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

    it('should send a REAL persisted message via sendRichDraft and return its message id', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      const firstId = await reply.sendRichDraft!('draft text 1');

      // sendRichDraft must use sendRichMessage (a real persisted message), NOT the
      // ephemeral sendRichMessageDraft preview, so the user sees the streamed bubble.
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledWith({
        chat_id: chatId,
        rich_message: expect.any(Object),
      });
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[0][0].rich_message;
      // Streaming phase sends native blocks for a smooth typewriter effect.
      expect(parsed).toHaveProperty('blocks');
      // The returned id is the real message id from Telegram.
      expect(firstId).toBe(888);
    });

    it('should send streaming draft as native blocks (no heavy finalize parse)', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.sendRichDraft!('draft text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[0][0].rich_message;
      expect(parsed).toHaveProperty('blocks');
      expect(parsed).not.toHaveProperty('markdown');
    });

    it('should never send an empty blocks payload during streaming (RICH_MESSAGE_EMPTY guard)', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText');
      await reply.sendRichDraft!({ content: '', thought: '' });

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
      const parsed = mockCtx.api.raw.sendRichMessage.mock.calls[0][0].rich_message;
      expect(parsed).toHaveProperty('blocks');
      const blocks = parsed.blocks as unknown[];
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('should send native blocks via editRichDraft streaming edits', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText', undefined, undefined, { draftThrottleMs: 0 });
      await reply.editRichDraft!(100, { content: 'body', thought: 'thinking' });
      const parsed = mockCtx.api.editMessageText.mock.calls[0][2];
      expect(parsed).toHaveProperty('blocks');
      expect(parsed.blocks.length).toBeGreaterThan(0);
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
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(1);

      // Now call editRich (simulating finalization edit)
      const finalizedId = await reply.editRich!(draftId, 'final text');

      // sendRichDraft creates a REAL persisted message (sendRichMessage), and the
      // draft is tracked in draftIds/activeDraftIds. Finalization must EDIT that
      // same real message in place via editMessageText (no duplicate send, no
      // ephemeral sendRichMessageDraft).
      expect(mockCtx.api.raw.sendRichMessageDraft).not.toHaveBeenCalled();
      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
      expect(mockCtx.api.raw.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: chatId,
          message_id: draftId,
          rich_message: expect.objectContaining({
            blocks: expect.any(Array),
          }),
        })
      );
      // editRich edits in place and returns void (no new message id).
      expect(finalizedId).toBeUndefined();
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
      const reply = buildChannelReply(mockCtx, chatId, 'RichText', undefined, undefined, { draftThrottleMs: 0 });
      const draftId = await reply.sendPlain('streaming text');

      expect(mockCtx.api.raw.sendRichMessage).toHaveBeenCalled();
      expect(draftId).toBeDefined();
    });

    it('should redirect editPlain to editMessageText or sendRichDraft when parseMode is RichText', async () => {
      const reply = buildChannelReply(mockCtx, chatId, 'RichText', undefined, undefined, { draftThrottleMs: 0 });
      await reply.editPlain(100, 'streaming update');

      const calledEdit = mockCtx.api.editMessageText.mock.calls.length > 0 || mockCtx.api.raw.sendRichMessageDraft.mock.calls.length > 0;
      expect(calledEdit).toBe(true);
    });

    it('should trigger circuit breaker and fall back to plain editing if sendRichDraft fails twice', async () => {
      mockCtx.api.raw.sendRichMessage.mockRejectedValue(new Error('Draft rate limit'));
      mockCtx.api.editMessageText.mockRejectedValue(new Error('Edit rate limit'));
      const reply = buildChannelReply(mockCtx, chatId, 'RichText', undefined, undefined, { draftThrottleMs: 0 });
      
      // Attempt sending drafts, which fail
      await reply.sendPlain('stream chunk 1');
      await reply.editPlain(100, 'stream chunk 2');

      // Verify it handles failures gracefully and does not throw to the caller
      expect(mockCtx.reply).toHaveBeenCalled();
      
      // Verify subsequent calls directly bypass sendRichMessage (it won't be called more times after threshold is hit)
      mockCtx.api.raw.sendRichMessage.mockClear();
      await reply.sendPlain('stream chunk 3');
      expect(mockCtx.api.raw.sendRichMessage).not.toHaveBeenCalled();
    });

    it('should detect 429 error and extract retry_after', () => {
      const err1 = { error_code: 429, parameters: { retry_after: 5 } };
      expect(is429Error(err1)).toBe(true);
      expect(get429RetryAfter(err1)).toBe(5);

      const err2 = new Error('Too Many Requests: retry after 3');
      expect(is429Error(err2)).toBe(true);
      expect(get429RetryAfter(err2)).toBeUndefined();
    });

    it('should record 429 backoff and handle reset', () => {
      expect(() => record429Backoff(12345, 2)).not.toThrow();
      expect(() => reset429Backoff(12345)).not.toThrow();
    });
  });
});

describe('getStreamingMarkdown', () => {
  it('streams the actual thinking text typewriter-style while only thinking (Phase 1)', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    const md = getStreamingMarkdown({ content: '', thought: 'let me think\nstep two' });
    expect(md).toContain('**🧠 Thinking...**');
    expect(md).toContain('let me think\nstep two');
    expect(md).not.toContain('<details>');
  });

  it('folds the thinking into a collapsed details block and streams the body (Phase 2)', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    const md = getStreamingMarkdown({ content: 'the answer', thought: 'reasoning here' });
    expect(md).toContain('<details><summary>🧠 Thinking Process</summary>');
    expect(md).toContain('reasoning here');
    expect(md).toContain('</details>');
    expect(md).toMatch(/the answer$/u);
  });

  it('strips literal thought tags from both thought and body', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    const md = getStreamingMarkdown({ content: 'body <thinking>x</thinking>', thought: '<thought>t</thought>\nreal' });
    expect(md).not.toContain('<thinking>');
    expect(md).not.toContain('<thought>');
    // Paired <thinking> blocks are removed entirely (parity with
    // think/thought): no tag or inner reasoning text leaks into the output.
    expect(md).toContain('body');
    expect(md).toContain('real');
    expect(md).not.toContain('x');
  });

  it('returns the body as-is when there is no thought', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    expect(getStreamingMarkdown({ content: 'plain answer', thought: '' })).toBe('plain answer');
  });

  it('returns a placeholder when both are empty', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    expect(getStreamingMarkdown({ content: '', thought: '' })).toBe('🧠 Thinking...');
  });

  it('handles plain-string input', async () => {
    const { getStreamingMarkdown } = await import('./bot/channelReply.js');
    expect(getStreamingMarkdown('hello')).toBe('hello');
  });
});

describe('buildPrivateStreamingBlocks', () => {
  it('builds Phase 1 streaming blocks (thought only) with a bold thinking header', async () => {
    const { buildPrivateStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildPrivateStreamingBlocks({ content: '', thought: 'Step 1 reasoning' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('🧠 Thinking...');
    expect(json).toContain('Step 1 reasoning');
  });

  it('builds Phase 2 streaming blocks with a native details block for thinking', async () => {
    const { buildPrivateStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildPrivateStreamingBlocks({ content: 'Body answer.', thought: 'Done thinking.' });
    expect(blocks.some((b) => b.type === 'details' && b.summary === '🧠 Thinking Process')).toBe(true);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Done thinking.');
    expect(json).toContain('Body answer.');
  });

  it('never emits empty streaming blocks (RICH_MESSAGE_EMPTY guard)', async () => {
    const { buildPrivateStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildPrivateStreamingBlocks({ content: '', thought: '' });
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('streams body-only content without a thinking header', async () => {
    const { buildPrivateStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildPrivateStreamingBlocks({ content: 'Just the answer', thought: '' });
    expect(JSON.stringify(blocks)).toContain('Just the answer');
    expect(JSON.stringify(blocks)).not.toContain('Thinking');
  });
});

describe('buildDraftStreamingBlocks', () => {
  it('streams the reasoning inside the native thinking pill (thought only, no content)', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildDraftStreamingBlocks({ content: '', thought: 'Step 1 reasoning' });
    expect(blocks).toEqual([{ type: 'thinking', text: '🧠 Step 1 reasoning' }]);
  });

  it('trims a long reasoning chain to its tail inside the pill', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const thought = `${'a'.repeat(4000)}NEWEST`;
    const blocks = buildDraftStreamingBlocks({ content: '', thought });
    const pill = blocks[0] as { type: string; text: string };
    expect(pill.type).toBe('thinking');
    expect(pill.text.endsWith('NEWEST')).toBe(true);
    expect(pill.text.startsWith('🧠 …')).toBe(true);
    expect(pill.text.length).toBeLessThan(thought.length);
  });

  it('starts the pill before the first thought arrives, so only its text grows', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildDraftStreamingBlocks({ content: '', thought: '' });
    expect(blocks).toEqual([{ type: 'thinking', text: '🧠 Thinking...' }]);
  });

  it('keeps a plain placeholder paragraph for the split layout', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildDraftStreamingBlocks({ content: '', thought: '' }, { pillOnly: false });
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('🧠 Thinking...');
  });

  it('falls through to the shared builder once the body starts (phase 2)', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildDraftStreamingBlocks({ content: 'Body answer.', thought: 'Done thinking.' });
    expect(blocks.some((b) => b.type === 'details' && b.summary === '🧠 Thinking Process')).toBe(true);
    expect(JSON.stringify(blocks)).toContain('Body answer.');
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
  });

  it('handles plain-string input like buildPrivateStreamingBlocks', async () => {
    const { buildDraftStreamingBlocks } = await import('./bot/channelReply.js');
    const blocks = buildDraftStreamingBlocks('plain string');
    expect(JSON.stringify(blocks)).toContain('plain string');
  });
});
