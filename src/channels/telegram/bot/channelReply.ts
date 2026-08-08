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
import { markdownToHtml, markdownToMarkdownV2, buildFinalBlocks, buildFooterBlocksFromHtml, splitRichBlocks, TELEGRAM_RICH_MAX_LENGTH } from '../formatter.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import { draftBackoffUntil, record429Backoff, is429Error, get429RetryAfter } from './rateLimiter.js';
import type { ChannelReply, StructuredMessage, DaemonSession } from '../../../core/types.js';

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

/**
 * Streaming-safe markdown: strips any literal <thought>/<think> XML so the
 * typewriter render never shows raw tags. Body content renders as markdown;
 * while only thinking, show a short "thinking..." placeholder so the bubble
 * is never empty (mirrors the inline path, which streams raw accumulated text).
 *
 * Collapsible blocks (<details> / `> [details]` blockquotes) are collapsed to
 * their plain-text summary during streaming: the client re-renders the whole
 * message on every edit, which resets the <details> open state each time, so a
 * folded block appears "stuck" and can never be opened. Only the summary line
 * (plus a short hint) is streamed; the full folded content is restored at
 * finalize (editRich → buildFinalBlocks).
 */
function getStreamingMarkdown(text: string | StructuredMessage): string {
  const strip = (s: string) => s
    .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?thought[^>]*>/gi, '')
    .replace(/<\/?thinking[^>]*>/gi, '')
    .replace(/<\/?think[^>]*>/gi, '')
    .trim();

  // During streaming the <details> open/close tags are stripped and the folded
  // block is FLATTENED into visible content (summary bold + body markdown).
  // A real <details> can't be opened mid-stream because every editMessageText
  // re-renders and resets its open state, so we show the body inline instead of
  // a placeholder. At finalize (buildFinalBlocks) the raw text is re-parsed and
  // the blocks are restored as native collapsible details.
  // NOTE: streaming uses rich MARKDOWN mode (`sendRichMessage({ markdown })`),
  // which only understands `**bold**` / `*italic*` — not `<b>`/`<i>` HTML tags.
  const collapseDetails = (s: string) => {
    let t = s;
    // `<details>` may be unclosed mid-stream: strip the opening tag and turn
    // `<summary>...</summary>` into a bold heading. The following body lines
    // (if any) are kept verbatim so folded content is visible while streaming.
    t = t.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>/gi, (m, summaryHtml) => {
      const summary = summaryHtml.replace(/<[^>]*>/g, '').trim() || 'Details';
      return `**${summary}**\n`;
    });
    // A bare unclosed `<details>` (summary may be emitted later): drop the tag,
    // keep whatever follows.
    t = t.replace(/<details[^>]*>/gi, '\n');
    // Drop every closing tag — body content before it is preserved.
    t = t.replace(/<\/details>/gi, '');
    // A `> [details] summary` blockquote → flatten to bold summary + body lines.
    t = t.replace(/(^|\n)(?:[ \t]*> *)+\[details\]\s*([^\n]*)(?:\n(?:[ \t]*> *)[^\n]*)*/g, (m, lead, summary) => {
      const sTrim = (summary || '').trim();
      if (!sTrim) return `${lead}${m}`;
      // Keep the quoted body (indented lines) but drop the `> [details]` marker
      // and unquote the lines so they render as plain body text.
      const body = m
        .replace(/(^|\n)[ \t]*> *\[details\]\s*[^\n]*/, '')
        .replace(/(^|\n)[ \t]*> */g, '$1')
        .trim();
      return `${lead}**${sTrim}**${body ? `\n${body}` : ''}`;
    });
    // Model-native collapsible prompts: `> 点击展开...` / `> ▶ ...` / a bare
    // `[details]` line followed by a blockquote line. Flatten to bold summary.
    t = t.replace(/(^|\n)(?:[ \t]*> *)*(?:点击展开[.。…]*|Click to expand[.…]*|▶+|▼+|\[details\])[ \t]*([^\n]*)(?:\n(?:[ \t]*> *)[^\n]*)*/g, (m, lead, summary) => {
      const sTrim = (summary || '').trim();
      const body = m
        .replace(/(^|\n)(?:[ \t]*> *)*(?:点击展开[.。…]*|Click to expand[.…]*|▶+|▼+|\[details\])[ \t]*[^\n]*/, '')
        .replace(/(^|\n)[ \t]*> */g, '$1')
        .trim();
      return `${lead}${sTrim ? `**${sTrim}**` : ''}${body ? `\n${body}` : ''}`;
    });
    return t;
  };

  if (typeof text === 'string') {
    const content = collapseDetails(strip(text));
    return content || '🧠 Thinking...';
  }
  const content = collapseDetails(strip(text.content || ''));
  const thought = strip(text.thought || '');
  if (content) return content;
  if (thought) return '🧠 Thinking...';
  return '🧠 Thinking...';
}

function getHtmlPayloadWithDetails(text: string | StructuredMessage, isStreaming?: boolean): string {
  let html = getHtmlPayload(text, isStreaming);
  if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
    html = 'Thinking...<br><br>' + html;
  }
  return html;
}

const draftThrottleTimestamps = new Map<number, number>();

interface DraftThrottleState {
  currentMs: number;
  lastEditTime: number;
  lastSentLen: number;
  nextAllowedTime: number;
}
const draftThrottleStates = new Map<number, DraftThrottleState>();
const DRAFT_THROTTLE_MIN_MS = 250;
const DRAFT_THROTTLE_MAX_MS = 4000;

/**
 * Draft update pacing — adaptive version (ported from InlineQueue):
 *
 *  • Starts optimistic at DRAFT_THROTTLE_MIN_MS (250ms) for smooth typing.
 *  • On 429 the per-chat window expands (x2, floored by the server's
 *    retry-after) up to DRAFT_THROTTLE_MAX_MS, so a rate-limited chat slows
 *    itself down instead of throwing every edit and killing the stream.
 *  • On a clean success the window gradually recovers toward the minimum
 *    (x0.85), mirroring the inline path.
 *  • Skips the edit entirely when too soon AND the content grew by <15 chars
 *    (de-dup, avoids meaningless full re-edits of unchanged text).
 *  • The module-level 429 backoff (draftBackoffUntil) still overrides
 *    everything and force-waits until the retry-after window expires.
 *
 * Returns true when an edit should proceed, false when skipped (no-op).
 * A `draftThrottleMs: 0` option disables pacing entirely (tests).
 */
async function throttleDraft(chatId: number, contentLen: number, disabled = false): Promise<boolean> {
  if (disabled) return true;
  const now = Date.now();
  let st = draftThrottleStates.get(chatId);
  if (!st) {
    st = { currentMs: DRAFT_THROTTLE_MIN_MS, lastEditTime: 0, lastSentLen: -1, nextAllowedTime: 0 };
    draftThrottleStates.set(chatId, st);
  }

  // Global 429 backoff (retry-after window) overrides everything.
  const backoffUntil = draftBackoffUntil.get(chatId) ?? 0;
  if (now < backoffUntil) {
    logger.info(`[429 BACKOFF] Throttling draft update for chatId=${chatId} due to active 429 backoff (${backoffUntil - now}ms left)`);
    await new Promise(r => setTimeout(r, backoffUntil - now));
  }
  if (now < st!.nextAllowedTime) {
    await new Promise(r => setTimeout(r, st!.nextAllowedTime - now));
  }

  const elapsed = now - st!.lastEditTime;
  const textDelta = Math.abs(contentLen - st!.lastSentLen);

  // Too soon AND barely changed → skip this edit entirely (no-op).
  if (elapsed < st!.currentMs && textDelta < 15) {
    const wait = Math.max(50, st!.currentMs - elapsed);
    await new Promise(r => setTimeout(r, wait));
    return false;
  }
  // Too soon but meaningful growth → still pace to the window, then edit.
  if (elapsed < st!.currentMs) {
    await new Promise(r => setTimeout(r, st!.currentMs - elapsed));
  }
  return true;
}

function markDraftEditSuccess(chatId: number, contentLen: number): void {
  const st = draftThrottleStates.get(chatId);
  if (st) {
    st.lastEditTime = Date.now();
    st.lastSentLen = contentLen;
    // Gradually recover the throttle window toward the minimum on clean success.
    st.currentMs = Math.max(DRAFT_THROTTLE_MIN_MS, Math.floor(st.currentMs * 0.85));
  }
}

function markDraft429(chatId: number, retryAfterSec?: number): void {
  const st = draftThrottleStates.get(chatId);
  const backoffMs = (retryAfterSec ?? 1) * 1000;
  if (st) {
    st.nextAllowedTime = Date.now() + backoffMs;
    // Adaptively expand the throttle window on 429.
    st.currentMs = Math.min(DRAFT_THROTTLE_MAX_MS, Math.max(st.currentMs * 2, backoffMs));
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
        const mediaField = (b['photo'] ?? b['video'] ?? b['animation'] ?? b['audio'] ?? b['voice_note']) as Record<string, unknown> | undefined;
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
    } catch (e: any) {
      const cacheMarkdown = getCacheMarkdown(text);
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

            if (parts.length === 1) {
              // Single part: send as before
              logger.debug(`[SENDRICH] Option A: sending native blocks (count=${blocks.length})`);
              const richMessage = buildRichMessagePayload(parts[0]);
              const res = await ctx.api.sendRichMessage(chatId, richMessage, {
                message_thread_id: messageThreadId,
                reply_parameters: replyParams,
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
                reply_parameters: pIdx === 0 ? replyParams : undefined,
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
          const html = getHtmlPayloadWithDetails(originalText);
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
          const htmlText = getHtmlPayloadWithDetails(originalText);
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
      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      const thoughtPreview = typeof originalText !== 'string' ? (originalText.thought?.slice(0, 60).replace(/\n/g, '\\n') || '') : '';
      logger.info(`[TRACE-EVIDENCE] sendRichDraft called: originalTextLen=${logTextLen}, thought.len=${typeof originalText !== 'string' ? (originalText.thought?.length || 0) : 0}, thought.preview="${thoughtPreview}", first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = getCacheMarkdown(originalText);

      // Pace to avoid 429 on rapid stream updates (adaptive throttle).
      await throttleDraft(chatId, cacheMarkdown.length, draftDisabled);

      // Visible streaming: send a REAL persisted message via sendRichMessage so the
      // user's client renders the bubble, then editMessageText updates it in place.
      //
      // Performance: during the streaming phase we send RICH MARKDOWN directly
      // (Option C), skipping the expensive per-update blocks/AST parse. Parsing the
      // accumulated markdown into native 10.2 blocks on every chunk caused visible
      // stutter for long answers (same agy model streams smoothly via the inline
      // path, which edits raw markdown). Blocks are rendered only once at finalize
      // (editRich / editRichBlocks).
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
        logger.info(`[TRACE-EVIDENCE] sendRichMessage (sendRichDraft Markdown) success: real message id=${realId}.`);
        return realId;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option C (Markdown) failed: ${err.message || err}. Stack: ${err.stack}`);
        throw err;
      }
    },
    editRichDraft: async (draftId: number, originalText: string | StructuredMessage, isStreaming = true): Promise<void> => {
      const logTextLen = typeof originalText === 'string' ? originalText.length : (originalText.content.length + (originalText.thought?.length || 0));
      const logFirst100 = typeof originalText === 'string' ? originalText.slice(0, 100) : originalText.content.slice(0, 100);
      logger.info(`[TRACE-EVIDENCE] editRichDraft called: messageId=${draftId}, isStreaming=${isStreaming}, originalTextLen=${logTextLen}, first100="${logFirst100.replace(/\n/g, '\\n')}"`);

      const cacheMarkdown = getCacheMarkdown(originalText);

      // The draft is now a REAL persisted message (created by sendRichDraft via
      // sendRichMessage), so we update it in place with editMessageText for a
      // visible typewriter effect.
      //
      // Performance: during the streaming phase edit the RICH MARKDOWN directly
      // (Option C), skipping the per-update blocks/AST parse that caused visible
      // stutter (see sendRichDraft). Blocks are rendered once at finalize via
      // editRich / editRichBlocks.
      if (isStreaming) {
        const safeMarkdown = prepareTelegramMarkdown(getStreamingMarkdown(originalText));
        // Adaptive pacing: skip when too soon AND content barely changed;
        // otherwise wait out the current window then edit.
        const shouldEdit = await throttleDraft(chatId, safeMarkdown.length, draftDisabled);
        if (!shouldEdit) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        try {
          logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft streaming - Markdown)`);
          await ctx.api.editMessageText(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown));
          logger.info(`[TRACE-EVIDENCE] editMessageText (edit streaming Markdown) success for messageId=${draftId}.`);
          markDraftEditSuccess(chatId, safeMarkdown.length);
          messageCache.set(draftId, cacheMarkdown);
          return;
        } catch (err: any) {
          if (err?.description?.includes('message is not modified') || String(err).includes('message is not modified')) {
            markDraftEditSuccess(chatId, safeMarkdown.length);
            messageCache.set(draftId, cacheMarkdown);
            return;
          }
          if (is429Error(err)) {
            markDraft429(chatId, get429RetryAfter(err));
            record429Backoff(chatId, get429RetryAfter(err));
          }
          logger.info(`[TRACE-EVIDENCE] editRichDraft streaming Markdown failed for messageId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
          throw err;
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
      } catch (err: any) {
        if (err?.description?.includes('message is not modified') || String(err).includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        if (is429Error(err)) {
          record429Backoff(chatId, get429RetryAfter(err));
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option A (blocks) failed for messageId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option B: Rich HTML
      try {
        const html = getHtmlPayloadWithDetails(originalText, isStreaming);

        const hasThought = typeof originalText === 'string'
          ? (originalText.includes('<thought') || originalText.includes('<thinking'))
          : (!!originalText.thought && originalText.thought.trim().length > 0);

        const contentText = typeof originalText === 'string'
          ? originalText.replace(/<thought[^>]*>[\s\S]*?<\/thought[^>]*>/gi, '').replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, '').trim()
          : (originalText.content || '').trim();

        const suffix = (isStreaming && !hasThought && !contentText)
          ? '<br>Thinking...'
          : '';

        logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft Option B - HTML, isStreaming=${isStreaming})`);
        await ctx.api.editMessageText(chatId, draftId, buildRichMessageHtmlPayload(`${html}${suffix}`));
        logger.info(`[TRACE-EVIDENCE] editMessageText (edit HTML) success for messageId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified') || String(err).includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        if (is429Error(err)) {
          record429Backoff(chatId, get429RetryAfter(err));
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option B (HTML) failed for messageId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option C: Rich Markdown fallback
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] editMessageText (editRichDraft Option C - Markdown)`);
        await ctx.api.editMessageText(chatId, draftId, buildRichMessageMarkdownPayload(safeMarkdown));
        logger.info(`[TRACE-EVIDENCE] editMessageText (edit Markdown) success for messageId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified') || String(err).includes('message is not modified')) {
          messageCache.set(draftId, cacheMarkdown);
          return;
        }
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option C (Markdown) failed for messageId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
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
          // The "draft" is now a real persisted message; edit it in place.
          await ctx.api.editMessageText(chatId, messageId, buildRichMessagePayload(blocks as RichBlock[]));
          activeDraftIds.delete(messageId);
          if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
          return messageId;
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

      const cacheMarkdown = getCacheMarkdown(originalText);

      // The "draft" is now a REAL persisted message (created by sendRichDraft via
      // sendRichMessage), so finalization edits it in place — no second message.
      if (activeDraftIds.has(messageId) || draftIds.get(chatId) === messageId) {
        logger.info(`[FINALIZE] finalizing real streaming message in place (was messageId=${messageId})`);
        activeDraftIds.delete(messageId);
        if (draftIds.get(chatId) === messageId) draftIds.delete(chatId);
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
        const html = getHtmlPayloadWithDetails(originalText);
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
