/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, schema } from './index.js';
import {
  setConversation,
  getConversationId,
  getCwd,
  getStoredModel,
  deleteConversation,
} from '../agy/conversationStore.js';
import { eq } from 'drizzle-orm';

describe('Drizzle ORM & Better-SQLite3 Database', () => {
  beforeEach(() => {
    closeDb();
  });

  afterEach(() => {
    closeDb();
  });

  it('should initialize in-memory SQLite database and create schemas', () => {
    const db = getDb(':memory:');
    expect(db).toBeDefined();

    // Verify conversations table operations
    db.insert(schema.conversations)
      .values({
        chatId: '1001',
        conversationId: 'conv-uuid-1',
        cwd: '/path/to/project',
        createdAt: new Date().toISOString(),
        model: 'Gemini 3.6 Flash',
      })
      .run();

    const row = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.chatId, '1001'))
      .get();

    expect(row).toBeDefined();
    expect(row?.conversationId).toBe('conv-uuid-1');
    expect(row?.cwd).toBe('/path/to/project');
    expect(row?.model).toBe('Gemini 3.6 Flash');
  });
});

describe('conversationStore with Drizzle ORM', () => {
  const testChatId = 99999;

  afterEach(async () => {
    await deleteConversation(testChatId);
  });

  it('should save and retrieve conversation metadata', async () => {
    await setConversation(testChatId, 'conv-uuid-99', '/workspace/demo', 'Gemini 3.5 Flash');

    const convId = await getConversationId(testChatId);
    const cwd = await getCwd(testChatId);
    const model = await getStoredModel(testChatId);

    expect(convId).toBe('conv-uuid-99');
    expect(cwd).toBe('/workspace/demo');
    expect(model).toBe('Gemini 3.5 Flash');
  });

  it('should update existing conversation entry on setConversation', async () => {
    await setConversation(testChatId, 'conv-uuid-1', '/workspace/1', 'Model A');
    await setConversation(testChatId, 'conv-uuid-2', '/workspace/2', 'Model B');

    const convId = await getConversationId(testChatId);
    const cwd = await getCwd(testChatId);
    const model = await getStoredModel(testChatId);

    expect(convId).toBe('conv-uuid-2');
    expect(cwd).toBe('/workspace/2');
    expect(model).toBe('Model B');
  });

  it('should delete conversation entry', async () => {
    await setConversation(testChatId, 'conv-uuid-del', '/workspace/del', 'Model Del');
    await deleteConversation(testChatId);

    const convId = await getConversationId(testChatId);
    expect(convId).toBeNull();
  });
});
