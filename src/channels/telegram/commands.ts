/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot, Context } from 'grammy';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
function getDisplayString(model: string): string {
  const displayNames: Record<string, string> = {
    'gemini-1.5-pro': 'Gemini 1.5 Pro',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'claude-3-5-sonnet': 'Claude Sonnet 4.6 (Thinking)',
    'claude-3-opus': 'Claude Opus 4.6 (Thinking)',
  };
  return displayNames[model] || model;
}
import type { SessionManager } from '../../core/session.js';
import type { SessionOptions } from '../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../core/resume.js';
import { logger } from '../../utils/logger.js';
import { messageCache } from '../../utils/messageCache.js';
import type { ReplyContext } from '../../utils/messageCache.js';
import { extractThoughtAndContent } from '../../agy/agyCli.js';
import { loadUserConfig } from '../../config/userConfig.js';
import {
  ICONS,
  buildMainKeyboard,
  buildModelKeyboard,
  buildProjectKeyboard,
  buildResumeKeyboard,
  formatProjectInfo,
  formatSessionStats,
  formatHelp,
  formatWelcome,
  truncate,
  escapeHtml,
} from './ui.js';
import { AVAILABLE_MODELS } from '../../agy/agyCli.js';

const PROJECTS_PER_PAGE = 5;

/**
 * Register Telegram slash command handlers on the bot.
 */
export function registerCommands(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  
  // ── Start Command ──
  bot.command('start', async (ctx: Context) => {
    const userName = ctx.from?.first_name;
    const chatId = ctx.chat?.id;
    if (chatId) {
      try {
        // Ensure session exists without destroying existing history
        await sessionManager.getOrCreate(chatId, defaultOptions);
      } catch (e) {
        logger.error(`Error ensuring session for chat ${chatId} on /start: ${e}`);
      }
    }
    await ctx.reply(formatWelcome(userName), {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });

  // ── New Session ──
  bot.command('new', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const projectManager = sessionManager.getProjectManager();
      const defaultProj = projectManager.getProjects().find(p => p.name === '通用知识专家_RichText');
      await sessionManager.reset(chatId, {
        ...defaultOptions,
        project: defaultProj,
        model: 'Gemini 3.1 Pro (High)',
      });
      await ctx.reply(
        `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>Gemini 3.1 Pro (High)</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
        { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
      );
    } catch (e) {
      logger.error(`Error resetting session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Failed to reset session.</b>`);
    }
  });

  // ── Cancel ──
  bot.command('cancel', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`);
      return;
    }

    if (session.busy) {
      // Clear typing indicator immediately
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = undefined;
      }
      session.abortController.abort('User cancelled');
      session.abortController = new AbortController();
      session.busy = false;
      session.thinkingSteps = [];
      await ctx.reply(`${ICONS.cancel} <b>Operation aborted.</b>`, {
        reply_markup: buildMainKeyboard(),
      });
    } else {
      await ctx.reply(`${ICONS.info} <b>Nothing to cancel.</b>`);
    }
  });

  // ── Resume ──
  bot.command('resume', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // Ensure we have a session (needed to access config/storage paths)
    let session;
    try {
      session = await sessionManager.getOrCreate(chatId, defaultOptions);
    } catch (e) {
      logger.error(`Failed to create session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Initialization failed:</b> ${e}`);
      return;
    }

    if (session.busy) {
      await ctx.reply(
        `${ICONS.warning} <b>Session is busy.</b>\nPlease /cancel the current operation first.`,
      );
      return;
    }

    // No argument: list available sessions
    if (!arg) {
      try {
        const sessions = await listAvailableSessions(session.config);
        if (sessions.length === 0) {
          await ctx.reply(`${ICONS.info} <b>No saved sessions found.</b>`, {
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const sessionItems = sessions.slice(-10).map((s) => ({
          id: s.index.toString(),
          title: s.title,
          index: s.index,
        }));

        await ctx.reply(`${ICONS.resume} <b>Restore Session</b>\n\nChoose a previous session to resume:`, {
          parse_mode: 'HTML',
          reply_markup: buildResumeKeyboard(sessionItems),
        });
      } catch (e) {
        logger.error(`Error listing sessions for chat ${chatId}: ${e}`);
        await ctx.reply(`${ICONS.error} <b>Failed to list sessions.</b>`);
      }
      return;
    }

    // Resume the specified session
    try {
      const message = await resumeSession(session, arg);
      await ctx.reply(`${ICONS.success} <b>Session Restored</b>\n\n${message}`, {
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error resuming session for chat ${chatId}: ${e}`);
      await ctx.reply(
        `${ICONS.error} <b>Resume failed:</b> ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  // ── Model Selection ──
  bot.command('model', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      const session = sessionManager.getSession(chatId);
      const currentModel = session?.config.getModel() || 'unknown';

      const modelItems = AVAILABLE_MODELS.map((m, i) => ({
        id: (i + 1).toString(),
        display: getDisplayString(m) !== m ? `${m} — ${getDisplayString(m)}` : m,
        active: m === currentModel,
      }));

      await ctx.reply(
        `${ICONS.model} <b>Model Selection</b>\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems),
        },
      );
      return;
    }

    // Resolve number to model name
    const num = parseInt(arg, 10);
    const modelName =
      !isNaN(num) && num >= 1 && num <= AVAILABLE_MODELS.length
        ? AVAILABLE_MODELS[num - 1]
        : arg;

    try {
      const session = await sessionManager.getOrCreate(chatId, defaultOptions);
      session.config.setModel(modelName, false);
      await ctx.reply(`${ICONS.model} <b>Brain Switched</b>\n\nNow using: <code>${modelName}</code>`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error switching model for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Switch failed:</b> ${e}`);
    }
  });

  // ── Compact ──
  bot.command('compact', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`);
      return;
    }

    try {
      await session.geminiClient.tryCompressChat(
        `daemon-${session.sessionId}`,
        true,
      );
      await ctx.reply(`${ICONS.compact} <b>Context Optimized</b>\n\nI've summarized the conversation to save tokens and maintain focus.`, {
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error compacting chat for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Optimization failed.</b>`);
    }
  });

  // ── Status ──
  bot.command('status', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`, {
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    const stats = formatSessionStats({
      sessionId: session.sessionId,
      model: session.config.getModel(),
      turnCount: session.turnCount,
      createdAt: session.createdAt,
      project: session.currentProject,
      activeSessions: sessionManager.getSessionCount(),
    });

    await ctx.reply(stats, {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });

  // ── Add Folder ──
  bot.command('addfolder', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply(`${ICONS.folder} <b>Usage:</b>\n<code>/addfolder &lt;path&gt;</code>`, { parse_mode: 'HTML' });
      return;
    }

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>\nSend a message first.`);
      return;
    }

    try {
      session.config.getWorkspaceContext().addDirectory(arg);
      await ctx.reply(`${ICONS.success} <b>Folder Added</b>\n\nPath: <code>${arg}</code>\nPermissions: <b>Read + Write</b>`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      await ctx.reply(`${ICONS.error} <b>Failed to add folder:</b>\n${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });

  // ── Session ID ──
  bot.command('id', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`);
      return;
    }

    await ctx.reply(`${ICONS.session} <b>Session ID:</b>\n<code>${session.sessionId}</code>`, {
      parse_mode: 'HTML',
    });
  });

  // ── Undo ──
  bot.command('undo', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session to undo.</b>`, { parse_mode: 'HTML' });
      return;
    }

    if (session.busy) {
      await ctx.reply(`${ICONS.warning} <b>Session is busy.</b>\nPlease cancel the current operation first.`, { parse_mode: 'HTML' });
      return;
    }

    try {
      if (!session.conversationId) {
        await ctx.reply(`${ICONS.warning} <b>No conversation history found to undo.</b>`, { parse_mode: 'HTML' });
        return;
      }

      const { undoLastTurn } = await import('../../agy/historyManager.js');
      const success = undoLastTurn(session.conversationId);

      if (success) {
        await ctx.reply(`${ICONS.success} <b>Undo Successful</b>\n\nI've rolled back the last user message and the subsequent assistant response.`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      } else {
        await ctx.reply(`${ICONS.warning} <b>No undoable turns or failed to modify history in database.</b>`, { parse_mode: 'HTML' });
      }
    } catch (e) {
      logger.error(`Error performing /undo for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Undo failed:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });

function htmlToMarkdown(html: string): string {
  let md = html;

  // Convert details block (thinking process):
  md = md.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (match: string, summary: string, content: string) => {
    return `> **${summary.trim()}**\n>\n${content.trim().split('\n').map((line: string) => `> ${line}`).join('\n')}\n\n`;
  });

  // 1. Convert code blocks: <pre><code class="language-xyz">content</code></pre>
  md = md.replace(/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (match: string, lang: string, content: string) => {
    const language = lang || '';
    const cleanContent = unescapeHtmlEntities(content);
    return `\`\`\`${language}\n${cleanContent}\n\`\`\``;
  });

  // 2. Convert inline code: <code>content</code>
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, (match: string, content: string) => {
    return `\`${unescapeHtmlEntities(content)}\``;
  });

  // 3. Convert headers: <h[1-6]>content</h[1-6]>
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match: string, level: string, content: string) => {
    const hashes = '#'.repeat(Number(level));
    return `${hashes} ${content.trim()}\n\n`;
  });

  // 4. Convert bold: <b>content</b> or <strong>content</strong>
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');

  // 5. Convert italic: <i>content</i> or <em>content</em>
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');

  // 6. Convert links: <a href="url">text</a>
  md = md.replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 7. Convert list items: <li>content</li>
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '* $1\n');
  
  // Strip outer <ul> and <ol>
  md = md.replace(/<\/?ul[^>]*>/gi, '');
  md = md.replace(/<\/?ol[^>]*>/gi, '');

  // 8. Convert line breaks: <br> / <br/> / <br />
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 9. Convert paragraphs: <p>content</p>
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // 10. Convert blockquotes: <blockquote>content</blockquote>
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n');

  // 11. Clean up multiple consecutive newlines
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

function unescapeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitleFromMarkdown(answerMarkdown: string): string {
  const lines = answerMarkdown.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // 1. Try first level-1 heading: ^#\s+(.+)$
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }

  // 2. Try first level-2 heading: ^##\s+(.+)$
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) return match[1].trim();
  }

  // 3. Fallback to the first line (clean out any basic inline markdown formatting like *, _, `)
  const firstLine = lines[0].replace(/[*_`#]/g, '').trim();
  return firstLine;
}

  // ── Save message to notebook ──
  bot.command('save', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const replyToMessage = ctx.message?.reply_to_message;
    if (!replyToMessage) {
      await ctx.reply(`${ICONS.warning} <b>Please reply to a message you want to save.</b>`, { parse_mode: 'HTML' });
      return;
    }

    try {
      let answerMarkdown = '';
      let thinkingMarkdown = '';
      let title = '';

      // ReplyContext is the primary and direct source of truth
      const replyContext: ReplyContext | null = messageCache.getReplyContext(replyToMessage.message_id);
      if (replyContext) {
        answerMarkdown = replyContext.answerMarkdown;
        thinkingMarkdown = replyContext.thinkingMarkdown;
        title = replyContext.title || extractTitleFromMarkdown(answerMarkdown);
      } else {
        // Fallback for older messages / messages saved before restart
        let textToSave = messageCache.get(replyToMessage.message_id);
        if (!textToSave) {
          textToSave = replyToMessage.text || '';
        }
        if (!textToSave.trim()) {
          await ctx.reply(`${ICONS.warning} <b>The replied message has no content to save.</b>`, { parse_mode: 'HTML' });
          return;
        }

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

      if (!answerMarkdown.trim() && !thinkingMarkdown.trim()) {
        await ctx.reply(`${ICONS.warning} <b>The replied message has no content to save.</b>`, { parse_mode: 'HTML' });
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
      const folderPath = userConfig?.notebookPath || path.join(os.homedir(), '.gemini-cli-telegram', 'notebook');
      const filePath = path.join(folderPath, fileName);

      // Ensure directory exists
      await fs.mkdir(folderPath, { recursive: true });

      // Save content
      await fs.writeFile(filePath, reassembledMarkdown, 'utf8');

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
      await fs.unlink(sessionFilePath);

      const logsDir = path.join(session.config.storage.getProjectTempDir(), 'logs');
      const logPath = path.join(logsDir, `session-${target.id}.jsonl`);
      try {
        await fs.unlink(logPath);
      } catch {
        // Ignore if file doesn't exist
      }

      let activeResetMsg = '';
      if (isActive) {
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          model: 'Gemini 3.1 Pro (High)',
        });
        activeResetMsg = ` This was the active session, so your session has been reset and set to <code>Gemini 3.1 Pro (High)</code>.`;
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

  // ── Help ──
  bot.command('help', async (ctx: Context) => {
    await ctx.reply(formatHelp(), {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });

  // ── Schedule ──
  bot.command('schedule', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(' ');
    const subcommand = parts[0]?.toLowerCase();

    const scheduler = sessionManager.getChatScheduler();

    // List schedules
    if (!subcommand || subcommand === 'list') {
      const tasks = scheduler.getTasksForChat(chatId);
      if (tasks.length === 0) {
        await ctx.reply(`${ICONS.clock} <b>Schedule Manager</b>\n\nAutomate tasks by scheduling messages to be sent at specific times or intervals.\n\n<b>Commands:</b>\n• <code>/schedule add &lt;time&gt; &lt;msg&gt;</code>\n• <code>/schedule recurring &lt;min&gt; &lt;msg&gt;</code>\n• <code>/schedule list</code>\n• <code>/schedule remove &lt;id&gt;</code>\n• <code>/schedule toggle &lt;id&gt;</code>\n\n<b>Time Formats:</b>\n• <code>in 5m</code>, <code>in 1h</code>, <code>tomorrow</code>\n• <code>14:30</code>, <code>tonight</code>, <code>morning</code>\n\n<b>Example:</b>\n<code>/schedule add in 1h Check build status</code>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const lines = [
        `${ICONS.clock} <b>Active Schedules</b>`,
        '',
        ...tasks.map((t) => {
          const status = t.active ? '🟢' : '🔴';
          const nextRun = new Date(t.nextRun);
          const timeStr = nextRun.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          return `${status} <code>${t.id.slice(0, 8)}</code> — ${t.type}\n  ${ICONS.clock} ${timeStr}\n  <i>${truncate(t.message, 40)}</i>`;
        }),
        '',
        `Use <code>/schedule remove &lt;id&gt;</code> to delete.`,
      ];

      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    // Add one-time schedule
    if (subcommand === 'add') {
      const scheduleParts = arg.substring(4).trim().split(' ');
      const timeExpr = scheduleParts[0];
      const message = scheduleParts.slice(1).join(' ');

      if (!timeExpr || !message) {
        await ctx.reply(`${ICONS.warning} <b>Usage:</b>\n<code>/schedule add &lt;time&gt; &lt;message&gt;</code>`, {
          parse_mode: 'HTML',
        });
        return;
      }

      try {
        const task = await scheduler.addTask(chatId, message, 'once', timeExpr);
        const nextRun = new Date(task.nextRun);
        await ctx.reply(
          `${ICONS.success} <b>Task Scheduled</b>\n\nID: <code>${task.id.slice(0, 8)}</code>\nNext run: <b>${nextRun.toLocaleString()}</b>\nMessage: <i>${message}</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch (e) {
        await ctx.reply(`${ICONS.error} <b>Scheduling failed:</b>\n${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Add recurring schedule
    if (subcommand === 'recurring') {
      const recurringParts = arg.substring(10).trim().split(' ');
      const minutesStr = recurringParts[0];
      const message = recurringParts.slice(1).join(' ');
      const minutes = parseInt(minutesStr, 10);

      if (isNaN(minutes) || minutes < 1 || !message) {
        await ctx.reply(`${ICONS.warning} <b>Usage:</b>\n<code>/schedule recurring &lt;minutes&gt; &lt;message&gt;</code>`, {
          parse_mode: 'HTML',
        });
        return;
      }

      try {
        const task = await scheduler.addTask(chatId, message, 'recurring', `every ${minutes}m`, minutes);
        await ctx.reply(
          `${ICONS.success} <b>Recurring Task Set</b>\n\nID: <code>${task.id.slice(0, 8)}</code>\nInterval: <b>Every ${minutes}m</b>\nMessage: <i>${message}</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch (e) {
        await ctx.reply(`${ICONS.error} <b>Scheduling failed:</b>\n${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Remove schedule
    if (subcommand === 'remove') {
      const idPrefix = parts[1];
      if (!idPrefix) {
        await ctx.reply(`${ICONS.warning} Usage: <code>/schedule remove &lt;id&gt;</code>`);
        return;
      }

      // Find task by prefix
      const tasks = scheduler.getTasksForChat(chatId);
      const task = tasks.find((t) => t.id.startsWith(idPrefix));
      if (!task) {
        await ctx.reply(`${ICONS.error} Task not found. Use <code>/schedule list</code> to see task IDs.`);
        return;
      }

      const removed = await scheduler.removeTask(task.id);
      if (removed) {
        await ctx.reply(`${ICONS.success} Task <code>${idPrefix}</code> removed.`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      } else {
        await ctx.reply(`${ICONS.error} Failed to remove task.`);
      }
      return;
    }

    // Toggle schedule
    if (subcommand === 'toggle') {
      const idPrefix = parts[1];
      if (!idPrefix) {
        await ctx.reply(`${ICONS.warning} <b>Usage:</b>\n<code>/schedule toggle &lt;id&gt;</code>`, { parse_mode: 'HTML' });
        return;
      }

      const tasks = scheduler.getTasksForChat(chatId);
      const task = tasks.find((t) => t.id.startsWith(idPrefix));
      if (!task) {
        await ctx.reply(`${ICONS.error} <b>Task not found.</b>`);
        return;
      }

      const newState = await scheduler.toggleTask(task.id);
      await ctx.reply(`${ICONS.success} <b>Task ${newState ? 'Activated' : 'Paused'}</b>\n\nID: <code>${idPrefix}</code> ${newState ? '🟢' : '🔴'}`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    await ctx.reply(`${ICONS.warning} <b>Unknown subcommand:</b> <code>${subcommand}</code>\n\nAvailable: <code>list</code>, <code>add</code>, <code>recurring</code>, <code>remove</code>, <code>toggle</code>`, {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });

  // ── Autopilot ──
  bot.command('autopilot', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // Stop autopilot
    if (arg === 'stop' || arg === 'off') {
      const session = sessionManager.getSession(chatId);
      if (session?.autopilot?.active) {
        session.autopilot.active = false;
        await ctx.reply(`${ICONS.cancel} <b>Autopilot Deactivated</b>\n\nI've stopped the autonomous loop.`, {
          reply_markup: buildMainKeyboard(),
        });
      } else {
        await ctx.reply(`${ICONS.info} <b>Autopilot is not running.</b>`);
      }
      return;
    }

    // Start autopilot
    if (!arg) {
      await ctx.reply(
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nI will work autonomously by auto-replying to myself until your goal is achieved.\n\n<b>Workflow:</b>\n1️⃣ Set a clear goal\n2️⃣ I think → act → verify\n3️⃣ I repeat until done (max 10 iterations)\n4️⃣ I provide a final summary\n\n<b>Commands:</b>\n• <code>/autopilot &lt;goal&gt;</code> — Start working\n• <code>/autopilot stop</code> — Stop immediately\n\n<b>Best for:</b> Refactoring, writing tests, fixing bugs, and research.`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
      return;
    }

    const session = await sessionManager.getOrCreate(chatId, defaultOptions);

    // Set autopilot config
    session.autopilot = {
      goal: arg,
      maxIterations: 10,
      currentIteration: 0,
      active: true,
      stopKeywords: ['AUTOPILOT_COMPLETE', 'AUTOPILOT_STOP'],
    };

    await ctx.reply(
      `${ICONS.bot} <b>Autopilot Initialized</b>\n\n${ICONS.thinking} <b>Goal:</b> <i>${arg}</i>\n${ICONS.arrow} <b>Limit:</b> 10 iterations\n\n${ICONS.loading} <i>Working on the first step...</i>`,
      {
        parse_mode: 'HTML',
      },
    );

    // Trigger the first message to start the loop
    // The user's goal becomes the first prompt
    // Autopilot will handle subsequent iterations
  });

  // ── Projects ──
  bot.command('projects', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const projectManager = sessionManager.getProjectManager();
    let projects = projectManager.getProjects();

    if (projects.length === 0) {
      await ctx.reply(`${ICONS.info} <b>No projects found.</b>\n\nUse <code>/project_browse &lt;path&gt;</code> to find and add project directories.`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    const session = sessionManager.getSession(chatId);
    const currentProjectId = session?.currentProject?.id;

    await ctx.reply(
      `${ICONS.project} <b>Workspace Manager</b>\n\nSelect a project to work with:`,
      {
        parse_mode: 'HTML',
        reply_markup: buildProjectKeyboard(
          projects.slice(0, PROJECTS_PER_PAGE),
          projects.length > PROJECTS_PER_PAGE,
          0,
          currentProjectId,
        ),
      },
    );
  });

  // ── Project Select ──
  bot.command('project_select', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply(`${ICONS.warning} <b>No project ID provided.</b>`);
      return;
    }

    const projectManager = sessionManager.getProjectManager();
    const project = projectManager.getProject(arg);

    if (!project) {
      await ctx.reply(`${ICONS.error} <b>Project not found.</b>`);
      return;
    }

    try {
      // Reset session with new project
      await sessionManager.reset(chatId, {
        ...defaultOptions,
        project,
      });

      await ctx.reply(
        `${ICONS.success} <b>Workspace Switched</b>\n\n${formatProjectInfo(project)}`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
    } catch (e) {
      logger.error(`Error switching project for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Failed to switch project:</b> ${e}`);
    }
  });

  // ── Project Browse ──
  bot.command('project_browse', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const session = sessionManager.getSession(chatId);
    const baseDir = session?.config.getTargetDir() || process.cwd();
    
    let browsePath: string;
    if (!arg) {
      browsePath = os.homedir();
    } else if (arg.startsWith('~')) {
      browsePath = arg.replace(/^~(?=$|\/|\\)/, os.homedir());
    } else {
      browsePath = path.resolve(baseDir, arg);
    }

    await ctx.reply(`${ICONS.loading} <b>Scanning:</b> <code>${escapeHtml(browsePath)}</code>`, { parse_mode: 'HTML' });

    try {
      const projectManager = sessionManager.getProjectManager();
      const projects = await projectManager.scanDirectory(browsePath, 3);
      await projectManager.saveProjects();

      if (projects.length === 0) {
        await ctx.reply(`${ICONS.info} <b>No projects found</b> in <code>${browsePath}</code>.\n\nYou can use <code>/addfolder &lt;path&gt;</code> to grant manual access.`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const session = sessionManager.getSession(chatId);
      const currentProjectId = session?.currentProject?.id;

      await ctx.reply(
        `${ICONS.project} <b>Scan Complete</b>\n\nFound <b>${projects.length}</b> projects. Select one to activate:`,
        {
          parse_mode: 'HTML',
          reply_markup: buildProjectKeyboard(projects.slice(0, PROJECTS_PER_PAGE), projects.length > PROJECTS_PER_PAGE, 0, currentProjectId),
        },
      );
    } catch (e) {
      logger.error(`Error browsing directory: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Failed to browse directory.</b>`);
    }
  });

  // ── Callback Query Handler ──
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    
    if (!chatId) return;

    // Handle navigation callbacks
    if (data === '/start') {
      ctx.answerCallbackQuery('Main Menu').catch(e => logger.error(`Failed callback: ${e}`));
      await ctx.editMessageText(formatWelcome(ctx.from?.first_name), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/new') {
      ctx.answerCallbackQuery('Resetting session...').catch(e => logger.error(`Failed callback: ${e}`));
      try {
        const projectManager = sessionManager.getProjectManager();
        const defaultProj = projectManager.getProjects().find(p => p.name === '通用知识专家_RichText');
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          project: defaultProj,
          model: 'Gemini 3.1 Pro (High)',
        });
        await ctx.editMessageText(
          `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>Gemini 3.1 Pro (High)</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
          { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
        );
      } catch (e) {
        logger.error(`Failed to reset session: ${e}`);
      }
      return;
    }

    if (data === '/projects') {
      ctx.answerCallbackQuery('Loading workspaces...').catch(e => logger.error(`Failed callback: ${e}`));
      const projectManager = sessionManager.getProjectManager();
      const projects = projectManager.getProjects();

      if (projects.length === 0) {
        await ctx.editMessageText(`${ICONS.info} <b>No projects found.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const session = sessionManager.getSession(chatId);
      const currentProjectId = session?.currentProject?.id;

      await ctx.editMessageText(
        `${ICONS.project} <b>Workspace Manager</b>\n\nSelect a project to work with:`,
        {
          parse_mode: 'HTML',
          reply_markup: buildProjectKeyboard(
            projects.slice(0, PROJECTS_PER_PAGE),
            projects.length > PROJECTS_PER_PAGE,
            0,
            currentProjectId,
          ),
        },
      );
      return;
    }

    if (data === '/model') {
      ctx.answerCallbackQuery('Loading models...').catch(e => logger.error(`Failed callback: ${e}`));
      const session = sessionManager.getSession(chatId);
      const currentModel = session?.config.getModel() || 'unknown';

      const modelItems = AVAILABLE_MODELS.map((m, i) => ({
        id: (i + 1).toString(),
        display: getDisplayString(m) !== m ? `${m} — ${getDisplayString(m)}` : m,
        active: m === currentModel,
      }));

      await ctx.editMessageText(
        `${ICONS.model} <b>Model Selection</b>\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems),
        },
      );
      return;
    }

    if (data === '/resume') {
      ctx.answerCallbackQuery('Loading sessions...').catch(e => logger.error(`Failed callback: ${e}`));
      let session;
      try {
        session = await sessionManager.getOrCreate(chatId, defaultOptions);
      } catch {
        return;
      }

      try {
        const sessions = await listAvailableSessions(session.config);
        if (sessions.length === 0) {
          await ctx.editMessageText(`${ICONS.info} <b>No saved sessions found.</b>`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const sessionItems = sessions.slice(-10).map((s) => ({
          id: s.index.toString(),
          title: s.title,
          index: s.index,
        }));

        await ctx.editMessageText(
          `${ICONS.resume} <b>Restore Session</b>\n\nChoose a previous session to resume:`,
          {
            parse_mode: 'HTML',
            reply_markup: buildResumeKeyboard(sessionItems),
          },
        );
      } catch (e) {
        logger.error(`Failed to load sessions: ${e}`);
      }
      return;
    }

    if (data === '/status') {
      ctx.answerCallbackQuery('Loading status...').catch(e => logger.error(`Failed callback: ${e}`));
      const session = sessionManager.getSession(chatId);
      if (!session) {
        await ctx.editMessageText(`${ICONS.warning} <b>No active session.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const stats = formatSessionStats({
        sessionId: session.sessionId,
        model: session.config.getModel(),
        turnCount: session.turnCount,
        createdAt: session.createdAt,
        project: session.currentProject,
        activeSessions: sessionManager.getSessionCount(),
      });

      await ctx.editMessageText(stats, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/help') {
      ctx.answerCallbackQuery('Loading Help...').catch(e => logger.error(`Failed callback: ${e}`));
      await ctx.editMessageText(formatHelp(), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/project_browse') {
      ctx.answerCallbackQuery('Browsing...').catch(e => logger.error(`Failed callback: ${e}`));
      const browsePath = path.join(os.homedir(), 'Documents');
      
      // Update message to show scanning status
      await ctx.editMessageText(`${ICONS.loading} <b>Scanning:</b> <code>${escapeHtml(browsePath)}</code>`, { parse_mode: 'HTML' });

      try {
        const projectManager = sessionManager.getProjectManager();
        const projects = await projectManager.scanDirectory(browsePath, 3);
        await projectManager.saveProjects();

        if (projects.length === 0) {
          await ctx.editMessageText(`${ICONS.info} <b>No projects found</b> in <code>${escapeHtml(browsePath)}</code>.\n\nYou can use <code>/addfolder &lt;path&gt;</code> for manual access.`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const session = sessionManager.getSession(chatId);
        const currentProjectId = session?.currentProject?.id;

        await ctx.editMessageText(
          `${ICONS.project} <b>Scan Complete</b>\n\nFound <b>${projects.length}</b> projects in <code>${escapeHtml(browsePath)}</code>. Select one to activate:`,
          {
            parse_mode: 'HTML',
            reply_markup: buildProjectKeyboard(
              projects.slice(0, PROJECTS_PER_PAGE),
              projects.length > PROJECTS_PER_PAGE,
              0,
              currentProjectId,
            ),
          },
        );
      } catch (e) {
        logger.error(`Error browsing directory: ${e}`);
        await ctx.editMessageText(`${ICONS.error} <b>Failed to browse directory.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      }
      return;
    }

    if (data === '/project_scan_documents') {
      ctx.answerCallbackQuery('Scanning Documents...').catch(e => logger.error(`Failed callback: ${e}`));
      const scanPath = path.join(os.homedir(), 'Documents');
      
      // Update message to show scanning status
      await ctx.editMessageText(`${ICONS.loading} <b>Scanning:</b> <code>${escapeHtml(scanPath)}</code>`, { parse_mode: 'HTML' });

      try {
        const projectManager = sessionManager.getProjectManager();
        const projects = await projectManager.scanDirectory(scanPath, 3);
        await projectManager.saveProjects();

        if (projects.length === 0) {
          await ctx.editMessageText(`${ICONS.info} <b>No projects found</b> in <code>${escapeHtml(scanPath)}</code>.\n\nYou can use <code>/addfolder &lt;path&gt;</code> for manual access.`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const session = sessionManager.getSession(chatId);
        const currentProjectId = session?.currentProject?.id;

        await ctx.editMessageText(
          `${ICONS.project} <b>Scan Complete</b>\n\nFound <b>${projects.length}</b> projects in <code>${escapeHtml(scanPath)}</code>. Select one to activate:`,
          {
            parse_mode: 'HTML',
            reply_markup: buildProjectKeyboard(
              projects.slice(0, PROJECTS_PER_PAGE),
              projects.length > PROJECTS_PER_PAGE,
              0,
              currentProjectId,
            ),
          },
        );
      } catch (e) {
        logger.error(`Error scanning Documents: ${e}`);
        await ctx.editMessageText(`${ICONS.error} <b>Failed to scan Documents.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      }
      return;
    }

    if (data === '/schedule') {
      ctx.answerCallbackQuery('Loading Scheduler...').catch(e => logger.error(`Failed callback: ${e}`));
      const scheduler = sessionManager.getChatScheduler();
      const tasks = scheduler.getTasksForChat(chatId);

      if (tasks.length === 0) {
        await ctx.editMessageText(`${ICONS.clock} <b>Schedule Manager</b>\n\nAutomate tasks by scheduling messages to be sent at specific times or intervals.\n\n<b>Commands:</b>\n• <code>/schedule add &lt;time&gt; &lt;msg&gt;</code>\n• <code>/schedule recurring &lt;min&gt; &lt;msg&gt;</code>\n• <code>/schedule list</code>\n• <code>/schedule remove &lt;id&gt;</code>\n• <code>/schedule toggle &lt;id&gt;</code>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const lines = [
        `${ICONS.clock} <b>Active Schedules</b>`,
        '',
        ...tasks.map((t) => {
          const status = t.active ? '🟢' : '🔴';
          const nextRun = new Date(t.nextRun);
          const timeStr = nextRun.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          return `${status} <code>${t.id.slice(0, 8)}</code> — ${t.type}\n  ${ICONS.clock} ${timeStr}`;
        }),
      ];

      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/autopilot') {
      ctx.answerCallbackQuery('Autopilot Mode').catch(e => logger.error(`Failed callback: ${e}`));
      await ctx.editMessageText(
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nI will work autonomously by auto-replying to myself until your goal is achieved.\n\n<b>Workflow:</b>\n1️⃣ Set a clear goal\n2️⃣ I think → act → verify\n3️⃣ I repeat until done (max 10 iterations)\n4️⃣ I provide a final summary\n\n<b>Commands:</b>\n• <code>/autopilot &lt;goal&gt;</code> — Start working\n• <code>/autopilot stop</code> — Stop immediately`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
      return;
    }

    // Handle model selection callback
    if (data.startsWith('/model ')) {
      const modelArg = data.replace('/model ', '');
      const num = parseInt(modelArg, 10);
      const modelName =
        !isNaN(num) && num >= 1 && num <= AVAILABLE_MODELS.length
          ? AVAILABLE_MODELS[num - 1]
          : modelArg;

      ctx.answerCallbackQuery(`Brain: ${modelName}`).catch(e => logger.error(`Failed callback: ${e}`));

      try {
        const session = await sessionManager.getOrCreate(chatId, defaultOptions);
        session.config.setModel(modelName, false);
        await ctx.editMessageText(
          `${ICONS.model} <b>Brain Switched</b>\n\nNow using: <code>${modelName}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch {
        logger.error('Switch failed');
      }
      return;
    }

    // Handle project selection callback
    if (data.startsWith('/project_select ')) {
      const projectId = data.replace('/project_select ', '');
      const projectManager = sessionManager.getProjectManager();
      const project = projectManager.getProject(projectId);

      if (!project) {
        ctx.answerCallbackQuery('Project not found').catch(e => logger.error(`Failed callback: ${e}`));
        return;
      }

      ctx.answerCallbackQuery(`Workspace: ${project.name}`).catch(e => logger.error(`Failed callback: ${e}`));

      try {
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          project,
        });

        await ctx.editMessageText(
          `${ICONS.success} <b>Workspace Switched</b>\n\n${formatProjectInfo(project)}`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch {
        logger.error('Switch failed');
      }
      return;
    }

    // Handle pagination
    if (data.startsWith('/projects_page ')) {
      const page = parseInt(data.replace('/projects_page ', ''), 10);
      const projectManager = sessionManager.getProjectManager();
      const projects = projectManager.getProjects();
      const start = page * PROJECTS_PER_PAGE;
      const pageProjects = projects.slice(start, start + PROJECTS_PER_PAGE);
      const session = sessionManager.getSession(chatId);
      const currentProjectId = session?.currentProject?.id;

      ctx.answerCallbackQuery(`Page ${page + 1}`).catch(e => logger.error(`Failed callback: ${e}`));
      await ctx.editMessageText(
        `${ICONS.project} <b>Workspace Manager</b> (Page ${page + 1})\n\nSelect a project:`,
        {
          parse_mode: 'HTML',
          reply_markup: buildProjectKeyboard(
            pageProjects,
            projects.length > start + PROJECTS_PER_PAGE,
            page,
            currentProjectId,
          ),
        },
      );
      return;
    }

    ctx.answerCallbackQuery().catch(e => logger.error(`Failed callback: ${e}`));
  });
}
