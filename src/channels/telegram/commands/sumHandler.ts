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
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { chatMessages } from '../../../db/schema.js';
import { getDefaultModel, getSummarizationConfig } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { runModelWithFallbackChain } from './inlineHandler.js';

const SUMMARY_INSTRUCTION =
  'Summarize the following chat messages concisely and list the key points. ' +
  'Reply in the same language as the messages:\n\n';

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
        text: text.slice(0, 4000),
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    // Asynchronously trim old messages to keep database size bounded
    try {
      const config = getSummarizationConfig();
      const keepCount = Math.max(1000, (config.maxCount || 200) * 2);
      Promise.resolve().then(() => {
        trimChatMessages(msg.chat.id, keepCount);
      }).catch((e) => {
        logger.warn(`[sumHandler] Async trim execution error: ${e}`);
      });
    } catch (e) {
      logger.warn(`[sumHandler] Failed to initiate async trim: ${e}`);
    }
  } catch (e) {
    logger.warn(`[sumHandler] Failed to persist chat message: ${e}`);
  }
}

/**
 * Reads the most recent `count` messages from chat_messages for a chat,
 * oldest-first (so the summary prompt reads chronologically).
 */
export function loadRecentMessages(chatId: number, count: number): Array<{
  senderName: string;
  text: string;
}> {
  try {
    const db = getDb();
    const rows = db
      .select({
        senderName: chatMessages.senderName,
        text: chatMessages.text,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, String(chatId)))
      .orderBy(desc(chatMessages.id))
      .limit(count)
      .all()
      .reverse();
    return rows.map((r) => ({ senderName: r.senderName ?? 'Unknown', text: r.text }));
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
  _sessionManager: unknown,
  defaultOptions: { cwd?: string; proxy?: string },
): void {
  bot.command('sum', async (ctx: Context) => {
    await handleSum(ctx, defaultOptions);
  });
}

async function handleSum(
  ctx: Context,
  defaultOptions: { cwd?: string; proxy?: string },
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const config = getSummarizationConfig();
  const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const parsed = arg ? Number.parseInt(arg, 10) : config.defaultCount;
  const count = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), config.maxCount) : config.defaultCount;

  await ctx.replyWithChatAction('typing').catch(() => {});

  const messages = loadRecentMessages(chatId, count);
  if (messages.length === 0) {
    await ctx
      .reply('📋 <b>Summarize</b>\nNo messages found. /sum works in chats where the bot receives messages (enable group privacy mode off / admin rights).', {
        parse_mode: 'HTML',
      })
      .catch(() => {});
    return;
  }

  logger.info(`[sum] chatId=${chatId} requested=${count} loaded=${messages.length}`);
  const body = messages
    .map((m, i) => `[${i + 1}] ${m.senderName}: ${m.text}`)
    .join('\n');

  const model =
    config.model ||
    (defaultOptions as { model?: string }).model ||
    getDefaultModel() ||
    '';

  try {
    const { result, modelUsed } = await runModelWithFallbackChain(
      SUMMARY_INSTRUCTION + body,
      model,
      defaultOptions as any,
    );

    if (!result?.output) {
      await ctx.reply('📋 <b>Summarize failed</b>\nThe model returned no result, please retry.', { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    const cleanOutput = stripWholeMessageCodeFence(result.output).trim();
    const duration = ((result.durationMs || 1000) / 1000).toFixed(1);
    const footerParts: string[] = [`📚 ${messages.length} messages`, `⏱️ ${duration}s`];
    const inCount = result.usage?.input || 0;
    const outCount = result.usage?.output || 0;
    if (inCount) footerParts.push(`📥 In: ${inCount}`);
    if (outCount) footerParts.push(`📤 Out: ${outCount}`);

    const reply = `**📋 Chat Summary (last ${messages.length} messages)**\n\n${cleanOutput}\n\n_${footerParts.join(' · ')} (${modelUsed})_`;
    await ctx.reply(reply, { parse_mode: 'MarkdownV2' }).catch(async () => {
      await ctx.reply(reply).catch(() => {});
    });
    logger.info(`[sum] Delivered summary (${cleanOutput.length} chars) to chatId=${chatId}`);
  } catch (e) {
    logger.error(`[sum] Failed for chatId=${chatId}: ${e}`);
    await ctx.reply('📋 <b>Summarize failed</b>\nPlease try again later.', { parse_mode: 'HTML' }).catch(() => {});
  }
}
