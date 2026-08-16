// @vitest-environment node
/**
 * @file channelReply.test.ts
 * @description Unit tests for the streaming draft renderer (getStreamingMarkdown),
 * which controls the typewriter UX during model replies:
 *  - Phase 1: thinking text streams verbatim under a "🧠 Thinking..." header
 *  - Phase 2: when body content arrives, thinking folds into a collapsed
 *    <details> block ("🧠 Thinking Process") and the body streams below
 *  - Body-only / empty replies still fall back to the body or placeholder
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import { getStreamingMarkdown, buildPrivateStreamingBlocks, buildDraftStreamingBlocks, buildChannelReply } from './channelReply.js';

// The draft-mode branch reads getTuningConfig().useRichDraftPrivate at
// buildChannelReply time — mock it so tests can flip the flag. (messageCache
// also reads cacheTtlMs/cacheMaxSize from this mock at module init.)
const { mockGetTuningConfig } = vi.hoisted(() => ({
  mockGetTuningConfig: vi.fn().mockReturnValue({ useRichDraftPrivate: true, cacheTtlMs: 1000, cacheMaxSize: 10 }),
}));
vi.mock('../../../config/userConfig.js', () => ({
  getTuningConfig: (...args: unknown[]) => mockGetTuningConfig(...args),
}));

function makeCtx(chatType = 'private'): { ctx: Context; api: Record<string, ReturnType<typeof vi.fn>> } {
  const api = {
    sendRichMessageDraft: vi.fn().mockResolvedValue(true),
    sendRichMessage: vi.fn().mockResolvedValue({ message_id: 9001 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    setMessageReaction: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  const ctx = {
    api,
    chat: { type: chatType, id: 12345 },
    message: { message_thread_id: undefined },
    update: { message: { message_thread_id: undefined } },
    reply: vi.fn().mockResolvedValue({ message_id: 8001 }),
    replyWithDocument: vi.fn().mockResolvedValue({}),
  } as unknown as Context;
  return { ctx, api };
}

describe('getStreamingMarkdown', () => {
  it('streams the actual thinking text typewriter-style while only thinking (Phase 1)', () => {
    const md = getStreamingMarkdown({ content: '', thought: 'let me think\nstep two' });
    expect(md).toContain('**🧠 Thinking...**');
    expect(md).toContain('let me think\nstep two');
    expect(md).not.toContain('<details>');
  });

  it('folds the thinking into a collapsed details block and streams the body (Phase 2)', () => {
    const md = getStreamingMarkdown({ content: 'the answer', thought: 'reasoning here' });
    expect(md).toContain('<details><summary>🧠 Thinking Process</summary>');
    expect(md).toContain('reasoning here');
    expect(md).toContain('</details>');
    expect(md).toMatch(/the answer$/u);
  });

  it('strips literal thought tags from both thought and body', () => {
    const md = getStreamingMarkdown({ content: 'body <thinking>x</thinking>', thought: '<thought>t</thought>\nreal' });
    expect(md).not.toContain('<thinking>');
    expect(md).not.toContain('<thought>');
    expect(md).toContain('real');
    expect(md).toContain('body x');
  });

  it('returns the body as-is when there is no thought', () => {
    expect(getStreamingMarkdown({ content: 'plain answer', thought: '' })).toBe('plain answer');
  });

  it('returns a placeholder when both are empty', () => {
    expect(getStreamingMarkdown({ content: '', thought: '' })).toBe('🧠 Thinking...');
  });

  it('handles plain-string input', () => {
    expect(getStreamingMarkdown('hello')).toBe('hello');
  });
});

describe('buildPrivateStreamingBlocks', () => {
  it('builds Phase 1 streaming blocks (thought only) with a bold thinking header', () => {
    const blocks = buildPrivateStreamingBlocks({ content: '', thought: 'Step 1 reasoning' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('🧠 Thinking...');
    expect(json).toContain('Step 1 reasoning');
  });

  it('builds Phase 2 streaming blocks with a native details block for thinking', () => {
    const blocks = buildPrivateStreamingBlocks({ content: 'Body answer.', thought: 'Done thinking.' });
    expect(blocks.some((b) => b.type === 'details' && b.summary === '🧠 Thinking Process')).toBe(true);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Done thinking.');
    expect(json).toContain('Body answer.');
  });

  it('never emits empty streaming blocks (RICH_MESSAGE_EMPTY guard)', () => {
    const blocks = buildPrivateStreamingBlocks({ content: '', thought: '' });
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('streams body-only content without a thinking header', () => {
    const blocks = buildPrivateStreamingBlocks({ content: 'Just the answer', thought: '' });
    expect(JSON.stringify(blocks)).toContain('Just the answer');
    expect(JSON.stringify(blocks)).not.toContain('Thinking');
  });
});

describe('buildDraftStreamingBlocks', () => {
  it('emits a native thinking block while only thinking (draft-only placeholder)', () => {
    const blocks = buildDraftStreamingBlocks({ content: '', thought: 'Step 1 reasoning' });
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe('thinking');
    expect(JSON.stringify(blocks)).toContain('Step 1 reasoning');
  });

  it('falls through to the shared builder once the body starts (phase 2)', () => {
    const blocks = buildDraftStreamingBlocks({ content: 'Body answer.', thought: 'Done thinking.' });
    expect(blocks.some((b) => b.type === 'details' && b.summary === '🧠 Thinking Process')).toBe(true);
    expect(JSON.stringify(blocks)).toContain('Body answer.');
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
  });

  it('handles plain-string input like buildPrivateStreamingBlocks', () => {
    const blocks = buildDraftStreamingBlocks('plain string');
    expect(JSON.stringify(blocks)).toContain('plain string');
  });
});

describe('buildChannelReply draft mode (sendRichMessageDraft)', () => {
  beforeEach(() => {
    mockGetTuningConfig.mockReturnValue({ useRichDraftPrivate: true });
  });

  it('uses the ephemeral draft in private chats when enabled and returns the draft id', async () => {
    const { ctx, api } = makeCtx('private');
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const draftId = await reply.sendRichDraft!({ content: '', thought: 'let me think' });
    expect(draftId).toBeGreaterThan(0);
    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);
    const [chatId, sentDraftId, payload] = api.sendRichMessageDraft.mock.calls[0] as [number, number, unknown];
    expect(chatId).toBe(12345);
    expect(sentDraftId).toBe(draftId);
    expect(JSON.stringify(payload)).toContain('"type":"thinking"');
    expect(api.sendRichMessage).not.toHaveBeenCalled();
  });

  it('updates the draft in place (same draft id) via editRichDraft while in draft mode', async () => {
    const { ctx, api } = makeCtx('private');
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const draftId = await reply.sendRichDraft!('hello');
    api.sendRichMessageDraft.mockClear();
    await reply.editRichDraft!(draftId, { content: 'hello body', thought: 'done thinking' });
    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);
    const [chatId, sentDraftId] = api.sendRichMessageDraft.mock.calls[0] as [number, number];
    expect(chatId).toBe(12345);
    expect(sentDraftId).toBe(draftId);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('persists the draft via sendRichMessage at finalize and returns the real message id', async () => {
    const { ctx, api } = makeCtx('private');
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const draftId = await reply.sendRichDraft!('draft body');
    api.sendRichMessageDraft.mockClear();
    const realId = await reply.editRich!(draftId, 'final body');
    expect(realId).toBe(9001);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    const [chatId, payload] = api.sendRichMessage.mock.calls[0] as [number, unknown];
    expect(chatId).toBe(12345);
    expect(JSON.stringify(payload)).toContain('final body');
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('falls back to the real-message path when sendRichMessageDraft fails', async () => {
    const { ctx, api } = makeCtx('private');
    api.sendRichMessageDraft.mockRejectedValue(new Error('draft not supported'));
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const id = await reply.sendRichDraft!('plain body');
    expect(id).toBe(9001);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps the real-message path when the flag is off', async () => {
    mockGetTuningConfig.mockReturnValue({ useRichDraftPrivate: false });
    const { ctx, api } = makeCtx('private');
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const id = await reply.sendRichDraft!('plain body');
    expect(id).toBe(9001);
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the real-message path in group chats even when the flag is on', async () => {
    const { ctx, api } = makeCtx('group');
    const reply = buildChannelReply(ctx, 12345, 'RichText');
    const id = await reply.sendRichDraft!('group body');
    expect(id).toBe(9001);
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
  });
});
