import type { Bot, Context } from 'grammy';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions} from '../../../core/types.js';
import { listAvailableSessions } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import type { ReplyContext } from '../../../utils/messageCache.js';
import { extractThoughtAndContent } from '../../../agy/agyCli.js';
import { loadUserConfig, getNotebookPath } from '../../../config/userConfig.js';
import { ICONS, buildMainKeyboard, escapeHtml } from '../ui.js';
import { htmlToMarkdown, extractTitleFromMarkdown } from './helpers.js';

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
        const replyContext: ReplyContext | null = messageCache.getReplyContext(replyToMessage.message_id);
        if (replyContext) {
          answerMarkdown = replyContext.answerMarkdown;
          thinkingMarkdown = replyContext.thinkingMarkdown;
          title = replyContext.title || extractTitleFromMarkdown(answerMarkdown);
        } else {
          let textToSave = messageCache.get(replyToMessage.message_id) || replyToMessage.text || '';
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
        const lastContext = messageCache.getLastReplyContext();
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

      // Reassemble the Markdown according to the required Obsidian-friendly structure
      let reassembledMarkdown = '';
      if (title) {
        reassembledMarkdown += `# ${title}\n\n`;
      }
      reassembledMarkdown += `${answerMarkdown}\n`;

      if (thinkingMarkdown.trim()) {
        reassembledMarkdown += `\n---\n\n<details>\n<summary>🤔 AI Thinking（点击展开）</summary>\n\n${thinkingMarkdown.trim()}\n\n</details>\n`;
      }

      // Sanitize title for filename: Windows illegal characters are \/:*?"<>|
      let sanitizedTitle = title.replace(/[\/\\:*?"<>|]/g, '').trim();
      // Truncate length
      if (sanitizedTitle.length > 50) {
        sanitizedTitle = sanitizedTitle.substring(0, 50).trim();
      }
      // Replace whitespace/tabs with underscores
      sanitizedTitle = sanitizedTitle.replace(/\s+/g, '_');

      // Date prefix
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const date = String(now.getDate()).padStart(2, '0');
      const dateStr = `${year}${month}${date}`;

      let fileName = '';
      if (!sanitizedTitle) {
        const timestamp = Math.floor(Date.now() / 1000);
        fileName = `Untitled_${timestamp}.md`;
      } else {
        fileName = `${dateStr}_${sanitizedTitle}.md`;
      }

      // Resolve notebook path from user config or fallback to a default safe path
      const userConfig = loadUserConfig();
      const folderPath = userConfig?.notebookPath || getNotebookPath(userConfig);
      const filePath = path.join(folderPath, fileName);

      // Ensure directory exists
      await fsPromises.mkdir(folderPath, { recursive: true });

      // Save content
      await fsPromises.writeFile(filePath, reassembledMarkdown, 'utf8');

      await ctx.reply(`${ICONS.success} <b>Saved to Notebook</b>\n\nSaved successfully to:\n<code>${escapeHtml(filePath)}</code>`, {
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
      session = await sessionManager.getOrCreate(chatId, defaultOptions);
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
      const chatsDir = path.join(session.config.storage.getProjectTempDir(), 'chats');
      const sessionFilePath = path.join(chatsDir, target.fileName);

      // Check if this was the active session
      const isActive = session.sessionId === target.id;

      // Delete files
      await fsPromises.unlink(sessionFilePath);

      const logsDir = path.join(session.config.storage.getProjectTempDir(), 'logs');
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
          model: 'Gemini 3.6 Flash (High)',
        });
        activeResetMsg = ` This was the active session, so your session has been reset and set to <code>Gemini 3.6 Flash (High)</code>.`;
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
}
