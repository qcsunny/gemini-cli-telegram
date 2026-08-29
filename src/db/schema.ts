/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file schema.ts
 * @description Drizzle ORM schema definitions for SQLite database tables.
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Conversations table stores persistent Telegram chatId mapping to agy session metadata.
 */
export const conversations = sqliteTable('conversations', {
  chatId: text('chat_id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  cwd: text('cwd').notNull(),
  createdAt: text('created_at').notNull(),
  model: text('model'),
  updatedAt: text('updated_at'),
});

/**
 * Messages table persists web2api / deepseek conversation history across restarts.
 * Each row is one user or assistant turn in a backend conversation.
 */
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: text('conversation_id').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  backend: text('backend', { enum: ['web2api', 'deepseek', 'glm', 'qwen', 'gemini-direct', 'opencode', 'claude', 'codex'] }).notNull(),
  createdAt: text('created_at').notNull(),
  /** Token usage: input, output, cached, thinking */
  usage: text('usage'),
});

/**
 * ModelOutputs table persists the original unformatted markdown, title,
 * and thinking block of AI assistant messages keyed by Telegram chat/message IDs.
 */
export const modelOutputs = sqliteTable('model_outputs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  conversationId: text('conversation_id'),
  model: text('model'),
  title: text('title'),
  answerMarkdown: text('answer_markdown').notNull(),
  thinkingMarkdown: text('thinking_markdown'),
  createdAt: text('created_at').notNull(),
});

/**
 * RuntimeStates table persists internal runtime states across restarts (e.g. backend cooldowns, rate limits).
 */
export const runtimeStates = sqliteTable('runtime_states', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * ChatMessages table persists recent Telegram group/chat messages so the /sum
 * command can summarize them. The Bot API cannot fetch chat history, so the
 * bot stores incoming text/caption messages (excluding commands) locally as
 * they arrive.
 */
export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  senderId: integer('sender_id').notNull(),
  senderName: text('sender_name'),
  senderUsername: text('sender_username'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
});
/**
 * Watchlists table persists user stock watchlists linked to Telegram userId.
 */
export const watchlists = sqliteTable('watchlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: integer('telegram_user_id').notNull(),
  symbol: text('symbol').notNull(),
  createdAt: text('created_at').notNull(),
});
