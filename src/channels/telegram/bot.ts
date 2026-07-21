/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Bot, Context, InputFile } from 'grammy';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { run, sequentialize } from '@grammyjs/runner';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionManager } from '../../core/session.js';
import { processMessage } from '../../core/messageLoop.js';
import { createTelegramSendMedia } from './outbound.js';
import type {
  ChannelReply,
  SessionOptions,
  DaemonSession,
  MultimodalInput,
  StructuredMessage,
} from '../../core/types.js';
import type { InputRichMessage } from '@grammyjs/types/rich.js';
import type { RichBlock } from './richMessage.js';
import { registerCommands } from './commands.js';
import { telegramFormatter, markdownToHtml, markdownToMarkdownV2, buildFinalBlocks, buildStreamingBlocks, buildFooterBlocksFromHtml, splitRichBlocks, TELEGRAM_RICH_MAX_LENGTH } from './formatter.js';
import { logger } from '../../utils/logger.js';
import { ICONS, formatWelcome, buildMainKeyboard } from './ui.js';
import { messageCache } from '../../utils/messageCache.js';

const TYPING_KEEPALIVE_MS = 3000;
const escapeHtml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Typed Rich API helpers ──

function buildRichMessagePayload(blocks: RichBlock[]): InputRichMessage<never> {
  return { blocks };
}

function buildRichMessageHtmlPayload(html: string): InputRichMessage<never> {
  return { html };
}

function buildRichMessageMarkdownPayload(markdown: string): InputRichMessage<never> {
  return { markdown };
}

// ── Draft throttle (minimum interval between draft updates) ──

const draftThrottleTimestamps = new Map<number, number>();
const draftBackoffUntil = new Map<number, number>();
const draftBackoffMultiplier = new Map<number, number>();
const DRAFT_THROTTLE_MS = 250;

export function record429Backoff(chatId: number, retryAfterSec?: number): void {
  const mult = Math.min((draftBackoffMultiplier.get(chatId) ?? 1) * 2, 8);
  draftBackoffMultiplier.set(chatId, mult);

  const baseWait = retryAfterSec ? retryAfterSec * 1000 : 1000;
  const waitMs = baseWait * mult + 100;
  const existingUntil = draftBackoffUntil.get(chatId) ?? 0;
  const nextUntil = Math.max(existingUntil, Date.now() + waitMs);
  draftBackoffUntil.set(chatId, nextUntil);
  logger.warn(`[429 BACKOFF] Dynamic rate-limit backoff set for chatId=${chatId}: wait ${waitMs}ms (mult=${mult})`);
}

export function reset429Backoff(chatId: number): void {
  draftBackoffMultiplier.delete(chatId);
  draftBackoffUntil.delete(chatId);
}

export function is429Error(err: any): boolean {
  if (!err) return false;
  if (err.error_code === 429 || err.status === 429) return true;
  if (err.parameters?.retry_after !== undefined) return true;
  if (err.payload?.parameters?.retry_after !== undefined) return true;
  const msg = String(err.message || err);
  return msg.includes('429') || msg.includes('Too Many Requests');
}

export function get429RetryAfter(err: any): number | undefined {
  if (typeof err?.parameters?.retry_after === 'number') return err.parameters.retry_after;
  if (typeof err?.payload?.parameters?.retry_after === 'number') return err.payload.parameters.retry_after;
  return undefined;
}

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
const TYPING_TTL_MS = 3_600_000; // Safety: auto-stop typing after 1 hour
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_MS = 1000;
const MAX_MESSAGE_PROCESSING_MS = 960_000; // 16 min watchdog; >= hard run cap so model-timeout fires first. busySince is refreshed on each streamed event.
const HEALTH_CHECK_INTERVAL_MS = 60_000; // Check every minute

export interface TelegramBotOptions {
  allowedUsers?: number[];
  model?: string;
  cwd?: string;
  proxy?: string;
}

/**
 * Returns a sequentialize key for grammY's runner.
 *
 * Regular messages get keyed by chatId, so they're processed serially per chat.
 * /cancel gets a separate key (`control:${chatId}`) so it runs concurrently
 * with the in-progress message handler — otherwise it would be queued behind it.
 * Callback queries are bypass-sequentialized (returns undefined) so they respond immediately.
 */
function getSequentialKey(ctx: any): string | undefined {
  if (ctx.callbackQuery) {
    return undefined;
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return undefined;
  const text = ctx.message?.text ?? '';
  if (text.startsWith('/cancel')) {
    return `control:${chatId}`;
  }
  return `chat:${chatId}`;
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

/**
 * Gracefully kill any hung child process and reset the busy state of a stuck session.
 */
function resetStuckSession(session: DaemonSession, reason: string): void {
  logger.warn(`Resetting stuck session (childPid=${session.childPid ?? 'none'}): ${reason}`);
  if (session.childPid !== undefined) {
    try {
      process.kill(session.childPid, 'SIGKILL');
      logger.info(`Stuck session cleanup: sent SIGKILL to agy pid ${session.childPid}`);
    } catch (killErr) {
      logger.warn(`Stuck session cleanup: failed to kill pid ${session.childPid}: ${killErr}`);
    }
  }
  session.abortController.abort(reason);
  session.abortController = new AbortController();
  session.busy = false;
  session._busySince = undefined;
  session.childPid = undefined;
}

/**
 * Wrap a handler with session acquisition, typing indicator, and cleanup.
 */
async function withSession(
  sessionManager: SessionManager,
  ctx: Context,
  defaultOptions: SessionOptions,
  handler: (session: DaemonSession, channelReply: ChannelReply) => Promise<void>,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  let session;
  try {
    session = await sessionManager.getOrCreate(chatId, defaultOptions);
  } catch (e) {
    logger.error(`Failed to create session for chat ${chatId}: ${e}`);
    await ctx.reply(`${ICONS.error} Failed to initialize session: ${e}`);
    return;
  }

  // Check if session appears stuck (busy for too long)
  if (session.busy) {
    const now = Date.now();
    const busySince = session._busySince;
    if (busySince && now - busySince > MAX_MESSAGE_PROCESSING_MS) {
      resetStuckSession(session, 'Session timeout (stuck)');
      try {
        await ctx.reply(`${ICONS.warning} Previous operation timed out and was cancelled. Please try again.`);
      } catch { /* ignore */ }
      return;
    }
    
    await ctx.reply(
      `${ICONS.warning} Still processing your previous message. Use /cancel to abort it.`,
    );
    return;
  }

  // Ensure we have a fresh abort controller if the previous one was aborted
  if (session.abortController.signal.aborted) {
    logger.debug(`Session for chat ${chatId} had an aborted signal. Resetting abort controller.`);
    session.abortController = new AbortController();
  }

  session.busy = true;
  (session as { _busySince?: number })._busySince = Date.now();

  // Reset circuit breaker for rich drafts on each new user-initiated session interaction
  if (session.draftsDisabled || (session.consecutiveDraftFailures && session.consecutiveDraftFailures > 0)) {
    logger.info(`Resetting drafts circuit breaker for chat ${chatId} as a new user message session has started.`);
    session.draftsDisabled = false;
    session.consecutiveDraftFailures = 0;
  }

  session.typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, TYPING_KEEPALIVE_MS);
  ctx.replyWithChatAction('typing').catch(() => {});

  const typingTtl = setTimeout(() => {
    logger.warn(
      `Chat ${chatId}: typing TTL exceeded (${TYPING_TTL_MS}ms), auto-clearing`,
    );
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = undefined;
    }
  }, TYPING_TTL_MS);

  const parseMode = session.settings?.telegram?.parseMode || 'RichText';
  try {
    await handler(session, buildChannelReply(ctx, chatId, parseMode, session));
  } catch (e) {
    logger.error(`Error in handler for chat ${chatId}: ${e}`);
    try {
      await ctx.reply(
        `${ICONS.error} <b>Operation failed:</b>\n<i>${e instanceof Error ? e.message : String(e)}</i>`,
        { parse_mode: 'HTML' }
      );
    } catch {
      // ignore reply failures
    }
  } finally {
    clearTimeout(typingTtl);
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = undefined;
    }
    session.busy = false;
    (session as { _busySince?: number })._busySince = undefined;
  }
}

/**
 * Download a file from Telegram with retry + exponential backoff.
 * Uses ctx.api.token instead of env var so --token flag works.
 */
async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  proxyAgent?: ProxyAgent,
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram file_path not found.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await undiciFetch(fileUrl, {
        dispatcher: proxyAgent,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const tempDir = path.join(os.tmpdir(), 'gemini-cli-telegram-media');
      await fs.mkdir(tempDir, { recursive: true });

      // Use unique filename to avoid collisions from concurrent downloads
      const ext = path.extname(file.file_path) || '';
      const localFilePath = path.join(
        tempDir,
        `${crypto.randomUUID()}${ext}`,
      );

      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(localFilePath, Buffer.from(arrayBuffer));

      return localFilePath;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        const delay = DOWNLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `File download attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(
    `Failed to download file after ${DOWNLOAD_MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}

/** Supported Telegram media types for extraction. */
type TelegramMediaType = 'photo' | 'voice' | 'audio' | 'video' | 'document';

/** Extracted info from a Telegram media message. */
interface TelegramMediaInfo {
  fileId: string;
  mimeType: string;
  caption?: string;
  fileName?: string;
}

/**
 * Extract file ID, MIME type, and optional file name from a Telegram media message.
 */
function extractMediaInfo(
  ctx: Context,
  mediaType: TelegramMediaType,
): TelegramMediaInfo | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = ctx.message as any;
  if (!msg) return undefined;
  const caption = msg.caption as string | undefined;

  if (mediaType === 'photo') {
    const photos = msg.photo as { file_id: string }[] | undefined;
    if (!photos || photos.length === 0) return undefined;
    const photo = photos[photos.length - 1];
    if (!photo) return undefined;
    return { fileId: photo.file_id, mimeType: 'image/jpeg', caption };
  } else if (mediaType === 'voice') {
    const voice = msg.voice as { file_id: string; mime_type?: string } | undefined;
    if (!voice) return undefined;
    return { fileId: voice.file_id, mimeType: voice.mime_type || 'audio/ogg', caption };
  } else if (mediaType === 'audio') {
    const audio = msg.audio as { file_id: string; mime_type?: string; file_name?: string } | undefined;
    if (!audio) return undefined;
    return { fileId: audio.file_id, mimeType: audio.mime_type || 'audio/mpeg', caption, fileName: audio.file_name };
  } else if (mediaType === 'video') {
    const video = msg.video as { file_id: string; mime_type?: string; file_name?: string } | undefined;
    if (!video) return undefined;
    return { fileId: video.file_id, mimeType: video.mime_type || 'video/mp4', caption, fileName: video.file_name };
  } else if (mediaType === 'document') {
    const doc = msg.document as { file_id: string; mime_type?: string; file_name?: string } | undefined;
    if (!doc) return undefined;
    return { fileId: doc.file_id, mimeType: doc.mime_type || 'application/octet-stream', caption, fileName: doc.file_name };
  }
  return undefined;
}

export class TelegramBot {
  private bot: Bot;
  private runner: ReturnType<typeof run> | undefined;
  private sessionManager: SessionManager;
  private defaultOptions: SessionOptions;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private proxyAgent: ProxyAgent | undefined;

  constructor(token: string, options: TelegramBotOptions = {}) {
    const clientConfig: any = {};
    if (options.proxy) {
      this.proxyAgent = new ProxyAgent(options.proxy);
      clientConfig.baseFetchConfig = {
        dispatcher: this.proxyAgent,
        compress: true,
      };
      clientConfig.fetch = async (url: any, init: any) => {
        const cleanInit = init ? { ...init } : {};
        delete cleanInit.signal;
        // Retry transient proxy/network failures so a dropped long-poll
        // connection recovers instead of stalling update delivery.
        let lastErr: any;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await undiciFetch(url, {
              ...cleanInit,
              dispatcher: this.proxyAgent,
            });
          } catch (e: any) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
        throw lastErr;
      };
    }
    this.bot = new Bot(token, { client: clientConfig });
    this.sessionManager = new SessionManager(
      (chatId) => createTelegramSendMedia(this.bot.api, chatId, token, options.proxy),
    );
    this.defaultOptions = {
      cwd: options.cwd || process.cwd(),
      model: options.model,
      proxy: options.proxy,
    };

    this.setupMiddleware(options.allowedUsers);
    registerCommands(
      this.bot,
      this.sessionManager,
      this.defaultOptions,
      async (session, ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        const parseMode = session.settings?.telegram?.parseMode || 'RichText';
        await this.handleAutopilot(session, buildChannelReply(ctx, chatId, parseMode, session), ctx);
      },
    );
    this.setupMessageHandler();
    this.setupScheduler();
  }

  private setupScheduler(): void {
    const scheduler = this.sessionManager.getChatScheduler();
    scheduler.initialize(async (task) => {
      const chatId = task.chatId;
      logger.info(`Executing scheduled task ${task.id} for chat ${chatId}`);

      try {
        const safeEdit = async (messageId: number, text: string, html = true) => {
          try {
            const final = text.startsWith('___RAW_HTML___') ? text.substring('___RAW_HTML___'.length) : text;
            await this.bot.api.editMessageText(chatId, messageId, final, html ? { parse_mode: 'HTML' } : {});
          } catch (e: any) {
            if (!e?.description?.includes('message is not modified')) {
              logger.warn(`Scheduler failed to edit message ${messageId}: ${e}`);
            }
          }
        };

        // Build a custom ChannelReply for scheduled messages
        const scheduledReply: ChannelReply = {
          send: async (text: string): Promise<number> => {
            const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
            return msg.message_id;
          },
          edit: async (messageId: number, newText: string): Promise<void> => {
            await safeEdit(messageId, newText, true);
          },
          sendPlain: async (text: string): Promise<number> => {
            const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
            return msg.message_id;
          },
          editPlain: async (messageId: number, newText: string): Promise<void> => {
            await safeEdit(messageId, newText, false);
          },
          sendDocument: async (filePath: string, caption?: string): Promise<void> => {
            await this.bot.api.sendMessage(chatId, caption || 'Document: ' + filePath);
          },
          delete: async (messageId: number): Promise<void> => {
            await this.bot.api.deleteMessage(chatId, messageId);
          },
          sendRich: async (text: string | StructuredMessage): Promise<number> => {
            return await scheduledReply.send(typeof text === 'string' ? text : getHtmlPayload(text));
          },
          sendRichDraft: async (text: string | StructuredMessage): Promise<number> => {
            return await scheduledReply.send(typeof text === 'string' ? text : getHtmlPayload(text));
          },
          editRich: async (messageId: number, newText: string | StructuredMessage): Promise<void> => {
            await scheduledReply.edit(messageId, typeof newText === 'string' ? newText : getHtmlPayload(newText));
          },
          editRichDraft: async (draftId: number, newText: string | StructuredMessage): Promise<void> => {
            await scheduledReply.edit(draftId, typeof newText === 'string' ? newText : getHtmlPayload(newText));
          },
        };

        const session = await this.sessionManager.getOrCreate(chatId, this.defaultOptions);
        if (session.busy) {
          const msg = `Session busy for chat ${chatId}, skipping scheduled task ${task.id}`;
          logger.warn(msg);
          throw new Error('Session is currently busy with another operation.');
        }

        session.busy = true;
        try {
          await processMessage(
            session,
            { text: task.message },
            scheduledReply,
            telegramFormatter,
          );
        } finally {
          session.busy = false;
        }
      } catch (e) {
        logger.error(`Scheduled task execution failed: ${e}`);
        try {
          await this.bot.api.sendMessage(chatId, `${ICONS.error} Scheduled task failed: ${e instanceof Error ? e.message : String(e)}`);
        } catch { /* ignore */ }
      }
    }).catch(e => logger.error(`Failed to initialize scheduler: ${e}`));
  }

  async start(): Promise<void> {
    logger.info('Starting Telegram bot...');

    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Start the bot with welcome menu' },
      { command: 'new', description: 'Start a fresh session' },
      { command: 'model', description: 'Switch model (starts new session)' },
      { command: 'status', description: 'Show session statistics' },
      { command: 'save', description: 'Save formatted response to inbox' },
      { command: 'resume', description: 'List or resume a previous session' },
      { command: 'cancel', description: 'Cancel current operation' },
      { command: 'projects', description: 'Browse and select projects' },
      { command: 'schedule', description: 'Schedule a message' },
      { command: 'autopilot', description: 'Auto-reply until goal achieved' },
      { command: 'addfolder', description: 'Add a folder for read+write access' },
      { command: 'id', description: 'Show current session ID' },
      { command: 'help', description: 'Show help message' },
    ]);

    logger.info('Telegram bot started. Listening for messages...');

    this.startHealthCheck();

    // Use @grammyjs/runner for concurrent update processing.
    // This allows /cancel to run even while a message handler is busy.
    this.runner = run(this.bot, {
      runner: {
        // Shorter long-poll timeout so the proxy can't silently kill an idle
        // 30s connection (which caused updates to pile up and redeliver late).
        fetch: { timeout: 10 },
        silent: true,
      },
    });

    // runner.task() resolves when the runner stops (via runner.stop())
    await this.runner.task();
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot...');
    this.stopHealthCheck();
    await this.sessionManager.destroyAll();
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
    logger.info('Telegram bot stopped.');
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      void this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    logger.debug('Health check started');
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.debug('Health check stopped');
    }
  }

  private async performHealthCheck(): Promise<void> {
    try {
      if (!this.runner?.isRunning()) {
        logger.warn('Runner appears to have stopped. Attempting restart...');
        try {
          this.runner = run(this.bot, {
            runner: {
              fetch: { timeout: 30 },
              silent: true,
            },
          });
          logger.info('Runner restarted successfully');
        } catch (e) {
          logger.error(`Failed to restart runner: ${e}`);
        }
      }

      const sessions = (this.sessionManager as unknown as { sessions?: Map<number, DaemonSession> }).sessions;
      if (sessions) {
        for (const [, session] of sessions) {
          if (session.busy) {
            const busySince = session._busySince;
            if (busySince && Date.now() - busySince > MAX_MESSAGE_PROCESSING_MS) {
              resetStuckSession(session, 'Health check: session stuck');
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Health check failed: ${e}`);
    }
  }

  private setupMiddleware(allowedUsers?: number[]): void {
    // Diagnostic logging middleware to track update latency
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      const updateId = ctx.update.update_id;
      const message = ctx.message || ctx.editedMessage || ctx.callbackQuery?.message;
      const msgDate = message?.date ? message.date * 1000 : null;
      const dateDiff = msgDate ? (start - msgDate) / 1000 : null;
      
      logger.info(`[Update ${updateId}] Received update. Message date: ${msgDate ? new Date(msgDate).toISOString() : 'N/A'}. Delay from sending: ${dateDiff !== null ? dateDiff.toFixed(2) + 's' : 'N/A'}`);
      
      try {
        await next();
      } finally {
        const duration = Date.now() - start;
        logger.info(`[Update ${updateId}] Processed in ${duration}ms`);
      }
    });

    // Sequentialize: messages in the same chat run serially,
    // but /cancel gets its own key so it bypasses the queue.
    this.bot.use(sequentialize(getSequentialKey));

    if (allowedUsers && allowedUsers.length > 0) {
      const allowedSet = new Set(allowedUsers);
      this.bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId || !allowedSet.has(userId)) {
          logger.warn(`Unauthorized access attempt from user ${userId}`);
          await ctx.reply(
            `${ICONS.error} Unauthorized. Your user ID is not in the allowed list.`,
          );
          return;
        }
        await next();
      });
      logger.info(
        `Access restricted to ${allowedUsers.length} user(s): ${allowedUsers.join(', ')}`,
      );
    } else {
      logger.warn(
        'No allowed users configured. Bot is accessible to everyone.',
      );
    }
  }

  private setupMessageHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) return;

      // Send a welcome message for first-time users
      const chatId = ctx.chat?.id;
      if (chatId) {
        const session = this.sessionManager.getSession(chatId);
        if (!session) {
          // First message - show welcome with keyboard
          const userName = ctx.from?.first_name;
          await ctx.reply(formatWelcome(userName), {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
        }
      }

      await this.processUserMessage(ctx, { text });
    });

    this.bot.on('message:photo', async (ctx) => {
      await this.handleMediaMessage(ctx, 'photo');
    });

    this.bot.on('message:voice', async (ctx) => {
      await this.handleMediaMessage(ctx, 'voice');
    });

    this.bot.on('message:audio', async (ctx) => {
      await this.handleMediaMessage(ctx, 'audio');
    });

    this.bot.on('message:video', async (ctx) => {
      await this.handleMediaMessage(ctx, 'video');
    });

    this.bot.on('message:document', async (ctx) => {
      await this.handleMediaMessage(ctx, 'document');
    });

    this.bot.catch((err) => {
      logger.error(`Bot error: ${err.message}`);
    });
  }

  private async processUserMessage(
    ctx: Context,
    input: MultimodalInput,
  ): Promise<void> {
    await withSession(
      this.sessionManager,
      ctx,
      this.defaultOptions,
      async (session, channelReply) => {
        await processMessage(
          session,
          input,
          channelReply,
          telegramFormatter,
        );

        // Handle autopilot / self-reply until
        await this.handleAutopilot(session, channelReply, ctx);
      },
    );
  }

  private async handleAutopilot(
    session: DaemonSession,
    channelReply: ChannelReply,
    ctx: Context,
  ): Promise<void> {
    while (session.autopilot?.active) {
      const autopilot = session.autopilot;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      // Increment iteration
      autopilot.currentIteration++;

      // Check timeout condition
      const startTime = autopilot.startTime || Date.now();
      const timeoutMs = autopilot.timeoutMs || 30 * 60 * 1000;
      if (Date.now() - startTime >= timeoutMs) {
        await channelReply.send(`${ICONS.warning} <b>Autopilot Timed Out</b>\nExceeded maximum execution time limit (30 minutes). Pausing autopilot.`);
        autopilot.active = false;
        return;
      }

      // Build the self-reply prompt
      const selfReplyText = [
        `<system>`,
        `You are in autopilot mode. Current Goal: "${autopilot.goal}"`,
        `Step Count: ${autopilot.currentIteration}`,
        `Instructions:`,
        `1. Provide full, detailed answers and complete output for this step. Do NOT truncate or abbreviate your response.`,
        `2. If you have completely fulfilled the overall goal, provide your full report/answer first, then output "AUTOPILOT_COMPLETE: <summary>" on a new line at the very end.`,
        `3. If blocked or unable to proceed, output "AUTOPILOT_STOP: <reason>" on a new line at the end.`,
        `4. Otherwise, state your findings and continue to the next step.`,
        `</system>`,
      ].join('\n');

      // Small delay between iterations
      await new Promise((r) => setTimeout(r, 2000));

      // Check if user cancelled during delay
      if (!session.autopilot?.active) return;

      try {
        // Record current cache state before iteration
        const prevContext = messageCache.getLastReplyContext();

        await processMessage(
          session,
          { text: selfReplyText },
          channelReply,
          telegramFormatter,
        );

        // Fetch fresh context after this iteration
        const currentContext = messageCache.getLastReplyContext();
        if (currentContext && currentContext !== prevContext) {
          const fullText = currentContext.answerMarkdown;
          if (fullText.includes('AUTOPILOT_COMPLETE') || fullText.includes('AUTOPILOT_STOP')) {
            const isComplete = fullText.includes('AUTOPILOT_COMPLETE');
            const signalTag = isComplete ? 'AUTOPILOT_COMPLETE' : 'AUTOPILOT_STOP';
            const summaryMatch = fullText.split(signalTag)[1]?.trim().split('\n')[0] || 'Task finished.';

            autopilot.active = false;
            // Send additional completion banner AFTER the full AI response has already been displayed
            await channelReply.send(
              isComplete
                ? `${ICONS.success} <b>Autopilot Completed Goal</b>\n\n<b>Summary:</b> <i>${escapeHtml(summaryMatch)}</i>`
                : `${ICONS.warning} <b>Autopilot Stopped</b>\n\n<b>Reason:</b> <i>${escapeHtml(summaryMatch)}</i>`,
            );
            return;
          }
        }
      } catch (e) {
        logger.error(`Autopilot iteration failed: ${e}`);
        autopilot.active = false;
        await channelReply.send(`${ICONS.error} <b>Autopilot stopped</b> — error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
  }

  private async handleMediaMessage(
    ctx: Context,
    mediaType: TelegramMediaType,
  ): Promise<void> {
    const info = extractMediaInfo(ctx, mediaType);
    if (!info) {
      await ctx.reply(`${ICONS.error} Could not retrieve ${mediaType} file info.`);
      return;
    }

    let tempFilePath: string | undefined;

    await withSession(
      this.sessionManager,
      ctx,
      this.defaultOptions,
      async (session, channelReply) => {
        tempFilePath = await downloadTelegramFile(ctx, info.fileId, this.proxyAgent);

        const multimodalInput: MultimodalInput = {
          text: info.caption,
          media: [
            {
              type: mediaType,
              path: tempFilePath,
              mimeType: info.mimeType,
              fileName: info.fileName,
            },
          ],
        };

        try {
          await processMessage(
            session,
            multimodalInput,
            channelReply,
            telegramFormatter,
          );
        } finally {
          if (tempFilePath) {
            await fs
              .unlink(tempFilePath)
              .catch((e) =>
                logger.warn(`Failed to delete temp file: ${e}`),
              );
          }
        }
      },
    );
  }
}
