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
 * Conversation history table for tracking chat message history per session.
 */
export const conversationHistory = sqliteTable('conversation_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  conversationId: text('conversation_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  timestamp: text('timestamp').notNull(),
});

/**
 * Token usage table for recording token consumption metrics per session.
 */
export const tokenUsage = sqliteTable('token_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  conversationId: text('conversation_id'),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  totalTokens: integer('total_tokens').default(0),
  timestamp: text('timestamp').notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationHistoryEntry = typeof conversationHistory.$inferSelect;
export type NewConversationHistoryEntry = typeof conversationHistory.$inferInsert;
export type TokenUsageEntry = typeof tokenUsage.$inferSelect;
export type NewTokenUsageEntry = typeof tokenUsage.$inferInsert;
