/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineStreamQueue.ts
 * @description Serialized adaptive-throttle edit queue for inline message
 * streaming (extracted from inlineHandler.ts). One instance per inline card;
 * coalesces pending edits, paces them with exponential 429 backoff, and
 * reports runtime truncation so callers can offer the full document.
 */

import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { logger } from '../../../utils/logger.js';
import type { InputRichMessage } from '@grammyjs/types/rich.js';
import type { RichBlock } from '../richMessage.js';

type InlineEditApi = {
  raw: {
    editMessageText(payload: InlineEditPayload): Promise<unknown>;
  };
};

export class InlineStreamQueue {
  private queue: Promise<void> = Promise.resolve();
  private pendingMarkdown: string | null = null;
  private pendingReplyMarkup: InlineKeyboardMarkup | null = null;
  private pendingBlocks: RichBlock[] | null = null;
  private isProcessing = false;
  private nextAllowedTime = 0;
  private currentThrottleMs = 250; // Start with fast 250ms adaptive throttle for smooth typing
  private minThrottleMs = 250;
  private maxThrottleMs = 4000;
  private lastEditTime = 0;
  private lastSentLen = 0;
  /** True when the final edit had to be truncated at runtime (server-side
   *  RICH_MESSAGE_TEXT_TOO_LONG fallback) — the caller can then surface a
   *  "full document" action for the complete answer. */
  public lastEditTruncated = false;

  constructor(
    private api: InlineEditApi,
    private inlineMessageId: string,
    /** Time scaling factor for backoff/throttle waits. Tests inject a tiny value. */
    private waitScale = 1,
  ) {}

  /**
   * Push a streaming chunk markdown update. Throttled & de-duplicated.
   */
  public enqueueStream(markdown: string): void {
    this.pendingMarkdown = markdown;
    this.scheduleProcess();
  }

  /** Push a streaming frame as native Bot API 10.2 blocks. */
  public enqueueBlocks(markdown: string, blocks: RichBlock[]): void {
    this.pendingMarkdown = markdown;
    this.pendingBlocks = blocks.length > 0 ? blocks : null;
    this.scheduleProcess();
  }

  /**
   * Attach an inline keyboard to the upcoming edit(s), e.g. the Stop button.
   * Cleared after the next successful edit unless re-set.
   */
  public setReplyMarkup(markup: InlineKeyboardMarkup): void {
    this.pendingReplyMarkup = markup;
  }

  /**
   * Attach native 10.2 blocks to the NEXT edit (e.g. the placeholder re-edit
   * so it renders as a true RichMessage). Cleared after that edit succeeds,
   * so subsequent streaming edits naturally fall back to markdown.
   */
  public setBlocks(blocks: RichBlock[] | null): void {
    this.pendingBlocks = blocks;
  }

  /**
   * Push final completion markdown and flush until success with 429 backoff retry.
   * @param replyMarkup optional inline keyboard attached to the final edit (e.g. regenerate / pagination buttons).
   * @param blocks optional native 10.2 blocks for rich message rendering.
   */
  public async flushFinal(markdown: string, replyMarkup?: InlineKeyboardMarkup, blocks?: RichBlock[]): Promise<boolean> {
    this.pendingMarkdown = markdown;
    if (replyMarkup !== undefined) this.pendingReplyMarkup = replyMarkup;
    // A final flush without explicit blocks must not inherit stale blocks
    // (e.g. the placeholder) from a prior setBlocks call.
    this.pendingBlocks = blocks !== undefined && blocks.length > 0 ? blocks : null;
    return new Promise<boolean>((resolve) => {
      this.queue = this.queue.then(async () => {
        const success = await this.executeEdit(true);
        resolve(success);
      });
    });
  }

  private scheduleProcess(): void {
    if (this.isProcessing) return;
    this.queue = this.queue.then(async () => {
      this.isProcessing = true;
      try {
        await this.processPending();
      } finally {
        this.isProcessing = false;
      }
    });
  }

  private async processPending(): Promise<void> {
    if (!this.pendingMarkdown) return;

    const now = Date.now();
    const textDelta = Math.abs(this.pendingMarkdown.length - this.lastSentLen);
    if (now < this.nextAllowedTime || (now - this.lastEditTime < this.currentThrottleMs && textDelta < 15)) {
      const waitMs = Math.max(50, Math.min(this.currentThrottleMs, this.nextAllowedTime - now));
      await new Promise((r) => setTimeout(r, waitMs * this.waitScale));
      if (this.pendingMarkdown && Math.abs(this.pendingMarkdown.length - this.lastSentLen) >= 5) {
        await this.executeEdit(false);
      }
      return;
    }

    await this.executeEdit(false);
  }

  private async executeEdit(isFinal: boolean): Promise<boolean> {
    if (!this.pendingMarkdown) return false;

    let targetMarkdown = this.pendingMarkdown;
    let targetBlocks = this.pendingBlocks && this.pendingBlocks.length > 0 ? this.pendingBlocks : null;
    let degraded = false;
    let attempts = 0;
    // Non-final (streaming) frames also get retries so an oversized frame can
    // degrade blocks→markdown→truncated instead of silently freezing the card.
    const maxAttempts = isFinal ? 5 : 3;

    while (attempts < maxAttempts) {
      attempts++;
      const now = Date.now();
      if (now < this.nextAllowedTime) {
        // Cap the backoff wait so a 429 with a long retry_after cannot freeze
        // the card for minutes; poll in bounded slices instead.
        const waitMs = Math.min((this.nextAllowedTime - now) * this.waitScale, 10_000);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      try {
        const editPayload: InlineEditPayload = {
          inline_message_id: this.inlineMessageId,
          rich_message: targetBlocks ? { blocks: targetBlocks } : { markdown: targetMarkdown },
          ...(this.pendingReplyMarkup !== null ? { reply_markup: this.pendingReplyMarkup } : {}),
        };
        await this.api.raw.editMessageText(editPayload);

        this.lastEditTime = Date.now();
        this.lastSentLen = targetMarkdown.length;
        if (targetMarkdown === this.pendingMarkdown) {
          this.pendingMarkdown = null;
          this.pendingBlocks = null;
        }

        // Gradually recover throttle window towards minThrottleMs on clean success
        this.currentThrottleMs = Math.max(this.minThrottleMs, Math.floor(this.currentThrottleMs * 0.85));
        return true;

      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const match429 = errMsg.match(/retry after (\d+)/i);

        if (match429) {
          const retrySec = parseInt(match429[1], 10);
          const backoffMs = (retrySec + 1) * 1000 * this.waitScale;
          this.nextAllowedTime = Date.now() + backoffMs;

          // Adaptively expand throttle window when 429 occurs
          this.currentThrottleMs = Math.min(this.maxThrottleMs, Math.max(this.currentThrottleMs * 2, backoffMs));
          logger.warn(`[InlineQueue] 429 Rate limited on inline_message_id=${this.inlineMessageId}: waiting ${retrySec}s, new throttleMs=${this.currentThrottleMs}`);

          if (isFinal) {
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          } else {
            break;
          }
        } else {
          if (errMsg.includes('message is not modified')) {
            this.lastSentLen = targetMarkdown.length;
            if (targetMarkdown === this.pendingMarkdown) this.pendingMarkdown = null;
            this.pendingBlocks = null;
            return true;
          } else if (errMsg.includes('RICH_MESSAGE_PHOTO_URL_INVALID') && /!\[|<img\b/i.test(targetMarkdown)) {
            // Telegram's server-side markdown→blocks conversion rejected a
            // photo URL it could not fetch. Strip every image (keeping alt
            // text) and retry so the text answer is still delivered instead of
            // leaving the card stuck on the placeholder.
            targetMarkdown = stripInlineImages(targetMarkdown, 'all');
            this.pendingMarkdown = targetMarkdown;
            this.pendingBlocks = null;
            logger.warn(`[InlineQueue] Photo URL rejected (${errMsg}); retrying without images on inline_message_id=${this.inlineMessageId}`);
            if (isFinal) continue;
            break;
          } else if (errMsg.includes('RICH_MESSAGE_TEXT_TOO_LONG')) {
            if (targetBlocks) {
              targetBlocks = null;
              targetMarkdown = this.pendingMarkdown ?? targetMarkdown;
              logger.warn(`[InlineQueue] Blocks payload too long; retrying as markdown on inline_message_id=${this.inlineMessageId}`);
              continue;
            } else if (!degraded) {
              targetMarkdown = truncateInlineMarkdown(targetMarkdown);
              degraded = true;
              this.lastEditTruncated = true;
              this.pendingMarkdown = targetMarkdown;
              this.pendingBlocks = null;
              logger.warn(`[InlineQueue] Markdown too long (${errMsg}); retrying truncated (${targetMarkdown.length} chars) on inline_message_id=${this.inlineMessageId}`);
              continue;
            } else {
              logger.error(`[InlineQueue] Edit still too long after truncation on inline_message_id=${this.inlineMessageId}: len=${targetMarkdown.length}`);
            }
          } else {
            logger.warn(`[InlineQueue] Edit failed on inline_message_id=${this.inlineMessageId}: ${errMsg}`);
          }
          break;
        }
      }
    }
    return false;
  }
}


type InlineEditPayload = {
  inline_message_id: string;
  rich_message: InputRichMessage<never>;
  reply_markup?: InlineKeyboardMarkup;
};

/**
 * Strip image syntax from inline markdown before it is flushed to Telegram.
 * Telegram's server-side markdown→blocks conversion rejects photo URLs it
 * cannot use (`RICH_MESSAGE_PHOTO_URL_INVALID`), which previously aborted the
 * whole final edit and left the card stuck on the placeholder.
 *
 * `mode='invalid-only'` strips only non-HTTP(S) URLs (data:, file:, tg://,
 * relative paths…); `mode='all'` strips every image as a recovery retry when
 * Telegram rejects a URL it could not fetch (404 / hotlink / wrong type).
 * Alt text of markdown images is preserved so the surrounding text stays
 * readable.
 */
export function stripInlineImages(markdown: string, mode: 'invalid-only' | 'all'): string {
  if (!markdown) return markdown;
  const isHttp = (url: string): boolean => /^https?:\/\//i.test(url.trim());
  let out = markdown;
  // Markdown images: ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_full, alt: string, url: string) => {
    if (mode === 'all' || !isHttp(url)) return (alt ?? '').trim();
    return _full;
  });
  // HTML <img ...> tags
  out = out.replace(/<img\b([^>]*)>/gi, (_full, attrs: string) => {
    const src = attrs.match(/src="([^"]*)"/i)?.[1] ?? '';
    if (mode === 'all' || !isHttp(src)) return '';
    return _full;
  });
  return out;
}

/**
 * Last-resort shrink for inline edits that exceed the rich-message text cap
 * (32768 UTF-8 chars). Strips every `<details>` wrapper (thinking/body folds)
 * and hard-truncates the remaining core, so the answer never leaves the card
 * stuck on a stale streaming frame. The full answer stays reachable via the
 * `/start full_<id>` deep link (fullInlineOutputs).
 */
export function truncateInlineMarkdown(markdown: string, maxLen = 28000): string {
  if (!markdown || markdown.length <= maxLen) return markdown;
  let core = markdown
    .replace(/<details open[^>]*>[\s\S]*?<\/details>/g, '')
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/<summary>[\s\S]*?<\/summary>/g, '')
    .trim();
  if (core.length > maxLen) {
    core = core.slice(0, maxLen - 60) + '\n\n…(回答过长已截断，完整内容可用 /start full_ 查看)';
  }
  return core;
}

