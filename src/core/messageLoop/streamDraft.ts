/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file streamDraft.ts
 * @description Single-draft append-only streaming state machine (extracted from
 * messageLoop.ts): owns the thought/answer buffers, draft message ID, render
 * phase, and the debounced serial edit pipeline that renders the authoritative
 * content to the wire (draft while streaming, real message once finalized).
 */

import type { ChannelReply, MessageFormatter } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getTuningConfig } from '../../config/userConfig.js';
import { stripThoughtTags } from '../../utils/textUtils.js';

export type StreamPhase = 'thinking' | 'body' | 'footer';

export class StreamDraft {
  thoughtBuffer = '';
  answerBuffer = '';
  currentMessageId: number | null = null;
  phase: StreamPhase = 'thinking';
  isFinished = false;

  private lastEditTime = 0;
  private activeUpdatePromise: Promise<void> = Promise.resolve();
  private readonly hasRichPrimitives: boolean;

  constructor(
    private readonly reply: ChannelReply,
    private readonly formatter: MessageFormatter,
  ) {
    this.hasRichPrimitives = !!reply.sendRichDraft;
  }

  get hasRich(): boolean {
    return this.hasRichPrimitives;
  }

  /** Awaits any pending debounced edit so finalize never races the stream. */
  async drainPending(): Promise<void> {
    try {
      await this.activeUpdatePromise;
    } catch (e) {
      logger.warn(`[messageLoop] Error waiting for active update promise: ${e}`);
    }
  }

  /**
   * Render the whole authoritative content to the wire (draft while streaming,
   * real message once finalized).
   */
  async flushBlocks(): Promise<void> {
    const stripped = stripThoughtTags(this.answerBuffer.trim());
    const content: { content: string; thought?: string } = {
      content: stripped,
    };
    if (this.thoughtBuffer.trim()) content.thought = this.thoughtBuffer.trim();

    logger.info(`[TRACE flushBlocks] phase=${this.phase} msgId=${this.currentMessageId} content.len=${content.content.length} thought.len=${(content.thought || '').length}`);

    if (this.currentMessageId === null || this.currentMessageId === 0) {
      const resId = await this.reply.sendRichDraft!(content);
      if (typeof resId === 'number' && resId > 0) this.currentMessageId = resId;
    } else if (this.phase === 'footer') {
      await this.reply.editRichDraft!(this.currentMessageId, content);
    } else {
      await this.reply.editRichDraft!(this.currentMessageId, content);
    }
  }

  /** Stream editing helper — append-only. */
  async updateMessageStream(isFinal = false): Promise<void> {
    if (this.isFinished && !isFinal) return;
    const now = Date.now();
    if (!isFinal && now - this.lastEditTime < getTuningConfig().debounceIntervalMs) return;
    this.lastEditTime = now;

    this.activeUpdatePromise = this.activeUpdatePromise.then(async () => {
      if (this.isFinished && !isFinal) return;
      try {
        if (!this.hasRichPrimitives) {
          // Non-rich fallback: plain text (thinking then body), single message path.
          let text = '';
          if (this.thoughtBuffer.trim()) {
            const prefix = isFinal ? '🧠 Thinking Process\n\n' : '🧠 Thinking...\n\n';
            text = prefix + this.thoughtBuffer.trim();
            if (this.answerBuffer.trim()) text += '\n\n' + this.answerBuffer.trim();
          } else if (this.answerBuffer.trim()) {
            text = this.answerBuffer.trim();
          }
          if (text) {
            const truncated = this.formatter.truncateForEdit(text);
            if (!this.currentMessageId) this.currentMessageId = await this.reply.sendPlain(truncated);
            else await this.reply.editPlain(this.currentMessageId, truncated);
          }
          return;
        }

        // ── Rich streaming path ──
        // Render the whole authoritative content as native 10.2 RichBlocks via
        // sendRichDraft/editRichDraft (draft while streaming, real message on
        // finalize). flushBlocks strips thought tags and keeps a single
        // append-only draft bubble.
        await this.flushBlocks();
      } catch (e) {
        logger.warn(`[messageLoop] Failed to update streaming message: ${e}`);
      }
    });

    await this.activeUpdatePromise;
  }
}