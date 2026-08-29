/**
 * @file sessionHandlers.ts
 * @description Telegram bot handlers for session management (/resume, /sessions,
 * /cancel, /welcome). Handles session resumption from history, listing active
 * sessions with cost/token stats, cancellation, and the welcome screen.
 */

import { InputFile, type Bot, type Context } from 'grammy';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { getDefaultModel, getDefaultProjectName } from '../../../config/userConfig.js';
import { ICONS, buildMainKeyboard, buildResumeKeyboard, escapeHtml, formatWelcome } from '../ui.js';
import { fullInlineOutputs } from './inlineHandler.js';
import { getDb, schema } from '../../../db/index.js';
import { eq } from 'drizzle-orm';
import { getConversationId } from '../../../agy/conversationStore.js';
import { getConversationsDir, readUsageFromDatabase } from '../../../agy/protobuf.js';
import { calculateCost } from '../../../utils/pricing.js';
import { getChannelModel } from '../../../core/modelRegistry.js';

export function registerSessionHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  // ── Start Command ──
  bot.command('start', async (ctx: Context) => {
    const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (match.startsWith('full_')) {
      const resultId = match.replace('full_', '');
      const fullData = fullInlineOutputs.get(resultId);
      if (fullData) {
        const mdDoc = `# 💬 Question\n\n${fullData.prompt}\n\n# 🤖 Answer (${fullData.model})\n\n${fullData.output}`;
        if (mdDoc.length <= 3900) {
          const markdown = `<b>💬 Question:</b> ${escapeHtml(fullData.prompt)}\n\n<b>🤖 Answer (${escapeHtml(fullData.model)}):</b>\n\n${escapeHtml(fullData.output)}`;
          await ctx.reply(markdown, { parse_mode: 'HTML' });
        } else {
          // Inline cards cap at 32768 rich-text chars and plain text at 4096;
          // deliver oversized answers as a Markdown document instead.
          await ctx.replyWithDocument(new InputFile(Buffer.from(mdDoc, 'utf8'), `full_answer_${resultId}.md`), {
            caption: `📄 完整回答（${fullData.output.length} 字符）· ${fullData.model}`,
          });
        }
        return;
      }
    }

    const userName = ctx.from?.first_name;
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (chatId) {
      try {
        // Ensure session exists without destroying existing history
        await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
      } catch (e) {
        logger.error(`Error ensuring session for chat ${chatId} on /start: ${e}`);
      }
    }
    await ctx.reply(formatWelcome(userName), {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });

  // ── New Session (with /reset and /clear aliases) ──
  bot.command(['new', 'reset', 'clear'], async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    try {
      const activeSession = sessionManager.getSession(chatId, threadId);
      if (activeSession) {
        if (activeSession.typingInterval) {
          clearInterval(activeSession.typingInterval);
          activeSession.typingInterval = undefined;
        }
        activeSession.abortController.abort('Reset by command');
        activeSession.busy = false;
      }

      const projectManager = sessionManager.getProjectManager();
      const allProjects = projectManager.getProjects() || [];
      const defaultProj = allProjects.find(p => p?.name === getDefaultProjectName()) || allProjects[0];
      
      await sessionManager.reset(chatId, {
        ...defaultOptions,
        project: defaultProj,
        model: defaultOptions.model || getDefaultModel() || '',
      }, threadId);

      const modelName = defaultOptions.model || getDefaultModel() || '';
      await ctx.reply(
        `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>${escapeHtml(modelName)}</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
        { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
      );
    } catch (e) {
      logger.error(`Error resetting session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Failed to reset session:</b> ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Usage & Cost Command ──
  bot.command('usage', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId, threadId);
    const model = session?.config?.getModel() || defaultOptions.model || 'unknown';

    const channel = getChannelModel(model);
    if (channel === 'web2api' || channel === 'deepseek' || channel === 'glm') {
      await ctx.reply(
        `ℹ️ <b>当前模型（<code>${escapeHtml(model)}</code>）为 Web / 反代代理通道，无需统计 API Token 用量与计费。</b>\n\n<i>💡 <code>/usage</code> 命令主要用于统计 AGY、Claude CLI、Codex CLI、OpenCode 等计费后端的 Token 开销。</i>`,
        { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
      );
      return;
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    let totalThinking = 0;

    try {
      const convId = await getConversationId(chatId, threadId);
      if (convId) {
        // 1. Try reading usage from agy conversation SQLite database
        const agyDbPath = path.join(getConversationsDir(), `${convId}.db`);
        if (fs.existsSync(agyDbPath)) {
          const agyUsage = readUsageFromDatabase(agyDbPath, -1);
          if (agyUsage) {
            totalInput += agyUsage.input;
            totalOutput += agyUsage.output;
            totalCached += agyUsage.cached;
            totalThinking += agyUsage.thinking;
          }
        }

        // 2. Also read usage from SQLite messages table (for opencode/claude/codex)
        const db = getDb();
        const rows = db.select({ usage: schema.messages.usage, backend: schema.messages.backend })
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, convId))
          .all();

        for (const r of rows) {
          if (r.backend === 'web2api' || r.backend === 'deepseek' || r.backend === 'glm') continue;
          if (r.usage) {
            try {
              const u = JSON.parse(r.usage);
              totalInput += u.input || 0;
              totalOutput += u.output || 0;
              totalCached += u.cached || 0;
              totalThinking += u.thinking || 0;
            } catch {
              // ignore parse errors
            }
          }
        }
      }

      const cost = calculateCost(model, totalInput, totalOutput, totalCached, totalThinking);
      const currencySymbol = cost.currency === 'CNY' ? '¥' : '$';

      const text = [
        `📊 <b>Session Token Usage & Cost</b>`,
        '',
        `🤖 <b>Active Model:</b> <code>${escapeHtml(model)}</code>`,
        `🔢 <b>Conversation Turns:</b> <code>${session?.turnCount ?? 0}</code>`,
        '',
        `<b>Token Breakdown:</b>`,
        `  📥 <b>Input (Prompt):</b> <code>${totalInput.toLocaleString()}</code>`,
        `  ⚡ <b>Cached (Context):</b> <code>${totalCached.toLocaleString()}</code>`,
        `  📤 <b>Output (Generated):</b> <code>${totalOutput.toLocaleString()}</code>`,
        `  🧠 <b>Reasoning (Thinking):</b> <code>${totalThinking.toLocaleString()}</code>`,
        '',
        `💰 <b>Estimated Cost:</b> <code>${currencySymbol}${cost.totalCost.toFixed(5)}</code>`,
        '',
        `💾 <i>已在 SQLite 数据库持久化（重启服务不丢失；发送 /new 重置开启新会话）。</i>`
      ].join('\n');

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error calculating usage for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Failed to load usage stats:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
    }
  });

  // ── Cancel ──
  bot.command('cancel', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId, threadId);
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
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // Ensure we have a session (needed to access config/storage paths)
    let session;
    try {
      session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
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

        const sessionItems = sessions.slice(0, 10).map((s) => ({
          id: s.id,
          title: s.title,
          index: s.index,
          relativeTime: s.relativeTime,
        }));

        const sessionListText = sessionItems.map((s) => 
          `<b>${s.index}.</b> ${escapeHtml(s.title)}\n  └ <i>${s.relativeTime} · <code>${s.id.slice(0, 8)}</code></i>`
        ).join('\n\n');

        await ctx.reply(`${ICONS.resume} <b>Restore Session</b>\n\n${sessionListText}\n\n<i>Send <code>/resume &lt;index&gt;</code> to switch, or tap a button below:</i>`, {
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
}
