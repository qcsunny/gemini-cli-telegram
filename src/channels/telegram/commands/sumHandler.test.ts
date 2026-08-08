/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDb } from '../../../db/index.js';
import {
  persistChatMessage,
  loadRecentMessages,
  trimChatMessages,
} from './sumHandler.js';
import type { Message } from '@grammyjs/types';

vi.mock('../../../config/userConfig.js', () => ({
  getDefaultModel: () => 'Test Model',
  getSummarizationConfig: () => ({ defaultCount: 100, maxCount: 500 }),
  getTuningConfig: () => ({
    cacheTtlMs: 86400000,
    cacheMaxSize: 1000,
    debounceIntervalMs: 350,
    modelRunHardTimeoutMs: 900000,
    modelRunInactivityMs: 600000,
    retriesPerModel: 3,
    maxHistoryMessages: 40,
  }),
}));

function makeMsg(overrides: Partial<Message>): Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 999, type: 'group', title: 'Test Group' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    text: 'hello world',
    ...overrides,
  } as Message;
}

describe('sumHandler chat_messages persistence', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_TELEGRAM_DB_PATH', ':memory:');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
  });

  it('should persist a text message and load it back oldest-first', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: 'first' }), '2026-01-01T00:00:00Z');
    persistChatMessage(makeMsg({ message_id: 2, text: 'second' }), '2026-01-01T00:00:01Z');

    const messages = loadRecentMessages(999, 10);
    expect(messages).toEqual([
      { senderName: 'Alice', text: 'first' },
      { senderName: 'Alice', text: 'second' },
    ]);
  });

  it('should skip command messages (starting with /)', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: '/sum 5' }));
    persistChatMessage(makeMsg({ message_id: 2, text: 'a real message' }));

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('a real message');
  });

  it('should deduplicate on (chat_id, message_id)', () => {
    persistChatMessage(makeMsg({ message_id: 5, text: 'dup' }), '2026-01-01T00:00:00Z');
    persistChatMessage(makeMsg({ message_id: 5, text: 'dup again' }), '2026-01-01T00:00:01Z');

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('dup');
  });

  it('should persist media caption when text is absent', () => {
    persistChatMessage(
      makeMsg({ message_id: 7, text: undefined, caption: 'a photo caption' }),
      '2026-01-01T00:00:00Z',
    );

    const messages = loadRecentMessages(999, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('a photo caption');
  });

  it('should load only the most recent N messages and trim older ones', () => {
    for (let i = 1; i <= 5; i++) {
      persistChatMessage(makeMsg({ message_id: i, text: `msg-${i}` }), `2026-01-01T00:00:0${i}Z`);
    }

    const recent = loadRecentMessages(999, 3);
    expect(recent.map((m) => m.text)).toEqual(['msg-3', 'msg-4', 'msg-5']);

    trimChatMessages(999, 3);
    expect(loadRecentMessages(999, 10)).toHaveLength(3);
  });

  it('should be isolated per chat id', () => {
    persistChatMessage(makeMsg({ chat: { id: 1, type: 'group', title: 'G1' }, message_id: 1, text: 'chat1' }));
    persistChatMessage(makeMsg({ chat: { id: 2, type: 'group', title: 'G2' }, message_id: 1, text: 'chat2' }));

    expect(loadRecentMessages(1, 10)).toHaveLength(1);
    expect(loadRecentMessages(2, 10)).toHaveLength(1);
    expect(loadRecentMessages(3, 10)).toHaveLength(0);
  });

  it('should be a no-op when message is undefined', () => {
    persistChatMessage(undefined);
    expect(loadRecentMessages(999, 10)).toHaveLength(0);
  });

  it('should support filtering by target username (case-insensitive)', () => {
    persistChatMessage(makeMsg({ message_id: 1, text: 'msg from bob', from: { id: 10, is_bot: false, first_name: 'Bob', username: 'Bob_The_Builder' } }));
    persistChatMessage(makeMsg({ message_id: 2, text: 'msg from alice', from: { id: 20, is_bot: false, first_name: 'Alice', username: 'AliceInWonderland' } }));
    persistChatMessage(makeMsg({ message_id: 3, text: 'another from bob', from: { id: 10, is_bot: false, first_name: 'Bob', username: 'Bob_The_Builder' } }));

    const bobMsgs = loadRecentMessages(999, 10, 'bob_the_builder');
    expect(bobMsgs).toEqual([
      { senderName: 'Bob', text: 'msg from bob' },
      { senderName: 'Bob', text: 'another from bob' },
    ]);

    const aliceMsgs = loadRecentMessages(999, 10, 'ALICEINWONDERLAND');
    expect(aliceMsgs).toEqual([
      { senderName: 'Alice', text: 'msg from alice' },
    ]);
  });
});
