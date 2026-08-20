/**
 * @file contentHandlers.ts
 * @description Telegram bot handlers for content export commands (/export, /send,
 * /history). Exports conversation history as Markdown/HTML files, sends
 * recent responses as files, and browses past model outputs from the database.
 */

import { type Bot, type Context, InputFile } from 'grammy';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { listAvailableSessions } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import type { ReplyContext } from '../../../utils/messageCache.js';
import { extractThoughtAndContent } from '../../../agy/agyCli.js';
import { ICONS, buildMainKeyboard, escapeHtml } from '../ui.js';
import { htmlToMarkdown, extractTitleFromMarkdown, saveMarkdownToAnswerSaveDir } from './helpers.js';
import { getDb } from '../../../db/index.js';
import { modelOutputs } from '../../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

export function registerContentHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('save', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const replyToMessage = ctx.message?.reply_to_message;
    let answerMarkdown = '';
    let thinkingMarkdown = '';
    let title = '';

    try {
      if (replyToMessage) {
        // Option A: Save specific replied message
        let replyContext: ReplyContext | null = messageCache.getReplyContext(replyToMessage.message_id);
        
        // If cache missed (e.g. bot restarted), try loading from database
        if (!replyContext) {
          try {
            const db = getDb();
            const record = await db.select()
              .from(modelOutputs)
              .where(
                and(
                  eq(modelOutputs.chatId, String(chatId)),
                  eq(modelOutputs.messageId, replyToMessage.message_id)
                )
              )
              .limit(1)
              .then(rows => rows[0]);
            
            if (record) {
              replyContext = {
                title: record.title || undefined,
                answerMarkdown: record.answerMarkdown,
                thinkingMarkdown: record.thinkingMarkdown || '',
              };
              // Backfill the in-memory cache so subsequent reads are instant
              messageCache.set(replyToMessage.message_id, record.answerMarkdown, replyContext);
            }
          } catch (dbErr) {
            logger.warn(`[saveCommand] Failed to retrieve from model_outputs DB: ${dbErr}`);
          }
        }

        if (replyContext) {
          answerMarkdown = replyContext.answerMarkdown;
          thinkingMarkdown = replyContext.thinkingMarkdown;
          title = replyContext.title || extractTitleFromMarkdown(answerMarkdown);
        } else {
          let textToSave = messageCache.get(replyToMessage.message_id) || replyToMessage.text || replyToMessage.caption || '';
          if (textToSave.startsWith('___RAW_HTML___')) {
            textToSave = textToSave.substring('___RAW_HTML___'.length);
          }
          if (/<[a-z][\s\S]*>/i.test(textToSave)) {
            textToSave = htmlToMarkdown(textToSave);
          }
          const parsed = extractThoughtAndContent(textToSave);
          answerMarkdown = parsed.content;
          thinkingMarkdown = parsed.thought;
          title = extractTitleFromMarkdown(answerMarkdown);
        }
      } else {
        // Option B: Auto-save latest AI response in session
        let lastContext: ReplyContext | null = messageCache.getLastReplyContextForChat(chatId);
        if (!lastContext) {
          // If cache missed, try loading the most recent output from database for this chat
          try {
            const db = getDb();
            const record = await db.select()
              .from(modelOutputs)
              .where(eq(modelOutputs.chatId, String(chatId)))
              .orderBy(desc(modelOutputs.id))
              .limit(1)
              .then(rows => rows[0]);
            
            if (record) {
              lastContext = {
                title: record.title || undefined,
                answerMarkdown: record.answerMarkdown,
                thinkingMarkdown: record.thinkingMarkdown || '',
              };
            }
          } catch (dbErr) {
            logger.warn(`[saveCommand] Failed to retrieve latest from model_outputs DB: ${dbErr}`);
          }
        }

        if (lastContext) {
          answerMarkdown = lastContext.answerMarkdown;
          thinkingMarkdown = lastContext.thinkingMarkdown;
          title = lastContext.title || extractTitleFromMarkdown(answerMarkdown);
        }
      }

      if (!answerMarkdown.trim() && !thinkingMarkdown.trim()) {
        await ctx.reply(`${ICONS.warning} <b>No content found to save.</b>\n\nReply to a message with /save or generate an AI response first.`, { parse_mode: 'HTML' });
        return;
      }

      // Save content via shared helper (uses configured answer save dir)
      const filePath = saveMarkdownToAnswerSaveDir({ title, answerMarkdown, thinkingMarkdown });

      await ctx.reply(`${ICONS.success} <b>Saved</b>\n\nSaved successfully to:\n<code>${escapeHtml(filePath)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error saving message to notebook: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Save failed:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });

  // ── Delete Session ──
  bot.command('delete_session', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply(`${ICONS.warning} <b>Usage:</b> <code>/delete_session &lt;index&gt;</code>`, { parse_mode: 'HTML' });
      return;
    }

    const idx = parseInt(arg, 10);
    if (isNaN(idx) || idx <= 0) {
      await ctx.reply(`${ICONS.warning} <b>Please provide a valid session index from /resume.</b>`, { parse_mode: 'HTML' });
      return;
    }

    let session;
    try {
      session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
    } catch (e) {
      logger.error(`Failed to create session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Initialization failed:</b> ${e}`);
      return;
    }

    if (session.busy) {
      await ctx.reply(`${ICONS.warning} <b>Session is busy.</b>\nPlease cancel the current operation first.`, { parse_mode: 'HTML' });
      return;
    }

    try {
      const sessions = await listAvailableSessions(session.config);
      if (idx > sessions.length) {
        await ctx.reply(`${ICONS.error} <b>Session index ${idx} out of range.</b> Max is ${sessions.length}.`, { parse_mode: 'HTML' });
        return;
      }

      const target = sessions[idx - 1];
      const chatsDir = path.join(session.config!.storage.getProjectTempDir(), 'chats');
      const sessionFilePath = path.join(chatsDir, target.fileName);

      // Check if this was the active session
      const isActive = session.sessionId === target.id;

      // Delete files
      await fsPromises.unlink(sessionFilePath);

      const logsDir = path.join(session.config!.storage.getProjectTempDir(), 'logs');
      const logPath = path.join(logsDir, `session-${target.id}.jsonl`);
      try {
        await fsPromises.unlink(logPath);
      } catch {
        // Ignore if file doesn't exist
      }

      let activeResetMsg = '';
      if (isActive) {
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          model: defaultOptions.model,
        }, threadId);
        activeResetMsg = ` This was the active session, so your session has been reset and set to <code>${defaultOptions.model}</code>.`;
      }

      await ctx.reply(`${ICONS.success} <b>Session Deleted</b>\n\nDeleted session ${idx}: "${target.title}".${activeResetMsg}`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error deleting session ${idx} for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Delete failed:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });

  // ── Export Session ──
  bot.command('export', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId, threadId);
    const sessionTitle = session?.currentProject?.name || session?.sessionId?.slice(0, 8) || 'session';
    const model = session?.config?.getModel() || defaultOptions.model || 'unknown';

    try {
      const db = getDb();
      const records = db.select()
        .from(modelOutputs)
        .where(eq(modelOutputs.chatId, String(chatId)))
        .orderBy(modelOutputs.id)
        .all();

      if (records.length === 0) {
        await ctx.reply(`${ICONS.info} <b>No chat history found to export for this session.</b>`, { parse_mode: 'HTML' });
        return;
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      let md = `# 📝 Session Export - ${sessionTitle}\n\n`;
      md += `> **Date:** ${new Date().toLocaleString()}\n`;
      md += `> **Session ID:** \`${session?.sessionId || 'unknown'}\`\n`;
      md += `> **Model:** \`${model}\`\n\n---\n\n`;

      records.forEach((rec, idx) => {
        md += `### Turn ${idx + 1}\n\n`;
        if (rec.title) {
          md += `#### 📌 ${rec.title}\n\n`;
        }
        if (rec.thinkingMarkdown && rec.thinkingMarkdown.trim()) {
          md += `<details>\n<summary>🧠 Thinking Process</summary>\n\n${rec.thinkingMarkdown.trim()}\n\n</details>\n\n`;
        }
        md += `${rec.answerMarkdown.trim()}\n\n---\n\n`;
      });

      const fileName = `session-${sessionTitle}-${dateStr}.md`.replace(/[^a-zA-Z0-9._-]/g, '_');
      await ctx.replyWithDocument(new InputFile(Buffer.from(md, 'utf-8'), fileName), {
        caption: `📄 <b>Session Exported Successfully</b>\n\nContains ${records.length} assistant turns.\nModel: <code>${escapeHtml(model)}</code>`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      logger.error(`Error exporting session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Export failed:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });
}
