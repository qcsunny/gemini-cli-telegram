/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file messageCache.test.ts
 * @description Tests for the MessageCache class: set/get, LRU eviction, TTL
 * expiration, reply-context extraction from thought tags, per-chat lookups,
 * and asynchronous persistence into the modelOutputs table.
 *
 * Uses `new MessageCache(...)` directly — the exported singleton is untouched.
 * DB assertions run against the in-memory SQLite instance selected by the
 * GEMINI_TELEGRAM_DB_PATH=':memory:' env in vitest.config.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MessageCache, type ReplyContext } from './messageCache.js';
import { getDb, closeDb } from '../db/index.js';
import { modelOutputs } from '../db/schema.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tag strings are assembled via join() so this source file never contains a
// raw thought-tag sequence (which output filters would rewrite).
const THOUGHT_OPEN = ['<', 'thought', '>'].join('');
const THOUGHT_CLOSE = ['<', '/', 'thought', '>'].join('');
const THINK_OPEN = ['<', 'think', '>'].join('');
const THINK_CLOSE = ['<', '/', 'think', '>'].join('');

describe('MessageCache — basic LRU/TTL behavior', () => {
  it('set/get stores and retrieves raw markdown', () => {
    const cache = new MessageCache(60_000, 10);
    cache.set(1, 'hello **markdown**');
    expect(cache.get(1)).toBe('hello **markdown**');
  });

  it('get returns null for unknown ids', () => {
    const cache = new MessageCache(60_000, 10);
    cache.set(1, 'x');
    expect(cache.get(2)).toBeNull();
  });

  it('evicts the least recently used entry when capacity is exceeded', () => {
    const cache = new MessageCache(60_000, 2);
    cache.set(1, 'one');
    cache.set(2, 'two');
    cache.set(3, 'three'); // evicts id 1

    expect(cache.get(1)).toBeNull();
    expect(cache.get(2)).toBe('two');
    expect(cache.get(3)).toBe('three');
    expect(cache.size).toBe(2);
    expect(cache.capacity).toBe(2);
  });

  it('expires entries after the TTL elapses', async () => {
    // lru-cache resolves its clock once at module load (and this build captures
    // the real `Date`), so vi.useFakeTimers() cannot advance its TTL. Use a
    // genuinely short TTL + real wait instead.
    const cache = new MessageCache(40, 10);
    cache.set(1, 'transient');
    expect(cache.get(1)).toBe('transient');

    await sleep(60);
    expect(cache.get(1)).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe('MessageCache — reply context extraction', () => {
  it('splits answer and thinking on set when the text contains a thought tag', () => {
    const cache = new MessageCache(60_000, 10);
    const text = `${THOUGHT_OPEN}let me reason${THOUGHT_CLOSE}The final answer.`;
    cache.set(7, text);

    // Raw text is preserved verbatim; the parsed context is derived from it.
    expect(cache.get(7)).toBe(text);
    expect(cache.getReplyContext(7)).toEqual({
      answerMarkdown: 'The final answer.',
      thinkingMarkdown: 'let me reason',
    });
  });

  it('also recognizes the shorter think tag', () => {
    const cache = new MessageCache(60_000, 10);
    const text = `${THINK_OPEN}thinking here${THINK_CLOSE}Body text`;
    cache.set(8, text);

    expect(cache.getReplyContext(8)).toEqual({
      answerMarkdown: 'Body text',
      thinkingMarkdown: 'thinking here',
    });
  });

  it('plain text without tags yields an empty thinking block', () => {
    const cache = new MessageCache(60_000, 10);
    cache.set(9, 'Plain answer');
    expect(cache.getReplyContext(9)).toEqual({
      answerMarkdown: 'Plain answer',
      thinkingMarkdown: '',
    });
  });

  it('honors an explicitly provided replyContext instead of extracting', () => {
    const cache = new MessageCache(60_000, 10);
    const explicit: ReplyContext = { title: 'T', answerMarkdown: 'A', thinkingMarkdown: 'B' };
    const text = `${THOUGHT_OPEN}ignored${THOUGHT_CLOSE}also ignored`;
    cache.set(10, text, explicit);
    expect(cache.getReplyContext(10)).toBe(explicit);
  });
});

describe('MessageCache — reply context lookups', () => {
  it('tracks the latest context per chat and the latest overall', () => {
    const cache = new MessageCache(60_000, 10);
    const ctxA: ReplyContext = { title: 'A', answerMarkdown: 'answer A', thinkingMarkdown: 'thought A' };
    const ctxB: ReplyContext = { answerMarkdown: 'answer B', thinkingMarkdown: 'thought B' };
    cache.set(1, 'ignored', ctxA, 111);
    cache.set(2, 'ignored', ctxB, 222);

    expect(cache.getLastReplyContextForChat(111)).toEqual(ctxA);
    expect(cache.getLastReplyContextForChat(222)).toEqual(ctxB);
    expect(cache.getLastReplyContextForChat(333)).toBeNull();
    expect(cache.getLastReplyContext()).toEqual(ctxB);

    // A set without chatId only moves the global fallback, not per-chat entries.
    cache.set(3, 'plain C');
    expect(cache.getLastReplyContext()).toEqual({ answerMarkdown: 'plain C', thinkingMarkdown: '' });
    expect(cache.getLastReplyContextForChat(222)).toEqual(ctxB);
  });
});

describe('MessageCache — modelOutputs persistence', () => {
  beforeEach(() => {
    closeDb();
  });

  afterEach(() => {
    closeDb();
  });

  it('persists a row asynchronously when chatId is provided', async () => {
    const cache = new MessageCache(60_000, 100);
    cache.set(5001, 'Persisted answer', undefined, 424242, 'test-model', 'conv-persist-1');
    await sleep(50);

    const rows = getDb()
      .select()
      .from(modelOutputs)
      .where(and(eq(modelOutputs.chatId, '424242'), eq(modelOutputs.messageId, 5001)))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chatId: '424242',
      messageId: 5001,
      conversationId: 'conv-persist-1',
      model: 'test-model',
      answerMarkdown: 'Persisted answer',
      thinkingMarkdown: null,
    });
  });

  it('stores extracted answer and thinking separately in the persisted row', async () => {
    const cache = new MessageCache(60_000, 100);
    const text = `${THOUGHT_OPEN}step by step reasoning${THOUGHT_CLOSE}The extracted answer`;
    cache.set(5002, text, undefined, 777);
    await sleep(50);

    const rows = getDb()
      .select()
      .from(modelOutputs)
      .where(eq(modelOutputs.messageId, 5002))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.answerMarkdown).toBe('The extracted answer');
    expect(rows[0]?.thinkingMarkdown).toBe('step by step reasoning');
    expect(rows[0]?.model).toBeNull();
    expect(rows[0]?.conversationId).toBeNull();
  });

  it('upserts on chatId+messageId instead of duplicating rows', async () => {
    const cache = new MessageCache(60_000, 100);
    cache.set(5003, 'first text', undefined, 888, 'model-a', 'conv-1');
    await sleep(50);
    cache.set(5003, 'second text', undefined, 888, 'model-b', 'conv-2');
    await sleep(50);

    const rows = getDb()
      .select()
      .from(modelOutputs)
      .where(eq(modelOutputs.messageId, 5003))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.answerMarkdown).toBe('second text');
    expect(rows[0]?.model).toBe('model-b');
    expect(rows[0]?.conversationId).toBe('conv-2');
  });

  it('keeps model outputs and latest contexts separate across Telegram topics', async () => {
    const cache = new MessageCache(60_000, 100);
    const topicOne: ReplyContext = { answerMarkdown: 'topic one', thinkingMarkdown: '' };
    const topicTwo: ReplyContext = { answerMarkdown: 'topic two', thinkingMarkdown: '' };

    cache.set(5004, 'topic one', topicOne, 999, 'model-a', 'conv-topic-1', 11);
    cache.set(5004, 'topic two', topicTwo, 999, 'model-b', 'conv-topic-2', 22);
    await sleep(50);

    expect(cache.getLastReplyContextForChat(999, 11)).toEqual(topicOne);
    expect(cache.getLastReplyContextForChat(999, 22)).toEqual(topicTwo);

    const rows = getDb()
      .select()
      .from(modelOutputs)
      .where(and(eq(modelOutputs.chatId, '999'), eq(modelOutputs.messageId, 5004)))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.threadId).sort()).toEqual([11, 22]);
  });
});