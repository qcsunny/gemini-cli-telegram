/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file channelReply.ts
 * @description Telegram Bot API 10.2 Rich Message multi-tier fallback pipeline.
 * Houses `buildChannelReply` (the central adapter that translates abstract
 * send/edit operations into concrete Telegram Bot API calls) and the helpers
 * used by it: block construction, payload validation, throttle/backoff, etc.
 */

import { Context, InputFile } from 'grammy';

import type { InputRichMessage } from '@grammyjs/types/rich.js';
import type { RichBlock } from '../richMessage.js';
import { markdownToHtml, markdownToMarkdownV2, buildFinalBlocks, buildStreamingBlocks, buildFooterBlocksFromHtml, splitRichBlocks, TELEGRAM_RICH_MAX_LENGTH } from '../formatter.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import { draftBackoffUntil } from './rateLimiter.js';
import type { ChannelReply, StructuredMessage, DaemonSession } from '../../../core/types.js';

export function getRichMessageApi(ctx: Context) {
  return (ctx.api.config as any).useExtend?.('richMessage') ?? ctx.api;
}

// Thin wrappers around InputRichMessage construction.
// These keep the rest of the codebase decoupled from the raw grammY type shape
// and make it easy to swap payload formats without touching call sites.
function buildRichMessagePayload(blocks: RichBlock[]): InputRichMessage<never> {
  return { blocks };
}

function buildRichMessageHtmlPayload(html: string): InputRichMessage<never> {
  return { html };
}

function buildRichMessageMarkdownPayload(markdown: string): InputRichMessage<never> {
  return { markdown };
}

const draftThrottleTimestamps = new Map<number, number>();
const DRAFT_THROTTLE_MS = 250;

async function throttleDraft(chatId: number): Promise<void> {
  const now = Date.now();
  const backoffUntil = draftBackoffUntil.get(chatId) ?? 0;
  if (now < backoffUntil) {
    const wait = backoffUntil - now;
    logger.info(`[429 BACKOFF] Throttling draft update for chatId=${chatId} due to active 429 backoff (${wait}ms left)`);
    await new Promise(r => setTimeout(r, wait));
  } else {
    const last = draftThrottleTimestamps.get(chatId) ?? 0;
    const elapsed = now - last;
    if (elapsed < DRAFT_THROTTLE_MS) {
      await new Promise(r => setTimeout(r, DRAFT_THROTTLE_MS - elapsed));
    }
  }
  draftThrottleTimestamps.set(chatId, Date.now());
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
    const b = blocks[i] as Record<string, unknown>;
    if (!b || typeof b !== 'object') {
      logger.warn(`[BLOCK VALIDATION] Block ${i} is not an object: ${typeof b}`);
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
 * - For string input, the structured thought markers (`<thought>` / `<thought-gemini>`)
 *   are extracted by markdownToHtml's segment parser; here we keep it simple and
 *   treat the whole string as body (thinking already folded into HTML elsewhere).
 * - For StructuredMessage, body + thought are rendered as native blocks, with the
 *   thought appended as a collapsible `details` block at the end.
 * Returns an empty array when there is nothing renderable (caller falls back to HTML).
 */
function getBlocksPayload(originalText: string | StructuredMessage): any[] {
  if (typeof originalText === 'string') {
    // A footer is sent as `___RAW_HTML___` + (thinking <details> + tg://btn_info_footer
    // anchor). Convert it to native 10.2 blocks (details + footer) instead of HTML.
    if (originalText.startsWith('___RAW_HTML___')) {
      return buildFooterBlocksFromHtml(originalText.substring('___RAW_HTML___'.length));
    }
    const blocks = buildFinalBlocks(originalText);
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

export interface TelegramBotOptions {
  allowedUsers?: number[];
  model?: string;
  cwd?: string;
  proxy?: string;
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
): ChannelReply {
  const messageThreadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
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
  const safeEdit = async (messageId: number, text: string | StructuredMessage, html = true) => {
    try {
      const cacheMarkdown = typeof text === 'string'
        ? text
        : `${text.content}${text.thought ? `\n\n<thought>\n${text.thought}\n</thought>` : ''}`;

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
    } catch (e: any) {
      const cacheMarkdown = typeof text === 'string'
        ? text
        : `${text.content}${text.thought ? `\n\n<thought>\n${text.thought}\n</thought>` : ''}`;
      if (e?.description?.includes('message is not modified')) {
        messageCache.set(messageId, cacheMarkdown);
        return;
      }
      if (html) {
        // Fallback to plain text if HTML fails
        try {
          await ctx.api.editMessageText(chatId, messageId, cacheMarkdown);
          messageCache.set(messageId, cacheMarkdown);
        } catch (e2: any) {
          if (!e2?.description?.includes('message is not modified')) {
            logger.warn(`Failed to edit message ${messageId}: ${e2}`);
          } else {
            messageCache.set(messageId, cacheMarkdown);
          }
        }
      } else {
        logger.warn(`Failed to edit message ${messageId}: ${e}`);
      }
    }
  };

  const replyObj: ChannelReply = {
    sendRich: async (originalText: string | StructuredMessage): Promise<number> => {
      const textLen = typeof originalText === 'string'
        ? originalText.length
        : (originalText.content.length + (originalText.thought?.length || 0));
      logger.debug(`[DEBUG] sendRich called: originalTextLen=${textLen}`);
      logger.info(`[SENDRICH] sending real message via sendRichMessage (len=${textLen})`);

      const safeMarkdown = typeof originalText === 'string'
        ? originalText
        : `${originalText.content}${originalText.thought ? `\n\n<thought>\n${originalText.thought}\n</thought>` : ''}`;

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
                : `${originalText.content}${originalText.thought ? `\n\n# 思考过程\n${originalText.thought}` : ''}`;
              const fileName = `response_${Date.now()}.md`;
              const preview = mdContent.slice(0, 200).replace(/\n/g, ' ');
              const caption = `📄 内容过长，已自动导出为 Markdown 文件\n\n${preview}...`;
              const file = new InputFile(Buffer.from(mdContent, 'utf-8'), fileName);
              const msg = await ctx.replyWithDocument(file, {
                caption,
                message_thread_id: messageThreadId,
              });
              messageCache.set(msg.message_id, safeMarkdown);
              return msg.message_id;
            }

            if (parts.length === 1) {
              // Single part: send as before
              logger.debug(`[SENDRICH] Option A: sending native blocks (count=${blocks.length})`);
              const richMessage = buildRichMessagePayload(parts[0]);
              const res = await ctx.api.sendRichMessage(chatId, richMessage, {
                message_thread_id: messageThreadId,
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
              const res = await ctx.api.sendRichMessage(chatId, richMessage, {
                message_thread_id: messageThreadId,
              });
              lastMsgId = res.message_id;
              messageCache.set(lastMsgId, safeMarkdown);
              if (pIdx < parts.length - 1) {
                await new Promise(r => setTimeout(r, 300));
              }
            }
            return lastMsgId;
          } else {
            logger.debug(`[SENDRICH] Option A skipped: empty blocks, falling through`);
          }
        } catch (err: any) {
          logger.warn(`sendRich Option A (blocks) failed: ${err.message || err}. Trying Option B...`);
        }

        // Option B: Rich HTML via sendRichMessage (native server-side HTML→blocks parsing)
        try {
          let html = getHtmlPayload(originalText);
          if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
            html = '正在思考...<br><br>' + html;
          }
          logger.debug(`[SENDRICH] Option B: sending HTML (html.length=${html.length})`);
          const richMessage = buildRichMessageHtmlPayload(html);
          const res = await ctx.api.sendRichMessage(chatId, richMessage, {
            message_thread_id: messageThreadId,
          });
          messageCache.set(res.message_id, safeMarkdown);
          return res.message_id;
        } catch (err: any) {
          logger.warn(`sendRich Option B (HTML) failed: ${err.message || err}. Trying Option C...`);
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
        } catch (err: any) {
          logger.warn(`sendRich Option C failed: ${err.message || err}. Trying Option D...`);
        }

        // Option D: HTML Fallback via standard ctx.reply
        try {
          let htmlText = getHtmlPayload(originalText);
          if (htmlText.includes('<details') && !htmlText.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
            htmlText = '正在思考...<br><br>' + htmlText;
          }
          const msg = await ctx.reply(htmlText, {
            parse_mode: 'HTML',
            message_thread_id: messageThreadId,
          });
          messageCache.set(msg.message_id, safeMarkdown);
          return msg.message_id;
        } catch (err: any) {
          logger.warn(`sendRich Option D failed: ${err.message || err}. Falling back to plain text.`);
          const msg = await ctx.reply(safeMarkdown, {
            message_thread_id: messageThreadId,
          });
          messageCache.set(msg.message_id, safeMarkdown);
          return msg.message_id;
        }
      } catch (err: any) {
        logger.error(`sendRich failed entirely: ${err}`);
        throw err;
      } finally {
        draftIds.delete(chatId);
      }
    },

    sendRichDraft: async (originalText: string | StructuredMessage): Promise<number> => {
      let draftId = draftIds.get(chatId);
      if (!draftId) {
        draftId = Math.floor(Math.random() * 2147483647) + 1;
        draftIds.set(chatId, draftId);
      }
      activeDraftIds.add(draftId);

      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      logger.info(`[TRACE-EVIDENCE] sendRichDraft called: draftId=${draftId}, originalTextLen=${logTextLen}, first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = typeof originalText === 'string'
        ? originalText
        : `${originalText.content}${originalText.thought ? `\n\n<thought>\n${originalText.thought}\n</thought>` : ''}`;

      // Throttle to avoid 429 on rapid stream updates
      await throttleDraft(chatId);

      // Option A (10.2): Native structured blocks with native `thinking` placeholder
      // while streaming (draft-only). Body blocks are streamed once content arrives.
      try {
        const contentRaw = typeof originalText === 'string' ? originalText : originalText.content;
        const thoughtRaw = typeof originalText === 'string' ? undefined : originalText.thought;
        const blocks = buildStreamingBlocks({ content: contentRaw, thought: thoughtRaw });
        if (blocks.length > 0) {
          if (!validateBlocksPayload(blocks)) {
            logger.warn(`[BLOCK VALIDATION] Draft blocks failed pre-flight, falling through`);
            throw new Error('Draft blocks validation failed');
          }
          logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (Option A - blocks): draftId=${draftId}, blocks=${blocks.length}`);
          await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessagePayload(blocks), {
            message_thread_id: messageThreadId,
          });
          logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (blocks) success for draftId=${draftId}.`);
          messageCache.set(draftId, cacheMarkdown);
          return draftId;
        }
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option A (blocks) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option B: Native Rich HTML with native thinking animation
      try {
        let html = getHtmlPayload(originalText, true);
        if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
          html = '正在思考...<br><br>' + html;
        }

        const contentText = typeof originalText === 'string'
          ? originalText.replace(/<thought[^>]*>[\s\S]*?<\/thought[^>]*>/gi, '').replace(/<thought-gemini[^>]*>[\s\S]*?<\/thought-gemini[^>]*>/gi, '').replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, '').trim()
          : (originalText.content || '').trim();

        const suffix = contentText
          ? ''
          : '\n<tg-thinking>正在思考...</tg-thinking>';

        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (Option B): html="${html}${suffix}"`);
        await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessageHtmlPayload(`${html}${suffix}`), {
          message_thread_id: messageThreadId,
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (HTML) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return draftId;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option B (HTML) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option C: Rich Markdown
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (Option C - Markdown): markdown="${safeMarkdown}"`);
        await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown), {
          message_thread_id: messageThreadId,
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (Markdown) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return draftId;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option C (Markdown) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
        throw err;
      }
    },
    editRichDraft: async (draftId: number, originalText: string | StructuredMessage, isStreaming = true): Promise<void> => {
      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      logger.info(`[TRACE-EVIDENCE] editRichDraft called: draftId=${draftId}, isStreaming=${isStreaming}, originalTextLen=${logTextLen}, first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = typeof originalText === 'string'
        ? originalText
        : `${originalText.content}${originalText.thought ? `\n\n<thought>\n${originalText.thought}\n</thought>` : ''}`;

      // Throttle to avoid 429 on rapid stream updates
      await throttleDraft(chatId);

      // Per Bot API 10.1: there is no "editRichMessageDraft" method.
      // Updating a draft is done by calling sendRichMessageDraft again with the same draft_id.
      // Option A (10.2): Native structured blocks with native `thinking` placeholder.
      try {
        const contentRaw = typeof originalText === 'string' ? originalText : originalText.content;
        const thoughtRaw = typeof originalText === 'string' ? undefined : originalText.thought;
        const blocks = buildStreamingBlocks({ content: contentRaw, thought: thoughtRaw });
        if (blocks.length > 0) {
          if (!validateBlocksPayload(blocks)) {
            logger.warn(`[BLOCK VALIDATION] Edit draft blocks failed pre-flight, falling through`);
            throw new Error('Edit draft blocks validation failed');
          }
          logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (edit - Option A - blocks): blocks=${blocks.length}`);
          await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessagePayload(blocks), {
            message_thread_id: messageThreadId,
          });
          logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (edit blocks) success for draftId=${draftId}.`);
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option A (blocks) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option B: Rich HTML
      try {
        let html = getHtmlPayload(originalText, isStreaming);
        if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
          html = '正在思考...<br><br>' + html;
        }

        const hasThought = typeof originalText === 'string'
          ? (originalText.includes('<thought-gemini') || originalText.includes('<thought') || originalText.includes('<thinking'))
          : (!!originalText.thought && originalText.thought.trim().length > 0);

        const suffix = (isStreaming && !hasThought)
          ? '\n<tg-thinking>正在思考...</tg-thinking>'
          : '';

        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (edit - Option B, isStreaming=${isStreaming}): html="${html}${suffix}"`);
        await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessageHtmlPayload(`${html}${suffix}`), {
          message_thread_id: messageThreadId,
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (edit HTML) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option B (HTML) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option C: Rich Markdown fallback
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (edit - Option C - Markdown): markdown="${safeMarkdown}"`);
        await ctx.api.sendRichMessageDraft(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown), {
          message_thread_id: messageThreadId,
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (edit Markdown) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option C (Markdown) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
        throw err;
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

        // Throttle draft calls
        await throttleDraft(chatId);

        if (!validateBlocksPayload(blocks)) {
          logger.warn(`[BLOCK VALIDATION] sendRichDraftBlocks payload failed validation`);
          throw new Error('Block payload validation failed');
        }
        await ctx.api.sendRichMessageDraft(chatId, targetDraftId, buildRichMessagePayload(blocks as RichBlock[]), {
          message_thread_id: messageThreadId,
        });
        return targetDraftId;
      } catch (err: any) {
        logger.warn(`sendRichDraftBlocks failed for draftId=${draftId}: ${err.message || err}`);
        throw err;
      }
    },
    editRichBlocks: async (messageId: number, blocks: unknown[]): Promise<number | void> => {
      try {
        if (!validateBlocksPayload(blocks)) {
          logger.warn(`[BLOCK VALIDATION] editRichBlocks payload failed validation`);
          throw new Error('Block payload validation failed');
        }
        if (activeDraftIds.has(messageId) || draftIds.get(chatId) === messageId) {
          // Materialize draft: sendRichMessage creates a persisted message
          const res = await ctx.api.sendRichMessage(chatId, buildRichMessagePayload(blocks as RichBlock[]), {
            message_thread_id: messageThreadId,
          });
          activeDraftIds.delete(messageId);
          if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
          return res.message_id;
        }
        // Edit existing persisted message via editMessageText
        await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks as RichBlock[]));
        return messageId;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) return messageId;
        logger.warn(`editRichBlocks failed for messageId=${messageId}: ${err.message || err}`);
        throw err;
      }
    },
    editRich: async (messageId: number, originalText: string | StructuredMessage): Promise<number | void> => {
      const textLen = typeof originalText === 'string'
        ? originalText.length
        : (originalText.content.length + (originalText.thought?.length || 0));
      logger.debug(`[DEBUG] editRich called: messageId=${messageId}, originalTextLen=${textLen}`);

      const cacheMarkdown = typeof originalText === 'string'
        ? originalText
        : `${originalText.content}${originalText.thought ? `\n\n<thought>\n${originalText.thought}\n</thought>` : ''}`;

      // If we have an active draft, the messageId is actually a draftId.
      // Per Telegram Bot API, a streamed draft is an EPHEMERAL preview that is
      // NOT persisted in the chat. To keep the first message, we MUST materialize
      // it into a real message by sending the final content via sendRichMessage
      // (not another sendRichMessageDraft, which would just refresh the preview
      // and leave the first message swallowed once the draft expires). The draft
      // bubble is abandoned and cleaned up by Telegram automatically.
      if (activeDraftIds.has(messageId) || draftIds.get(chatId) === messageId) {
        logger.info(`[FINALIZE] materializing draft into a real persisted message via sendRich (was draft messageId=${messageId})`);
        activeDraftIds.delete(messageId);
        if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
        const realId = await replyObj.sendRich!(originalText);
        logger.info(`[FINALIZE] sent real message id=${realId} for chat ${chatId}; first message preserved`);
        return realId;
      }

      // Option A (10.2): Native structured blocks (final, persisted message).
      try {
        const blocks = getBlocksPayload(originalText);
        if (blocks.length > 0) {
          if (!validateBlocksPayload(blocks)) {
            logger.warn(`[BLOCK VALIDATION] editRich blocks failed validation, falling through`);
            throw new Error('Block payload validation failed');
          }
          logger.debug(`[DEBUG] editMessageText (Option A - blocks) called: messageId=${messageId}, blocks=${blocks.length}`);
          await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks));
          logger.debug(`[DEBUG] editMessageText (Option A - blocks) success: messageId=${messageId}`);
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option A (blocks) failed: ${err.message || err}. Trying Option B...`);
      }

      // Option B: Native Rich HTML
      try {
        let html = getHtmlPayload(originalText);
        if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
          html = '正在思考...<br><br>' + html;
        }
        logger.debug(`[TELEGRAM PAYLOAD] editRich originalText.length=${textLen} html.length=${html.length} containsDetails=${html.includes('<details')} containsThoughtSummary=${html.includes('🧠 思考过程') || html.includes('Thinking Process')} containsBodyTitle=${html.includes('证明') || html.includes('Proof')}`);

        logger.debug(`[DEBUG] editMessageText (Option B) called: messageId=${messageId}`);
        await ctx.api.editMessageText(chatId, messageId, buildRichMessageHtmlPayload(html));
        logger.debug(`[DEBUG] editMessageText (Option B) success: messageId=${messageId}`);
        messageCache.set(messageId, cacheMarkdown);
        return;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option B failed: ${err.message || err}. Trying Option C...`);
      }

      // Option C: Rich Markdown
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.debug(`[DEBUG] editMessageText (Option C) called: messageId=${messageId}`);
        await ctx.api.editMessageText(chatId, messageId, buildRichMessageMarkdownPayload(safeMarkdown));
        logger.debug(`[DEBUG] editMessageText (Option C) success: messageId=${messageId}`);
        messageCache.set(messageId, cacheMarkdown);
        return;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option C failed: ${err.message || err}. Trying Option D...`);
      }

      // Option D: HTML Fallback
      await safeEdit(messageId, originalText, true);
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
      } catch (e: any) {
        logger.warn(`Failed to send message in ${parseMode} mode: ${e}`);
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
        } catch (e) {
          const failures = getConsecutiveDraftFailures() + 1;
          setConsecutiveDraftFailures(failures);
          if (failures >= 2) {
            setDraftsDisabled(true);
            logger.warn(`Circuit breaker triggered: disabling rich drafts for chat ${chatId} due to consecutive failures.`);
          } else {
            logger.warn(`Failed to send rich draft stream (attempt ${failures}): ${e}`);
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
        } catch (e) {
          const failures = getConsecutiveDraftFailures() + 1;
          setConsecutiveDraftFailures(failures);
          if (failures >= 2) {
            setDraftsDisabled(true);
            logger.warn(`Circuit breaker triggered: disabling rich drafts for chat ${chatId} due to consecutive failures.`);
          } else {
            logger.warn(`Failed to edit rich draft stream (attempt ${failures}): ${e}`);
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
