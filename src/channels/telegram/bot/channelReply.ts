/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file channelReply.ts
 * @description Telegram Bot API 10.2 Rich Message multi-tier fallback pipeline.
 * Houses `buildChannelReply` (the central adapter that translates abstract
 * send/edit operations into concrete Telegram Bot API calls) plus payload
 * validation. Streaming block builders live in ./streamingBlocks.ts and the
 * draft pacing state machine in ./draftThrottle.ts.
 */

import { Context, InputFile } from 'grammy';

import type { InputRichMessage } from '@grammyjs/types/rich.js';
import type { RichBlock } from '../richMessage.js';
import { markdownToHtml, markdownToMarkdownV2, buildFinalBlocks, buildFooterBlocksFromHtml, splitRichBlocks, TELEGRAM_RICH_MAX_LENGTH } from '../formatter.js';
import { logger } from '../../../utils/logger.js';
import { extractThoughtAndContent } from '../../../agy/thoughtParser.js';
import { messageCache } from '../../../utils/messageCache.js';
import { record429Backoff, is429Error, get429RetryAfter } from './rateLimiter.js';
import { throttleDraft, markDraftEditSuccess, markDraft429 } from './draftThrottle.js';
import { getTuningConfig } from '../../../config/userConfig.js';
import { stripThoughtTags } from '../../../utils/textUtils.js';
import { buildDraftStreamingBlocks, buildPrivateStreamingBlocks, getStreamingMarkdown, isPillOnlyPayload } from './streamingBlocks.js';
export { clearDraftThrottleState } from './draftThrottle.js';
export { getStreamingMarkdown, buildPrivateStreamingBlocks, buildDraftStreamingBlocks } from './streamingBlocks.js';
import type { ChannelReply, StructuredMessage, DaemonSession } from '../../../core/types.js';

interface TelegramApiError {
  error_code?: number;
  description?: string;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asApiError(err: unknown): TelegramApiError {
  const e = asRecord(err);
  if (e) {
    return {
      error_code: typeof e['error_code'] === 'number' ? e['error_code'] : undefined,
      description: typeof e['description'] === 'string' ? e['description'] : undefined,
      message: typeof e['message'] === 'string' ? e['message'] : String(err),
    };
  }
  return { message: String(err) };
}

function buildRichMessagePayload(blocks: RichBlock[]): InputRichMessage<never> {
  return { blocks };
}

function buildRichMessageHtmlPayload(html: string): InputRichMessage<never> {
  return { html };
}

function buildRichMessageMarkdownPayload(markdown: string): InputRichMessage<never> {
  return { markdown };
}

function getCacheMarkdown(text: string | StructuredMessage): string {
  return typeof text === 'string'
    ? text
    : `${text.content}${text.thought ? `\n\n<thought>\n${text.thought}\n</thought>` : ''}`;
}

function getHtmlPayloadWithDetails(text: string | StructuredMessage, isStreaming?: boolean): string {
  let html = getHtmlPayload(text, isStreaming);
  if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
    html = 'Thinking...<br><br>' + html;
  }
  return html;
}

// ── Block payload validation ──

function validateBlocksPayload(blocks: unknown[]): boolean {
  if (!Array.isArray(blocks)) {
    logger.warn(`[BLOCK VALIDATION] blocks is not an array: ${typeof blocks}`);
    return false;
  }
  if (blocks.length === 0) {
    logger.warn(`[BLOCK VALIDATION] blocks array is empty`);
    return false;
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = asRecord(blocks[i]);
    if (!b) {
      logger.warn(`[BLOCK VALIDATION] Block ${i} is not an object: ${typeof blocks[i]}`);
      return false;
    }
    const type = b['type'];
    if (!type || typeof type !== 'string') {
      logger.warn(`[BLOCK VALIDATION] Block ${i} missing 'type': ${JSON.stringify(b).slice(0, 100)}`);
      return false;
    }
    // Per-type required field check
    switch (type as string) {
      case 'paragraph':
      case 'heading':
        if (!b['text']) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (${type}) missing 'text'`);
          return false;
        }
        break;
      case 'pre':
        if (b['text'] !== undefined && typeof b['text'] !== 'string') {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (pre) 'text' must be string, got ${typeof b['text']}`);
          return false;
        }
        break;
      case 'list':
        if (!Array.isArray(b['items']) || (b['items'] as unknown[]).length === 0) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (list) missing or empty 'items'`);
          return false;
        }
        break;
      case 'blockquote':
      case 'details':
        if (!Array.isArray(b['blocks'])) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (${type}) missing 'blocks' array`);
          return false;
        }
        break;
      case 'slideshow':
      case 'collage':
        if (!Array.isArray(b['blocks']) || (b['blocks'] as unknown[]).length === 0) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (${type}) missing or empty 'blocks'`);
          return false;
        }
        break;
      case 'map':
        if (!b['location'] || typeof b['zoom'] !== 'number') {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (map) missing 'location' or 'zoom'`);
          return false;
        }
        break;
      case 'photo':
      case 'video':
      case 'animation':
      case 'audio':
      case 'voice_note': {
        const mediaField = asRecord(b['photo'] ?? b['video'] ?? b['animation'] ?? b['audio'] ?? b['voice_note']);
        if (!mediaField || typeof mediaField['media'] !== 'string' || !mediaField['media'].trim()) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (${type}) missing media URL`);
          return false;
        }
        break;
      }
      case 'table':
        if (!Array.isArray(b['cells']) || (b['cells'] as unknown[]).length === 0) {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (table) missing or empty 'cells'`);
          return false;
        }
        break;
      case 'thinking':
        if (b['text'] !== undefined && typeof b['text'] !== 'string') {
          logger.warn(`[BLOCK VALIDATION] Block ${i} (thinking) 'text' must be string, got ${typeof b['text']}`);
          return false;
        }
        break;
    }
  }
  return true;
}

function getHtmlPayload(originalText: string | StructuredMessage, isStreaming = false): string {
  if (typeof originalText === 'string' && originalText.startsWith('___RAW_HTML___')) {
    return originalText.substring('___RAW_HTML___'.length);
  }
  return markdownToHtml(originalText, isStreaming);
}

/**
 * Build the Bot API 10.2 `InputRichMessage.blocks` payload from a message.
 * - For string input, the structured thought markers (`<thought>`)
 *   are extracted by markdownToHtml's segment parser; here we keep it simple and
 *   treat the whole string as body (thinking already folded into HTML elsewhere).
 * - For StructuredMessage, body + thought are rendered as native blocks, with the
 *   thought appended as a collapsible `details` block at the end.
 * Returns an empty array when there is nothing renderable (caller falls back to HTML).
 */
function getBlocksPayload(originalText: string | StructuredMessage): RichBlock[] {
  if (typeof originalText === 'string') {
    // A footer is sent as `___RAW_HTML___` + (thinking <details> + tg://btn_info_footer
    // anchor). Convert it to native 10.2 blocks (details + footer) instead of HTML.
    if (originalText.startsWith('___RAW_HTML___')) {
      return buildFooterBlocksFromHtml(originalText.substring('___RAW_HTML___'.length));
    }
    const { thought, content } = extractThoughtAndContent(originalText);
    const blocks = buildFinalBlocks(content, thought || undefined);
    return blocks;
  }
  const { content, thought, geminiTime, geminiTokens, footerText } = originalText;
  return buildFinalBlocks(content, thought, {
    time: geminiTime,
    tokens: geminiTokens,
    isClosed: true,
    footerText,
  });
}

function prepareTelegramMarkdown(markdown: string): string {
  let text = markdown;
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  const lines = text.split('\n');
  const fixedLines = lines.map(line => {
    if (line.includes('|')) {
      const parts = line.split('|');
      const fixedParts = parts.map((part, index) => {
        if (index === 0 || index === parts.length - 1) return part;
        let fixed = part;
        const backtickCount = (fixed.match(/`/g) || []).length;
        if (backtickCount % 2 !== 0) fixed = fixed.replace(/`/g, '');
        const underscoreCount = (fixed.match(/_/g) || []).length;
        if (underscoreCount % 2 !== 0) fixed = fixed.replace(/_/g, '');
        const starCount = (fixed.match(/\*/g) || []).length;
        if (starCount % 2 !== 0) fixed = fixed.replace(/\*/g, '');
        return fixed;
      });
      return fixedParts.join('|');
    }
    return line;
  });
  return fixedLines.join('\n');
}

const draftIds = new Map<number, number>();
const activeDraftIds = new Set<number>();

const REACTION_THINKING_EMOJIS = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'] as const;

function reactionEnabled(session?: DaemonSession): boolean {
  return session?.settings?.telegram?.reaction !== false;
}

async function setThinkingReaction(ctx: Context, chatId: number, messageId: number): Promise<void> {
  try {
    const emoji = REACTION_THINKING_EMOJIS[Math.floor(Math.random() * REACTION_THINKING_EMOJIS.length)];
    await ctx.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
  } catch (e: unknown) {
    const err = asApiError(e);
    if (!err.description?.includes('message is not modified')) {
      logger.debug(`setMessageReaction (thinking) failed: ${err.description || err.message}`);
    }
  }
}

async function clearReaction(ctx: Context, chatId: number, messageId: number): Promise<void> {
  try {
    await ctx.api.setMessageReaction(chatId, messageId, []);
  } catch (e: unknown) {
    const err = asApiError(e);
    logger.debug(`setMessageReaction (clear) failed: ${err.description || err.message}`);
  }
}

/**
 * Force-release any active draft for a chatId. Called from messageLoop's `finally`
 * block to prevent permanent activeDraftIds leaks on error/cancel paths (BUG-02).
 */
export function forceReleaseDraft(chatId: number): void {
  const draftId = draftIds.get(chatId);
  if (draftId !== undefined) {
    activeDraftIds.delete(draftId);
    draftIds.delete(chatId);
  }
}

/**
 * Build a ChannelReply that bridges the core message loop to Telegram's API.
 *
 * This is the central adapter that translates abstract send/edit operations
 * into concrete Telegram Bot API calls. It implements a multi-tier fallback
 * pipeline for rich messages (Telegram Bot API 10.2):
 *
 *   Option A (blocks):  sendRichMessage({ blocks: [...] })
 *     → Native rich blocks with zebra-striped tables, <details>, math, etc.
 *     → Fastest to render; best user experience.
 *
 *   Option B (HTML):    sendRichMessage({ html: "..." })
 *     → Server-side HTML→blocks parsing. Slightly slower but more robust
 *       because it doesn't require perfect local AST construction.
 *
 *   Option C (markdown): sendRichMessage({ markdown: "..." })
 *     → Fallback for edge cases where HTML parsing fails.
 *
 *   Option D (plain):   ctx.reply({ parse_mode: 'HTML' })
 *     → Traditional grammY reply when RichMessage is entirely unsupported.
 *
 * Draft (streaming) path mirrors this with sendRichMessageDraft + editRich.
 */
export function buildChannelReply(
  ctx: Context,
  chatId: number,
  parseMode: 'HTML' | 'MarkdownV2' | 'RichText' = 'RichText',
  session?: DaemonSession,
  replyToMessageId?: number,
  options?: { draftThrottleMs?: number },
): ChannelReply {
  const messageThreadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
  const draftDisabled = options?.draftThrottleMs === 0;
  // Official Bot API draft mode (sendRichMessageDraft): opt-in via tuning and
  // private chats only (the API rejects non-private chats). The preview is
  // ephemeral (~30s) — messageLoop keeps it alive with periodic heartbeat
  // re-sends. Failures degrade to the real-message + editMessageText path.
  const draftCapable = ctx.chat?.type === 'private' && getTuningConfig().useRichDraftPrivate;
  let usingDraft = false;
  // Reply-scoped layout latch for the thinking pill. Starts from tuning and
  // flips to false for the rest of this reply if Telegram rejects a pill-only
  // payload (a non-429 error on a single `thinking` block), so the reasoning
  // keeps streaming as paragraphs beside a label-only pill instead of losing the
  // animated draft altogether.
  let pillOnly = getTuningConfig().richDraftThinkingInPill !== false;
  const ephemeralDraftId = (Date.now() % 2_000_000_000) + 1;
  let localDraftsDisabled = false;
  let localConsecutiveDraftFailures = 0;

  const getDraftsDisabled = (): boolean => {
    return session ? !!session.draftsDisabled : localDraftsDisabled;
  };

  const setDraftsDisabled = (val: boolean) => {
    if (session) {
      session.draftsDisabled = val;
    } else {
      localDraftsDisabled = val;
    }
  };

  const getConsecutiveDraftFailures = (): number => {
    return session ? session.consecutiveDraftFailures ?? 0 : localConsecutiveDraftFailures;
  };

  const setConsecutiveDraftFailures = (val: number) => {
    if (session) {
      session.consecutiveDraftFailures = val;
    } else {
      localConsecutiveDraftFailures = val;
    }
  };
const safeEdit = async (messageId: number, text: string | StructuredMessage, html = true, throwOnFail = false) => {
    try {
      const cacheMarkdown = getCacheMarkdown(text);

      if (html) {
        const finalHtml = typeof text === 'string' && text.startsWith('___RAW_HTML___') 
          ? text.substring('___RAW_HTML___'.length) 
          : getHtmlPayload(text);
        await ctx.api.editMessageText(chatId, messageId, finalHtml, {
          parse_mode: 'HTML',
        });
      } else {
        const finalPlain = typeof text === 'string' && text.startsWith('___RAW_HTML___') 
          ? text.substring('___RAW_HTML___'.length) 
          : (typeof text === 'string' ? text : text.content);
        await ctx.api.editMessageText(chatId, messageId, finalPlain);
      }
      messageCache.set(messageId, cacheMarkdown);
    } catch (e: unknown) {
      const err = asApiError(e);
      const cacheMarkdown = getCacheMarkdown(text);
      if (err.description?.includes('message is not modified')) {
        messageCache.set(messageId, cacheMarkdown);
        return;
      }
      if (html) {
        // Fallback to plain text if HTML fails
        try {
          await ctx.api.editMessageText(chatId, messageId, cacheMarkdown);
          messageCache.set(messageId, cacheMarkdown);
        } catch (e2: unknown) {
          const err2 = asApiError(e2);
          if (!err2.description?.includes('message is not modified')) {
            if (throwOnFail) {
              // All edit tiers failed — surface the error so callers (e.g.
              // messageLoop finalize) can degrade gracefully instead of
              // silently dropping the answer.
              logger.error(`Failed to edit message ${messageId}: ${err2.message}`);
              throw err2;
            }
            logger.warn(`Failed to edit message ${messageId}: ${err2.message}`);
          } else {
            messageCache.set(messageId, cacheMarkdown);
          }
        }
      } else if (throwOnFail) {
        logger.error(`Failed to edit message ${messageId}: ${err.message}`);
        throw err;
      } else {
        logger.warn(`Failed to edit message ${messageId}: ${err.message}`);
      }
    }
  };

  const replyObj: ChannelReply = {
    // Live flag messageLoop consults to decide whether the ephemeral-draft
    // heartbeat should run (draft previews expire after ~30s without updates).
    get usesEphemeralDraft(): boolean {
      return usingDraft;
    },
    sendRich: async (originalText: string | StructuredMessage): Promise<number> => {
      const textLen = typeof originalText === 'string'
        ? originalText.length
        : (originalText.content.length + (originalText.thought?.length || 0));
      logger.debug(`[DEBUG] sendRich called: originalTextLen=${textLen}`);
      logger.info(`[SENDRICH] sending real message via sendRichMessage (len=${textLen}, thought.len=${(typeof originalText !== 'string' ? originalText.thought?.length || 0 : 0)})`);

      const safeMarkdown = getCacheMarkdown(originalText);

      try {
        // Option A (AGENTS.md Mandate): Native InputRichBlock via sendRichMessage.
        // Blocks are constructed by buildFinalBlocks (or getBlocksPayload) which
        // produce @grammyjs/types InputRichBlock<never>[] — giving us compile-time
        // validation of every block's required fields.
        try {
          const blocks = getBlocksPayload(originalText);
          if (blocks.length > 0) {
            if (!validateBlocksPayload(blocks)) {
              logger.warn(`[BLOCK VALIDATION] Block payload failed pre-flight validation, skipping Option A`);
              throw new Error('Block payload validation failed');
            }

            // Split blocks into parts using AST-level splitter
            const parts = splitRichBlocks(blocks, TELEGRAM_RICH_MAX_LENGTH);
            const totalTextLen = typeof originalText === 'string'
              ? originalText.length
              : (originalText.content.length + (originalText.thought?.length || 0));

            // File fallback: if extremely long or too many parts, send as .md file
            if (totalTextLen > 60000 || parts.length > 5) {
              logger.info(`[SENDRICH] Message too long (${totalTextLen} chars, ${parts.length} parts), falling back to file send`);
              const mdContent = typeof originalText === 'string'
                ? originalText
                : `${originalText.content}${originalText.thought ? `\n\n# Thinking Process\n${originalText.thought}` : ''}`;
              const fileName = `response_${Date.now()}.md`;
              const replyParams = replyToMessageId ? { message_id: replyToMessageId } : undefined;
              const msg = await ctx.replyWithDocument(new InputFile(Buffer.from(mdContent, 'utf-8'), fileName), {
                message_thread_id: messageThreadId,
                reply_parameters: replyParams,
              });
              messageCache.set(msg.message_id, safeMarkdown);
              return msg.message_id;
            }

            const replyParams = replyToMessageId ? { message_id: replyToMessageId } : undefined;

            // Attach WebApp interactive chart keyboard if response contains a stock/crypto ticker
            const tickerInText = typeof originalText === 'string'
              ? originalText.match(/\$([A-Za-z0-9-]+)/)?.[1]
              : originalText.content.match(/\$([A-Za-z0-9-]+)/)?.[1];
            const keyboardMarkup = tickerInText ? {
              inline_keyboard: [[
                {
                  text: `📊 View $${tickerInText.toUpperCase()} Real-time Chart`,
                  url: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tickerInText.includes('BTC') || tickerInText.includes('ETH') ? `BINANCE:${tickerInText.toUpperCase()}USDT` : `NASDAQ:${tickerInText.toUpperCase()}`)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`
                }
              ]]
            } : undefined;

            if (parts.length === 1) {
              // Single part: send as before
              logger.debug(`[SENDRICH] Option A: sending native blocks (count=${blocks.length})`);
              const richMessage = buildRichMessagePayload(parts[0]);
              const res = await ctx.api.sendRichMessage(chatId, richMessage, {
                message_thread_id: messageThreadId,
                reply_parameters: replyParams,
                reply_markup: keyboardMarkup,
              });
              messageCache.set(res.message_id, safeMarkdown);
              return res.message_id;
            }

            // Multi-part: send sequentially with part numbering and delay
            logger.info(`[SENDRICH] Option A: sending ${parts.length} parts (total=${totalTextLen} chars)`);
            let lastMsgId = 0;
            for (let pIdx = 0; pIdx < parts.length; pIdx++) {
              let partBlocks = parts[pIdx];
              if (pIdx > 0) {
                partBlocks = [...partBlocks, { type: 'footer', text: `(Part ${pIdx + 1}/${parts.length})` } as RichBlock];
              }
              const richMessage = buildRichMessagePayload(partBlocks);
              try {
                const res = await ctx.api.sendRichMessage(chatId, richMessage, {
                  message_thread_id: messageThreadId,
                  reply_parameters: pIdx === 0 ? replyParams : undefined,
                });
                lastMsgId = res.message_id;
                messageCache.set(lastMsgId, safeMarkdown);
              } catch (partErr: unknown) {
                logger.warn(`[SENDRICH] Part ${pIdx + 1}/${parts.length} send failed: ${asApiError(partErr).message}`);
              }
              if (pIdx < parts.length - 1) {
                await new Promise(r => setTimeout(r, 300));
              }
            }
            if (lastMsgId === 0) throw new Error('All multi-part sends failed');
            return lastMsgId;
          } else {
            logger.debug(`[SENDRICH] Option A skipped: empty blocks, falling through`);
          }
        } catch (e: unknown) {
          const err = asApiError(e);
          logger.warn(`sendRich Option A (blocks) failed: ${err.message}. Trying Option B...`);
        }

        // Option B: Rich HTML via sendRichMessage (native server-side HTML→blocks parsing)
        try {
          const html = getHtmlPayloadWithDetails(originalText);
          logger.debug(`[SENDRICH] Option B: sending HTML (html.length=${html.length})`);
          const richMessage = buildRichMessageHtmlPayload(html);
          const res = await ctx.api.sendRichMessage(chatId, richMessage, {
            message_thread_id: messageThreadId,
          });
          messageCache.set(res.message_id, safeMarkdown);
          return res.message_id;
        } catch (e: unknown) {
          const err = asApiError(e);
          logger.warn(`sendRich Option B (HTML) failed: ${err.message}. Trying Option C...`);
        }

        // Option C: Rich Markdown
        try {
          const preparedMarkdown = prepareTelegramMarkdown(safeMarkdown);
          logger.debug(`[SENDRICH] Option C: sending Markdown`);
          const richMessage = buildRichMessageMarkdownPayload(preparedMarkdown);
          const res = await ctx.api.sendRichMessage(chatId, richMessage, {
            message_thread_id: messageThreadId,
          });
          messageCache.set(res.message_id, safeMarkdown);
          return res.message_id;
        } catch (e: unknown) {
          const err = asApiError(e);
          logger.warn(`sendRich Option C failed: ${err.message}. Trying Option D...`);
        }

        // Option D: HTML Fallback via standard ctx.reply
        try {
          const htmlText = getHtmlPayloadWithDetails(originalText);
          const msg = await ctx.reply(htmlText, {
            parse_mode: 'HTML',
            message_thread_id: messageThreadId,
          });
          messageCache.set(msg.message_id, safeMarkdown);
          return msg.message_id;
        } catch (e: unknown) {
          const err = asApiError(e);
          logger.warn(`sendRich Option D failed: ${err.message}. Falling back to plain text.`);
          const msg = await ctx.reply(safeMarkdown, {
            message_thread_id: messageThreadId,
          });
          messageCache.set(msg.message_id, safeMarkdown);
          return msg.message_id;
        }
      } catch (e: unknown) {
        const err = asApiError(e);
        logger.error(`sendRich failed entirely: ${err.message}`);
        throw e;
      } finally {
        draftIds.delete(chatId);
      }
    },

    sendRichDraft: async (originalText: string | StructuredMessage): Promise<number> => {
      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      const thoughtPreview = typeof originalText !== 'string' ? (originalText.thought?.slice(0, 60).replace(/\n/g, '\\n') || '') : '';
      logger.info(`[TRACE-EVIDENCE] sendRichDraft called: originalTextLen=${logTextLen}, thought.len=${typeof originalText !== 'string' ? (originalText.thought?.length || 0) : 0}, thought.preview="${thoughtPreview}", first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = getCacheMarkdown(originalText);

      // Pace to avoid 429 on rapid stream updates (adaptive throttle).
      await throttleDraft(chatId, cacheMarkdown.length, draftDisabled);

      // Draft mode: official sendRichMessageDraft — ephemeral animated preview
      // that finalize later persists via sendRichMessage. On any failure fall
      // through to the real-message path below.
      if (draftCapable) {
        const draftBlocks = buildDraftStreamingBlocks(originalText, { pillOnly, cacheKey: chatId });
        if (draftBlocks.length > 0 && validateBlocksPayload(draftBlocks)) {
          try {
            logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (draft mode): draftId=${ephemeralDraftId}, blocks=${draftBlocks.length}`);
            logger.info(`[TRACE-PROBE] sendRichDraft blocks=${JSON.stringify(draftBlocks)}`);
            await ctx.api.sendRichMessageDraft(chatId, ephemeralDraftId, buildRichMessagePayload(draftBlocks));
            usingDraft = true;
            logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft ok: draftId=${ephemeralDraftId}`);
            return ephemeralDraftId;
          } catch (e: unknown) {
            const err = asApiError(e);
            usingDraft = false;
            if (is429Error(e)) markDraft429(chatId, get429RetryAfter(e));
            logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft failed, falling back to real message: ${err.message}`);
            // A rejected pill-only payload means this client/server build won't
            // take a lone `thinking` block: latch the split layout and retry once
            // before giving up the animated draft for this reply.
            if (pillOnly && !is429Error(e) && isPillOnlyPayload(draftBlocks)) {
              pillOnly = false;
              const splitBlocks = buildDraftStreamingBlocks(originalText, { pillOnly: false, cacheKey: chatId });
              if (splitBlocks.length > 0 && validateBlocksPayload(splitBlocks)) {
                try {
                  logger.info(`[TRACE-EVIDENCE] Retrying sendRichMessageDraft with split layout (pill + paragraphs): draftId=${ephemeralDraftId}`);
                  await ctx.api.sendRichMessageDraft(chatId, ephemeralDraftId, buildRichMessagePayload(splitBlocks));
                  usingDraft = true;
                  return ephemeralDraftId;
                } catch (e2: unknown) {
                  const err2 = asApiError(e2);
                  if (is429Error(e2)) markDraft429(chatId, get429RetryAfter(e2));
                  logger.info(`[TRACE-EVIDENCE] split-layout retry failed too, falling back to real message: ${err2.message}`);
                }
              }
            }
          }
        }
      }

      // Visible streaming: send a REAL persisted message via sendRichMessage so the
      // user's client renders the bubble, then editMessageText updates it in place.
      //
      // Blocks-first: the draft bubble is sent as native 10.2 blocks (and later
      // streamed by editRichDraft) so send/edit/finalize share one rendering path.
      // The lightweight per-frame builder is used — NOT buildFinalBlocks. The
      // per-update blocks/AST parse that previously caused visible stutter used
      // the heavy finalize pipeline; markdownToRichBlocks measures <50ms even at
      // 21KB, so streaming native blocks is smooth again.
      const draftBlocks = buildPrivateStreamingBlocks(originalText);
      if (draftBlocks.length > 0 && validateBlocksPayload(draftBlocks)) {
        try {
          logger.info(`[TRACE-EVIDENCE] Calling sendRichMessage (sendRichDraft Option A - blocks): blocks=${draftBlocks.length}`);
          const res = await ctx.api.sendRichMessage(chatId, buildRichMessagePayload(draftBlocks), {
            message_thread_id: messageThreadId,
          });
          const realId = res.message_id;
          draftIds.set(chatId, realId);
          activeDraftIds.add(realId);
          messageCache.set(realId, cacheMarkdown);
          if (reactionEnabled(session)) {
            await setThinkingReaction(ctx, chatId, realId);
          }
          logger.info(`[TRACE-EVIDENCE] sendRichMessage (sendRichDraft blocks) success: real message id=${realId}.`);
          return realId;
        } catch (e: unknown) {
          const err = asApiError(e);
          logger.info(`[TRACE-EVIDENCE] sendRichDraft Option A (blocks) failed: ${err.message}`);
        }
      }

      // Fallback: rich markdown streaming (client-side markdown parse).
      const safeMarkdown = prepareTelegramMarkdown(getStreamingMarkdown(originalText));
      logger.info(`[TRACE-EVIDENCE] Calling sendRichMessage (sendRichDraft Option C - Markdown streaming)`);
      try {
        const res = await ctx.api.sendRichMessage(chatId, buildRichMessageMarkdownPayload(safeMarkdown), {
          message_thread_id: messageThreadId,
        });
        const realId = res.message_id;
        draftIds.set(chatId, realId);
        activeDraftIds.add(realId);
        messageCache.set(realId, cacheMarkdown);
        if (reactionEnabled(session)) {
          await setThinkingReaction(ctx, chatId, realId);
        }
        logger.info(`[TRACE-EVIDENCE] sendRichMessage (sendRichDraft Markdown) success: real message id=${realId}.`);
        return realId;
      } catch (e: unknown) {
        const err = asApiError(e);
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option C (Markdown) failed: ${err.message}`);
        throw e;
      }
    },
    editRichDraft: async (draftId: number, originalText: string | StructuredMessage, isStreaming = true): Promise<void> => {
      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      logger.info(`[TRACE-EVIDENCE] editRichDraft called: messageId=${draftId}, isStreaming=${isStreaming}, originalTextLen=${logTextLen}, first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = getCacheMarkdown(originalText);

      // Draft mode: update the ephemeral preview via sendRichMessageDraft with
      // the same draft_id — the client animates changes. Failures are soft
      // (retry next frame); finalize always persists via sendRichMessage, so the
      // final answer is never lost even if the preview stops updating.
      if (usingDraft && draftCapable && draftId === ephemeralDraftId) {
        // Pace on the raw buffer length — the draft path renders native blocks,
        // so building the markdown fallback here would be pure per-frame waste
        // (a full regex pass over a buffer that can reach tens of KB, ~4x/sec).
        const shouldEdit = await throttleDraft(chatId, cacheMarkdown.length, draftDisabled);
        if (!shouldEdit) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        const draftBlocks = buildDraftStreamingBlocks(originalText, { pillOnly, cacheKey: chatId });
        if (draftBlocks.length > 0 && validateBlocksPayload(draftBlocks)) {
          try {
            logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (draft update): draftId=${draftId}, blocks=${draftBlocks.length}`);
            if (draftBlocks.some((b) => b.type === 'thinking') || draftBlocks.length <= 2) {
              logger.info(`[TRACE-PROBE] editRichDraft blocks=${JSON.stringify(draftBlocks)}`);
            }
            await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessagePayload(draftBlocks));
            markDraftEditSuccess(chatId, cacheMarkdown.length);
            messageCache.set(draftId, cacheMarkdown);
            return;
          } catch (e: unknown) {
            const err = asApiError(e);
            if (is429Error(e)) markDraft429(chatId, get429RetryAfter(e));
            // Same latch as the initial send: a rejected lone pill downgrades this
            // reply to the split layout, retried on the next frame.
            if (pillOnly && !is429Error(e) && isPillOnlyPayload(draftBlocks)) {
              pillOnly = false;
              logger.info(`[TRACE-EVIDENCE] pill-only draft payload rejected, switching this reply to the split layout`);
            }
            logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft update failed (staying on draft, will retry): ${err.message}`);
            return;
          }
        }
      }

      // The draft is now a REAL persisted message (created by sendRichDraft via
      // sendRichMessage), so we update it in place with editMessageText for a
      // visible typewriter effect.
      //
      // Streaming uses the lightweight per-frame blocks builder (buildPrivateStreamingBlocks),
      // NOT buildFinalBlocks — the per-update blocks/AST parse that previously caused
      // visible stutter used the heavy finalize pipeline; markdownToRichBlocks measures
      // <50ms even at 21KB, so native-blocks streaming is smooth again.
      if (isStreaming) {
        // Adaptive pacing: skip when too soon AND content barely changed;
        // otherwise wait out the current window then edit. Paced on the raw
        // buffer length so the markdown fallback is built only if the native
        // blocks path below actually fails (it is a full regex pass over a
        // buffer that can reach tens of KB, several times per second).
        const shouldEdit = await throttleDraft(chatId, cacheMarkdown.length, draftDisabled);
        if (!shouldEdit) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        // Blocks-first (native 10.2 blocks); falls back to rich markdown below.
        const streamingBlocks = buildPrivateStreamingBlocks(originalText);
        if (streamingBlocks.length > 0 && validateBlocksPayload(streamingBlocks)) {
          try {
            logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft streaming - blocks): messageId=${draftId}, blocks=${streamingBlocks.length}`);
            await ctx.api.editMessageText(chatId, draftId, buildRichMessagePayload(streamingBlocks));
            logger.info(`[TRACE-EVIDENCE] editMessageText (edit streaming blocks) success for messageId=${draftId}.`);
            markDraftEditSuccess(chatId, cacheMarkdown.length);
            messageCache.set(draftId, cacheMarkdown);
            return;
          } catch (e: unknown) {
            const err = asApiError(e);
            if (err.description?.includes('message is not modified') || err.message.includes('message is not modified')) {
              markDraftEditSuccess(chatId, cacheMarkdown.length);
              messageCache.set(draftId, cacheMarkdown);
              return;
            }
            if (is429Error(e)) {
              markDraft429(chatId, get429RetryAfter(e));
              record429Backoff(chatId, get429RetryAfter(e));
            }
            logger.info(`[TRACE-EVIDENCE] editRichDraft streaming blocks failed for messageId=${draftId}: ${err.message}`);
            throw e;
          }
        }
        // Blocks path unusable for this frame — only now pay for the markdown render.
        const safeMarkdown = prepareTelegramMarkdown(getStreamingMarkdown(originalText));
        try {
          logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft streaming - Markdown)`);
          await ctx.api.editMessageText(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown));
          logger.info(`[TRACE-EVIDENCE] editMessageText (edit streaming Markdown) success for messageId=${draftId}.`);
          markDraftEditSuccess(chatId, safeMarkdown.length);
          messageCache.set(draftId, cacheMarkdown);
          return;
        } catch (e: unknown) {
          const err = asApiError(e);
          if (err.description?.includes('message is not modified') || err.message.includes('message is not modified')) {
            markDraftEditSuccess(chatId, safeMarkdown.length);
            messageCache.set(draftId, cacheMarkdown);
            return;
          }
          if (is429Error(e)) {
            markDraft429(chatId, get429RetryAfter(e));
            record429Backoff(chatId, get429RetryAfter(e));
          }
          logger.info(`[TRACE-EVIDENCE] editRichDraft streaming Markdown failed for messageId=${draftId}: ${err.message}`);
          throw e;
        }
      }

      // Option A (10.2): Native structured blocks
      try {
        const blocks = getBlocksPayload(originalText);
        if (blocks.length > 0 && validateBlocksPayload(blocks)) {
          logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft Option A - blocks): messageId=${draftId}, blocks=${blocks.length}`);
          await ctx.api.editMessageText(chatId, draftId, buildRichMessagePayload(blocks));
          logger.info(`[TRACE-EVIDENCE] editMessageText (edit blocks) success for messageId=${draftId}.`);
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified') || err.message.includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        if (is429Error(e)) {
          record429Backoff(chatId, get429RetryAfter(e));
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option A (blocks) failed for messageId=${draftId}: ${err.message}`);
      }

      // Option B: Rich HTML
      try {
        const html = getHtmlPayloadWithDetails(originalText, isStreaming);

        const hasThought = typeof originalText === 'string'
          ? (originalText.includes('<thought') || originalText.includes('<thinking'))
          : (!!originalText.thought && originalText.thought.trim().length > 0);

        const contentText = typeof originalText === 'string'
          ? stripThoughtTags(originalText)
          : (originalText.content || '').trim();

        const suffix = (isStreaming && !hasThought && !contentText)
          ? '<br>Thinking...'
          : '';

        logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft Option B - HTML, isStreaming=${isStreaming})`);
        await ctx.api.editMessageText(chatId, draftId, buildRichMessageHtmlPayload(`${html}${suffix}`));
        logger.info(`[TRACE-EVIDENCE] editMessageText (edit HTML) success for messageId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified') || err.message.includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        if (is429Error(e)) {
          record429Backoff(chatId, get429RetryAfter(e));
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option B (HTML) failed for messageId=${draftId}: ${err.message}`);
      }

      // Option C: Rich Markdown fallback
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft Option C - Markdown)`);
        await ctx.api.editMessageText(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown));
        logger.info(`[TRACE-EVIDENCE] editMessageText (edit Markdown) success for messageId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified') || err.message.includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option C (Markdown) failed for messageId=${draftId}: ${err.message}`);
        throw e;
      }
    },
    sendRichDraftBlocks: async (draftId: number, blocks: unknown[]): Promise<number> => {
      try {
        let targetDraftId = draftId && draftId !== 0 ? draftId : draftIds.get(chatId);
        if (!targetDraftId) {
          targetDraftId = Math.floor(Math.random() * 2147483647) + 1;
        }
        activeDraftIds.add(targetDraftId);
        draftIds.set(chatId, targetDraftId);

        // Pace draft calls to avoid 429
        await throttleDraft(chatId, blocks.length, draftDisabled);

        if (!validateBlocksPayload(blocks)) {
          logger.warn(`[BLOCK VALIDATION] sendRichDraftBlocks payload failed validation`);
          throw new Error('Block payload validation failed');
        }
        const res = await ctx.api.sendRichMessage(chatId, buildRichMessagePayload(blocks as RichBlock[]), {
          message_thread_id: messageThreadId,
        });
        draftIds.set(chatId, res.message_id);
        activeDraftIds.add(res.message_id);
        return res.message_id;
      } catch (e: unknown) {
        const err = asApiError(e);
        logger.warn(`sendRichDraftBlocks failed for draftId=${draftId}: ${err.message}`);
        throw e;
      }
    },
    editRichBlocks: async (messageId: number, blocks: unknown[]): Promise<number | void> => {
      try {
        if (!validateBlocksPayload(blocks)) {
          logger.warn(`[BLOCK VALIDATION] editRichBlocks payload failed validation`);
          throw new Error('Block payload validation failed');
        }
        if (activeDraftIds.has(messageId) || draftIds.get(chatId) === messageId) {
          // The "draft" is now a real persisted message; edit it in place.
          await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks as RichBlock[]));
          activeDraftIds.delete(messageId);
          if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
          return messageId;
        }
        // Edit existing persisted message via editMessageText
        await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks as RichBlock[]));
        return messageId;
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified')) return messageId;
        logger.warn(`editRichBlocks failed for messageId=${messageId}: ${err.message}`);
        throw e;
      }
    },
    editRich: async (messageId: number, originalText: string | StructuredMessage): Promise<number | void> => {
      const textLen = typeof originalText === 'string'
        ? originalText.length
        : (originalText.content.length + (originalText.thought?.length || 0));
      logger.debug(`[DEBUG] editRich called: messageId=${messageId}, originalTextLen=${textLen}`);

      const cacheMarkdown = getCacheMarkdown(originalText);

      // Draft mode finalize: persist the ephemeral preview as a REAL message via
      // sendRichMessage and return its id so messageLoop stops tracking the
      // draft. If persistence fails, fall through to in-place edit (the preview
      // is not a real message, so that fails too — messageLoop's fallback then
      // sends the final content as a fresh message).
      if (usingDraft && draftCapable && messageId === ephemeralDraftId) {
        try {
          const blocks = getBlocksPayload(originalText);
          if (blocks.length > 0 && validateBlocksPayload(blocks)) {
            logger.info(`[FINALIZE] persisting ephemeral draft via sendRichMessage (draftId=${messageId})`);
            const res = await ctx.api.sendRichMessage(chatId, buildRichMessagePayload(blocks), {
              message_thread_id: messageThreadId,
            });
            const realId = res.message_id;
            usingDraft = false;
            messageCache.set(realId, cacheMarkdown);
            logger.info(`[FINALIZE] ephemeral draft persisted as real message id=${realId}`);
            return realId;
          }
          throw new Error('final blocks empty or invalid');
        } catch (e: unknown) {
          const err = asApiError(e);
          usingDraft = false;
          logger.warn(`[FINALIZE] draft persist via sendRichMessage failed: ${err.message}. Falling through to in-place edit.`);
        }
      }

      // The "draft" is now a REAL persisted message (created by sendRichDraft via
      // sendRichMessage), so finalization edits it in place — no second message.
      if (activeDraftIds.has(messageId) || draftIds.get(chatId) === messageId) {
        logger.info(`[FINALIZE] finalizing real streaming message in place (was messageId=${messageId})`);
        activeDraftIds.delete(messageId);
        if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
        if (reactionEnabled(session)) {
          await clearReaction(ctx, chatId, messageId);
        }
      }

      // Option A (10.2): Native structured blocks (final, persisted message).
      try {
        const blocks = getBlocksPayload(originalText);
        if (blocks.length > 0) {
          if (!validateBlocksPayload(blocks)) {
            logger.warn(`[BLOCK VALIDATION] editRich blocks failed validation, falling through`);
            throw new Error('Block payload validation failed');
          }

          const parts = splitRichBlocks(blocks, TELEGRAM_RICH_MAX_LENGTH);
          if (parts.length > 1) {
            logger.info(`[editRich] Message blocks exceed max length. Splitting into ${parts.length} parts.`);
            // Edit the original message with the first part
            await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(parts[0]));
            // Send remaining parts as new messages; a failed continuation part
            // must not roll back the whole edit into the next fallback tier.
            for (let i = 1; i < parts.length; i++) {
              try {
                await ctx.api.sendRichMessage(chatId, buildRichMessagePayload(parts[i]), {
                  message_thread_id: messageThreadId,
                });
              } catch (partErr: unknown) {
                logger.warn(`[editRich] Part ${i + 1}/${parts.length} send failed: ${asApiError(partErr).message}`);
              }
            }
          } else {
            logger.debug(`[DEBUG] editMessageText (Option A - blocks) called: messageId=${messageId}, blocks=${blocks.length}`);
            await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks));
          }
          logger.debug(`[DEBUG] editMessageText (Option A - blocks) success: messageId=${messageId}`);
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option A (blocks) failed: ${err.message}. Trying Option B...`);
      }

      // Option B: Native Rich HTML
      try {
        const html = getHtmlPayloadWithDetails(originalText);
        logger.debug(`[TELEGRAM PAYLOAD] editRich originalText.length=${textLen} html.length=${html.length} containsDetails=${html.includes('<details')} containsThoughtSummary=${html.includes('🧠 思考过程') || html.includes('Thinking Process')} containsBodyTitle=${html.includes('证明') || html.includes('Proof')}`);

        logger.debug(`[DEBUG] editMessageText (Option B) called: messageId=${messageId}`);
        await ctx.api.editMessageText(chatId, messageId, buildRichMessageHtmlPayload(html));
        logger.debug(`[DEBUG] editMessageText (Option B) success: messageId=${messageId}`);
        messageCache.set(messageId, cacheMarkdown);
        return;
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option B failed: ${err.message}. Trying Option C...`);
      }

      // Option C: Rich Markdown
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.debug(`[DEBUG] editMessageText (Option C) called: messageId=${messageId}`);
        await ctx.api.editMessageText(chatId, messageId, buildRichMessageMarkdownPayload(safeMarkdown));
        logger.debug(`[DEBUG] editMessageText (Option C) success: messageId=${messageId}`);
        messageCache.set(messageId, cacheMarkdown);
        return;
      } catch (e: unknown) {
        const err = asApiError(e);
        if (err.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option C failed: ${err.message}. Trying Option D...`);
      }

      // Option D: HTML Fallback (throwOnFail: finalize must not silently lose the answer)
      await safeEdit(messageId, originalText, true, true);
    },

    send: async (replyText: string): Promise<number> => {
      try {
        if (parseMode === 'RichText') {
          if (replyText.trim()) {
            return await replyObj.sendRich!(replyText);
          }
        }
        const isRawHtml = replyText.startsWith('___RAW_HTML___');
        const finalHtml = isRawHtml 
          ? replyText.substring('___RAW_HTML___'.length) 
          : (parseMode === 'MarkdownV2' ? markdownToMarkdownV2(replyText) : markdownToHtml(replyText));
        const msg = await ctx.reply(
          finalHtml,
          {
            parse_mode: isRawHtml ? 'HTML' : (parseMode === 'MarkdownV2' ? 'MarkdownV2' : 'HTML'),
            message_thread_id: messageThreadId,
          },
        );
        messageCache.set(msg.message_id, replyText);
        return msg.message_id;
      } catch (e: unknown) {
        const err = asApiError(e);
        logger.warn(`Failed to send message in ${parseMode} mode: ${err.message}`);
        const msg = await ctx.reply(replyText, {
          message_thread_id: messageThreadId,
        });
        messageCache.set(msg.message_id, replyText);
        return msg.message_id;
      }
    },
    edit: async (messageId: number, newText: string): Promise<number | void> => {
      if (parseMode === 'RichText') {
        if (newText.trim()) {
          return await replyObj.editRich!(messageId, newText);
        }
      }
      await safeEdit(messageId, newText, true);
    },
  sendPlain: async (replyText: string): Promise<number> => {
      if (parseMode === 'RichText' && !getDraftsDisabled() && replyText.trim()) {
        try {
          const res = await replyObj.sendRichDraft!(replyText);
          setConsecutiveDraftFailures(0);
          return res;
        } catch (e: unknown) {
          const failures = getConsecutiveDraftFailures() + 1;
          setConsecutiveDraftFailures(failures);
          if (failures >= 2) {
            setDraftsDisabled(true);
            logger.warn(`Circuit breaker triggered: disabling rich drafts for chat ${chatId} due to consecutive failures.`);
          } else {
            const err = asApiError(e);
            logger.warn(`Failed to send rich draft stream (attempt ${failures}): ${err.message}`);
          }
        }
      }
      const msg = await ctx.reply(replyText);
      messageCache.set(msg.message_id, replyText);
      return msg.message_id;
    },
    editPlain: async (messageId: number, newText: string): Promise<void> => {
      if (parseMode === 'RichText' && !getDraftsDisabled() && newText.trim()) {
        try {
          if (replyObj.editRichDraft) {
            await replyObj.editRichDraft(messageId, newText);
          } else {
            await replyObj.sendRichDraft!(newText);
          }
          setConsecutiveDraftFailures(0);
          return;
        } catch (e: unknown) {
          const failures = getConsecutiveDraftFailures() + 1;
          setConsecutiveDraftFailures(failures);
          if (failures >= 2) {
            setDraftsDisabled(true);
            logger.warn(`Circuit breaker triggered: disabling rich drafts for chat ${chatId} due to consecutive failures.`);
          } else {
            const err = asApiError(e);
            logger.warn(`Failed to edit rich draft stream (attempt ${failures}): ${err.message}`);
          }
        }
      }
      await safeEdit(messageId, newText, false);
    },
    sendDocument: async (
      filePath: string,
      docCaption?: string,
    ): Promise<void> => {
      await ctx.replyWithDocument(new InputFile(filePath), {
        caption: docCaption ? markdownToHtml(docCaption) : undefined,
        parse_mode: docCaption ? 'HTML' : undefined,
      });
    },
    delete: async (messageId: number): Promise<void> => {
      try {
        await ctx.api.deleteMessage(chatId, messageId);
      } catch {
        // ignore delete failures
      }
    },
  };

  return replyObj;
}
