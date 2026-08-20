/**
 * @file sumHandler.ts
 * @description /sum command — summarizes the most recent N messages in a chat.
 *
 * The Telegram Bot API cannot fetch chat history (getChatHistory is a TDLib
 * method), so this module persists every received message into the local
 * chat_messages table as they arrive (see persistChatMessage), and /sum reads
 * back the most recent N rows and asks a model to summarize them.
 */

import type { Bot, Context } from 'grammy';
import type { Message } from '@grammyjs/types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { chatMessages } from '../../../db/schema.js';
import { getDefaultModel, getSummarizationConfig } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { runModelWithFallbackChain } from './inlineHandler.js';
import { buildChannelReply } from '../bot/channelReply.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';

const SUMMARY_INSTRUCTION =
  'Summarize the following chat messages concisely and list the key points. ' +
  'Reply in the same language as the messages. ' +
  'Each message is prefixed with a number in brackets, e.g. [3]. ' +
  'When you reference a specific message, cite its number like [3] so readers can jump to the original. ' +
  'Do not add a separate "References" section at the end; the links are appended automatically after your summary.\n\n';

/**
 * Persists an incoming Telegram message into the local chat_messages table so
 * /sum can summarize recent history. Idempotent on (chat_id, message_id).
 * Only persists messages that carry text (or a media caption) and are not
 * bot commands.
 */
export function persistChatMessage(msg: Message | undefined, now = new Date().toISOString()): void {
  if (!msg?.chat?.id) return;
  const text = msg.text ?? msg.caption;
  if (!text || text.startsWith('/')) return;
  try {
    const db = getDb();
    db.insert(chatMessages)
      .values({
        chatId: String(msg.chat.id),
        messageId: msg.message_id,
        senderId: msg.from?.id ?? 0,
        senderName: msg.from?.first_name ?? msg.from?.username ?? 'Unknown',
        senderUsername: msg.from?.username ? msg.from.username.toLowerCase() : null,
        text,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    // Asynchronously trim old messages to keep database size bounded.
    // To avoid high CPU overhead and DB locking on active group chats,
    // we only execute the trim subquery with a 1% probability (roughly once every 100 messages).
    if (Math.random() < 0.01) {
      try {
        const config = getSummarizationConfig();
        const keepCount = Math.max(500, (config.maxCount || 200) * 2);
        Promise.resolve().then(() => {
          trimChatMessages(msg.chat.id, keepCount);
        }).catch((e) => {
          logger.warn(`[sumHandler] Async trim execution error: ${e}`);
        });
      } catch (e) {
        logger.warn(`[sumHandler] Failed to initiate async trim: ${e}`);
      }
    }
  } catch (e) {
    logger.warn(`[sumHandler] Failed to persist chat message: ${e}`);
  }
}

/**
 * Reads the most recent `count` messages from chat_messages for a chat,
 * oldest-first (so the summary prompt reads chronologically).
 * Supports filtering by targetUsername (case-insensitive).
 */
export function loadRecentMessages(
  chatId: number,
  count: number,
  targetUsername?: string,
): Array<{
  senderName: string;
  text: string;
  messageId: number;
}> {
  try {
    const db = getDb();
    let whereClause = eq(chatMessages.chatId, String(chatId));
    if (targetUsername) {
      whereClause = and(whereClause, eq(chatMessages.senderUsername, targetUsername.toLowerCase())) ?? whereClause;
    }

    const rows = db
      .select({
        senderName: chatMessages.senderName,
        text: chatMessages.text,
        messageId: chatMessages.messageId,
      })
      .from(chatMessages)
      .where(whereClause)
      .orderBy(desc(chatMessages.id))
      .limit(count)
      .all()
      .reverse();
    return rows.map((r) => ({
      senderName: r.senderName ?? 'Unknown',
      text: r.text,
      messageId: r.messageId,
    }));
  } catch (e) {
    logger.warn(`[sumHandler] Failed to load recent messages: ${e}`);
    return [];
  }
}

/** Removes old persisted messages beyond `maxCount` per chat (simple retention). */
export function trimChatMessages(chatId: number, keepCount: number): void {
  try {
    const db = getDb();
    db.run(sql`
      DELETE FROM chat_messages
      WHERE chat_id = ${String(chatId)}
        AND id IN (
          SELECT id FROM chat_messages
          WHERE chat_id = ${String(chatId)}
          ORDER BY id DESC
          LIMIT -1 OFFSET ${keepCount}
        )
    `);
  } catch (e) {
    logger.warn(`[sumHandler] Failed to trim chat messages: ${e}`);
  }
}

export function registerSumHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('sum', async (ctx: Context) => {
    await handleSum(ctx, sessionManager, defaultOptions);
  });
}

async function handleSum(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
  if (!chatId) return;

  const session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
  const config = getSummarizationConfig();
  const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  const { extractFirstUrl } = await import('../../../tools/urlParser/urlParser.js');
  const { handleLinkSummarizeWorkflow } = await import('./linkSummarizerHandler.js');
  const urlInArg = extractFirstUrl(arg);
  if (urlInArg) {
    await handleLinkSummarizeWorkflow(ctx, urlInArg, session.model);
    return;
  }

  let count = config.defaultCount;
  let targetUsername: string | undefined;

  // Match @username
  const usernameMatch = /@([a-zA-Z0-9_]+)/.exec(arg);
  if (usernameMatch) {
    targetUsername = usernameMatch[1];
    // Strip the username mention to parse the numeric count
    const remaining = arg.replace(usernameMatch[0], '').trim();
    if (remaining) {
      const parsed = Number.parseInt(remaining, 10);
      if (Number.isFinite(parsed)) {
        count = Math.min(Math.max(parsed, 1), config.maxCount);
      }
    }
  } else {
    if (arg) {
      const parsed = Number.parseInt(arg, 10);
      if (Number.isFinite(parsed)) {
        count = Math.min(Math.max(parsed, 1), config.maxCount);
      }
    }
  }

  await ctx.replyWithChatAction('typing').catch(() => {});

  const messages = loadRecentMessages(chatId, count, targetUsername);
  if (messages.length === 0) {
    const errorText = targetUsername
      ? `📋 <b>Summarize</b>\nNo messages found for @${targetUsername} in this chat.`
      : '📋 <b>Summarize</b>\nNo messages found. /sum works in chats where the bot receives messages (enable group privacy mode off / admin rights).';
    await ctx.reply(errorText, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  logger.info(`[sum] chatId=${chatId} targetUser=${targetUsername ?? '(all)'} requested=${count} loaded=${messages.length}`);
  // Build a clickable deep link to each original message (peer id drops the
  // leading "-100" / "-" used by Telegram channel/group numeric ids).
  const peerId = String(chatId).replace(/^-100/, '').replace(/^-/, '');
  const linkByIndex = new Map<number, string>();
  messages.forEach((m, i) => {
    linkByIndex.set(i + 1, `https://t.me/c/${peerId}/${m.messageId}`);
  });
  const body = messages
    .map((m, i) => `[${i + 1}] ${m.senderName}: ${m.text}`)
    .join('\n');

  const model =
    config.model ||
    defaultOptions.model ||
    getDefaultModel() ||
    '';

  try {
    const { result, modelUsed } = await runModelWithFallbackChain(
      SUMMARY_INSTRUCTION + body,
      model,
      defaultOptions,
    );

    if (!result?.output) {
      await ctx.reply('📋 <b>Summarize failed</b>\nThe model returned no result, please retry.', { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    const cleanOutput = stripWholeMessageCodeFence(result.output).trim();
    // Turn "[N]" citations in the model output into clickable links to the
    // original Telegram messages (https://t.me/c/<peerId>/<message_id>).
    const linkedOutput = cleanOutput.replace(
      /\[(\d+)\]/g,
      (match: string, num: string) => {
        const link = linkByIndex.get(Number(num));
        return link ? `[${num}](${link})` : match;
      },
    );
    const duration = ((result.durationMs || 1000) / 1000).toFixed(1);
    const footerParts: string[] = [`📚 ${messages.length} messages`, `⏱️ ${duration}s`];
    const inCount = result.usage?.input || 0;
    const outCount = result.usage?.output || 0;
    const cachedCount = result.usage?.cached || 0;
    const thinkingCount = result.usage?.thinking || 0;

    if (inCount > 0 || cachedCount > 0) {
      const totalIn = inCount + cachedCount;
      let inText = `📥 In: ${totalIn}`;
      if (cachedCount > 0) {
        inText += ` (Cached: ${cachedCount})`;
      }
      footerParts.push(inText);
    }
    if (outCount > 0 || thinkingCount > 0) {
      let outText = `📤 Out: ${outCount}`;
      if (thinkingCount > 0) {
        outText += ` (Reasoning: ${thinkingCount})`;
      }
      footerParts.push(outText);
    }

    const header = targetUsername
      ? `**📋 Chat Summary for @${targetUsername} (last ${messages.length} messages)**`
      : `**📋 Chat Summary (last ${messages.length} messages)**`;

    // Guaranteed clickable reference list, so links appear even if the model
    // omits "[N]" citations in the summary body.
    const references = messages
      .map((m, i) => `[${i + 1}](https://t.me/c/${peerId}/${m.messageId})`)
      .join(' · ');
    const replyMarkdown = `${header}\n\n${linkedOutput}\n\n**📎 References**\n${references}\n\n_${footerParts.join(' · ')} (${modelUsed})_`;
    const parseMode = session?.settings?.telegram?.parseMode || 'RichText';
    const replyObj = buildChannelReply(ctx, chatId, parseMode, session, ctx.message?.message_id);
    await replyObj.send(replyMarkdown);
    logger.info(`[sum] Delivered summary (${linkedOutput.length} chars) to chatId=${chatId}`);
  } catch (e) {
    logger.error(`[sum] Failed for chatId=${chatId}: ${e}`);
    await ctx.reply('📋 <b>Summarize failed</b>\nPlease try again later.', { parse_mode: 'HTML' }).catch(() => {});
  }
}
