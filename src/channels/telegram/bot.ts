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
import { registerCommands } from './commands.js';
import { telegramFormatter, markdownToHtml, markdownToMarkdownV2 } from './formatter.js';
import { logger } from '../../utils/logger.js';
import { ICONS, formatWelcome, buildMainKeyboard } from './ui.js';
import { messageCache } from '../../utils/messageCache.js';

const TYPING_KEEPALIVE_MS = 3000;

function getHtmlPayload(originalText: string | StructuredMessage, isStreaming = false): string {
  if (typeof originalText === 'string' && originalText.startsWith('___RAW_HTML___')) {
    return originalText.substring('___RAW_HTML___'.length);
  }
  return markdownToHtml(originalText, isStreaming);
}
const TYPING_TTL_MS = 3_600_000; // Safety: auto-stop typing after 1 hour
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_MS = 1000;
const MAX_MESSAGE_PROCESSING_MS = 300_000; // 5 minute timeout for message processing
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
export function getSequentialKey(ctx: any): string | undefined {
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

export function clearDraftIds(): void {
  draftIds.clear();
  activeDraftIds.clear();
}
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

      const safeMarkdown = typeof originalText === 'string'
        ? originalText
        : `${originalText.content}${originalText.thought ? `\n\n<thought>\n${originalText.thought}\n</thought>` : ''}`;

      try {
        // Option A: Native Rich HTML (Telegram parses this on the server)
        try {
          let html = getHtmlPayload(originalText);
          if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
            html = '正在思考...<br><br>' + html;
          }
          logger.debug(`[TELEGRAM PAYLOAD] sendRich originalText.length=${textLen} html.length=${html.length} containsDetails=${html.includes('<details')} containsThoughtSummary=${html.includes('🧠 思考过程') || html.includes('Thinking Process')} containsBodyTitle=${html.includes('证明') || html.includes('Proof')}`);
          const res: any = await (ctx.api.raw as any).sendRichMessage({
            chat_id: chatId,
            message_thread_id: messageThreadId,
            rich_message: { html },
          });
          messageCache.set(res.message_id, safeMarkdown);
          return res.message_id;
        } catch (err: any) {
          logger.warn(`sendRich Option A failed: ${err.message || err}. Trying Option B...`);
        }

        // Option B: Rich Markdown
        try {
          const preparedMarkdown = prepareTelegramMarkdown(safeMarkdown);
          const res: any = await (ctx.api.raw as any).sendRichMessage({
            chat_id: chatId,
            message_thread_id: messageThreadId,
            rich_message: { markdown: preparedMarkdown },
          });
          messageCache.set(res.message_id, safeMarkdown);
          return res.message_id;
        } catch (err: any) {
          logger.warn(`sendRich Option B failed: ${err.message || err}. Trying Option C...`);
        }

        // Option C: HTML Fallback
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
          logger.warn(`sendRich Option C failed: ${err.message || err}. Falling back to plain text.`);
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

      // Option A: Native Rich HTML with native thinking animation
      try {
        let html = getHtmlPayload(originalText, true);
        if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
          html = '正在思考...<br><br>' + html;
        }

        const hasThought = typeof originalText === 'string'
          ? (originalText.includes('<thought-gemini') || originalText.includes('<thought') || originalText.includes('<thinking'))
          : (!!originalText.thought && originalText.thought.trim().length > 0);

        const suffix = hasThought
          ? ''
          : '\n<tg-thinking>正在思考...</tg-thinking>';
        
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (Option A): html="${html}${suffix}"`);
        const res: any = await (ctx.api.raw as any).sendRichMessageDraft({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          draft_id: draftId,
          rich_message: { html: `${html}${suffix}` },
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (HTML) success for draftId=${draftId}. Response keys: ${Object.keys(res || {})}`);
        messageCache.set(draftId, cacheMarkdown);
        return draftId;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option A (HTML) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option B: Rich Markdown
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (Option B - Markdown): markdown="${safeMarkdown}"`);
        const res: any = await (ctx.api.raw as any).sendRichMessageDraft({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          draft_id: draftId,
          rich_message: { markdown: safeMarkdown },
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (Markdown) success for draftId=${draftId}. Response keys: ${Object.keys(res || {})}`);
        messageCache.set(draftId, cacheMarkdown);
        return draftId;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] sendRichDraft Option B (Markdown) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
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

      // Per Bot API 10.1: there is no "editRichMessageDraft" method.
      // Updating a draft is done by calling sendRichMessageDraft again with the same draft_id.
      // Option A: Rich HTML
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
        
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (edit - Option A, isStreaming=${isStreaming}): html="${html}${suffix}"`);
        await (ctx.api.raw as any).sendRichMessageDraft({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          draft_id: draftId,
          rich_message: { html: `${html}${suffix}` },
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (edit HTML) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option A (HTML) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
      }

      // Option B: Rich Markdown fallback
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.info(`[TRACE-EVIDENCE] Calling sendRichMessageDraft (edit - Option B - Markdown): markdown="${safeMarkdown}"`);
        await (ctx.api.raw as any).sendRichMessageDraft({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          draft_id: draftId,
          rich_message: { markdown: safeMarkdown },
        });
        logger.info(`[TRACE-EVIDENCE] sendRichMessageDraft (edit Markdown) success for draftId=${draftId}.`);
        messageCache.set(draftId, cacheMarkdown);
        return;
      } catch (err: any) {
        logger.info(`[TRACE-EVIDENCE] editRichDraft Option B (Markdown) failed for draftId=${draftId}: ${err.message || err}. Stack: ${err.stack}`);
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
      if (activeDraftIds.has(messageId) || draftIds.has(chatId)) {
        logger.debug(`[DEBUG] Finalizing draft messageId=${messageId} by sending a real message via sendRich`);
        activeDraftIds.delete(messageId);
        draftIds.delete(chatId);
        const realId = await replyObj.sendRich!(originalText);
        return realId;
      }

      // Option A: Native Rich HTML
      try {
        let html = getHtmlPayload(originalText);
        if (html.includes('<details') && !html.replace(/<details[\s>][\s\S]*?<\/details>/gi, '').replace(/<br\s*\/?>/gi, '').trim()) {
          html = '正在思考...<br><br>' + html;
        }
        logger.debug(`[TELEGRAM PAYLOAD] editRich originalText.length=${textLen} html.length=${html.length} containsDetails=${html.includes('<details')} containsThoughtSummary=${html.includes('🧠 思考过程') || html.includes('Thinking Process')} containsBodyTitle=${html.includes('证明') || html.includes('Proof')}`);

        logger.debug(`[DEBUG] editMessageText (Option A) called: messageId=${messageId}`);
        await (ctx.api.raw as any).editMessageText({
          chat_id: chatId,
          message_id: messageId,
          rich_message: { html },
        });
        logger.debug(`[DEBUG] editMessageText (Option A) success: messageId=${messageId}`);
        messageCache.set(messageId, cacheMarkdown);
        return;
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) {
          messageCache.set(messageId, cacheMarkdown);
          return;
        }
        logger.warn(`editRich Option A failed: ${err.message || err}. Trying Option B...`);
      }

      // Option B: Rich Markdown
      try {
        const safeMarkdown = prepareTelegramMarkdown(cacheMarkdown);
        logger.debug(`[DEBUG] editMessageText (Option B) called: messageId=${messageId}`);
        await (ctx.api.raw as any).editMessageText({
          chat_id: chatId,
          message_id: messageId,
          rich_message: { markdown: safeMarkdown },
        });
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

      // Option C: HTML Fallback
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
      clientConfig.fetch = (url: any, init: any) => {
        const cleanInit = init ? { ...init } : {};
        if (cleanInit.signal) {
          const grammySignal = cleanInit.signal;
          const nativeController = new globalThis.AbortController();
          if (grammySignal.aborted) {
            nativeController.abort();
          } else {
            grammySignal.addEventListener('abort', () => {
              nativeController.abort();
            });
          }
          cleanInit.signal = nativeController.signal;
        }
        return undiciFetch(url, {
          ...cleanInit,
          dispatcher: this.proxyAgent,
        });
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
    registerCommands(this.bot, this.sessionManager, this.defaultOptions);
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
      { command: 'cancel', description: 'Cancel current operation' },
      { command: 'projects', description: 'Browse and select projects' },
      { command: 'schedule', description: 'Schedule a message' },
      { command: 'autopilot', description: 'Auto-reply until goal achieved' },
      { command: 'resume', description: 'List or resume a previous session' },
      { command: 'save', description: 'Save formatted response to inbox' },
      { command: 'model', description: 'Switch model (starts new session)' },
      { command: 'compact', description: 'Compress chat history' },
      { command: 'addfolder', description: 'Add a folder for read+write access' },
      { command: 'status', description: 'Show session statistics' },
      { command: 'id', description: 'Show current session ID' },
      { command: 'help', description: 'Show help message' },
    ]);

    logger.info('Telegram bot started. Listening for messages...');

    this.startHealthCheck();

    // Use @grammyjs/runner for concurrent update processing.
    // This allows /cancel to run even while a message handler is busy.
    this.runner = run(this.bot, {
      runner: {
        fetch: { timeout: 30 },
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
    if (!session.autopilot?.active) return;

    const autopilot = session.autopilot;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Increment iteration
    autopilot.currentIteration++;

    // Check stop conditions
    if (autopilot.currentIteration >= autopilot.maxIterations) {
      await channelReply.send(`${ICONS.info} <b>Autopilot Paused</b>\nReached maximum iterations (${autopilot.maxIterations}).`);
      autopilot.active = false;
      return;
    }

    // Build the self-reply prompt
    const selfReplyText = [
      `<system>`,
      `You are in autopilot mode. Your goal: ${autopilot.goal}`,
      `Iteration: ${autopilot.currentIteration}/${autopilot.maxIterations}`,
      `Continue working toward the goal. If the goal is achieved, respond with "AUTOPILOT_COMPLETE: <summary>".`,
      `If you need to stop, respond with "AUTOPILOT_STOP: <reason>".`,
      `Otherwise, continue with your next step.`,
      `</system>`,
    ].join('\n');

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));

    // Check if still active after delay
    if (!session.autopilot?.active) return;

    try {
      await processMessage(
        session,
        { text: selfReplyText },
        channelReply,
        telegramFormatter,
      );

      // Check if response contained stop keywords
      // Note: We can't easily access the response text here since processMessage sends it directly
      // The autopilot will check on the next iteration based on the conversation history
    } catch (e) {
      logger.error(`Autopilot iteration failed: ${e}`);
      autopilot.active = false;
      await channelReply.send(`${ICONS.error} <b>Autopilot stopped</b> — error: ${e instanceof Error ? e.message : String(e)}`);
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
