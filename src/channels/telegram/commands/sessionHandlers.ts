/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { ICONS, buildMainKeyboard, buildResumeKeyboard, escapeHtml, formatWelcome } from '../ui.js';

export function registerSessionHandlers(
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
        model: 'Gemini 3.6 Flash (High)',
      });
      await ctx.reply(
        `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>Gemini 3.6 Flash (High)</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
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

      const { undoLastTurn } = await import('../../../agy/historyManager.js');
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
}
