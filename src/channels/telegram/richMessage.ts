/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file richMessage.ts
 * @description Telegram Bot API 10.2 Rich Message type aliases and re-exports.
 * Re-exports InputRichBlock from `@grammyjs/types` with a convenient alias
 * for media-free rich blocks (tables, details, code fences, quotes, etc.).
 */

// 10.2 block types are sourced from @grammyjs/types (InputRichBlock / RichText).
// We re-export RichBlock here so the rest of the codebase has a single import site.
import type { InputRichBlock } from '@grammyjs/types/rich.js';

/**
 * A media-free outgoing rich block. The generic F (media) is fixed to `never`
 * because tg:// references in text content don't require media field entries.
 * Useful for tables, details blocks, code fences, quotes, lists, and headers.
 */
export type RichBlock = InputRichBlock<never>;
