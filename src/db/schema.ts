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

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

/**
 * Messages table persists web2api / deepseek conversation history across restarts.
 * Each row is one user or assistant turn in a backend conversation.
 */
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: text('conversation_id').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  backend: text('backend', { enum: ['web2api', 'deepseek', 'gemini-direct'] }).notNull(),
  createdAt: text('created_at').notNull(),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
