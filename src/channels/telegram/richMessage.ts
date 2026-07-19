/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 10.2 block types are sourced from @grammyjs/types (InputRichBlock / RichText).
// We re-export them here so the rest of the codebase has a single import site
// and we can keep the non-generic (media-free) aliases short.
import type { InputRichBlock, RichText } from '@grammyjs/types/rich.js';

/** Media-free rich text: a plain string is a valid RichText per Bot API 10.2. */
export type RichTextPlain = RichText;

/**
 * A media-free outgoing rich block. The generic F (media) is fixed to `never`
 * because this bot never embeds media via tg:// links in block mode.
 */
export type RichBlock = InputRichBlock<never>;
