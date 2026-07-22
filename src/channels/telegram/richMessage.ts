/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file richMessage.ts
 * @description Telegram Bot API 10.2 Rich Message type aliases and re-exports.
 * Re-exports InputRichBlock, RichText, and InputRichMessageMedia from `@grammyjs/types`
 * with convenient aliases for media-free rich text, rich blocks, and media attachments.
 */

// 10.2 block types are sourced from @grammyjs/types (InputRichBlock / RichText).
// We re-export them here so the rest of the codebase has a single import site
// and we can keep the non-generic (media-free) aliases short.
import type { InputRichBlock, RichText, InputRichMessageMedia } from '@grammyjs/types/rich.js';
import type { InputFile } from 'grammy/types';

/** 
 * Media-free rich text: a plain string is a valid RichText per Bot API 10.2. 
 * Represents basic formatted text content that does not embed any blocks.
 */
export type RichTextPlain = RichText;

/**
 * A media-free outgoing rich block. The generic F (media) is fixed to `never`
 * because tg:// references in text content don't require media field entries.
 * Useful for tables, details blocks, code fences, quotes, lists, and headers.
 */
export type RichBlock = InputRichBlock<never>;

/** 
 * Media attachment for rich messages (used when uploading files like photos, videos, or documents).
 * Wraps @grammyjs/types InputRichMessageMedia with the local grammy InputFile type.
 */
export type RichMessageMedia = InputRichMessageMedia<InputFile>;
