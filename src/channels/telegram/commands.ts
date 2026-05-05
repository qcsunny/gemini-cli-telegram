/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot, Context } from 'grammy';
import * as os from 'node:os';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
  getDisplayString,
} from '@google/gemini-cli-core';
import type { SessionManager } from '../../core/session.js';
import type { SessionOptions } from '../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../core/resume.js';
import { logger } from '../../utils/logger.js';
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
} from './ui.js';

const AVAILABLE_MODELS = [
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
];

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
      await sessionManager.reset(chatId, defaultOptions);
      await ctx.reply(
        `${ICONS.new} <b>New session started!</b>\n\n${ICONS.arrow} Send me a message to get started.`,
        { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
      );
    } catch (e) {
      logger.error(`Error resetting session for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} Failed to start new session.`);
    }
  });

  // ── Cancel ──
  bot.command('cancel', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} No active session.`);
      return;
    }

    if (session.busy) {
      // Clear typing indicator immediately
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = undefined;
      }
      session.abortController.abort();
      session.abortController = new AbortController();
      session.busy = false;
      session.thinkingSteps = [];
      await ctx.reply(`${ICONS.cancel} Current operation cancelled.`, {
        reply_markup: buildMainKeyboard(),
      });
    } else {
      await ctx.reply(`${ICONS.info} Nothing to cancel.`);
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
      await ctx.reply(`${ICONS.error} Failed to initialize session: ${e}`);
      return;
    }

    if (session.busy) {
      await ctx.reply(
        `${ICONS.warning} Session is busy. Use /cancel first, then /resume.`,
      );
      return;
    }

    // No argument: list available sessions
    if (!arg) {
      try {
        const sessions = await listAvailableSessions(session.config);
        if (sessions.length === 0) {
          await ctx.reply(`${ICONS.info} No sessions found.`, {
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const sessionItems = sessions.slice(-10).map((s) => ({
          id: s.index.toString(),
          title: s.title,
          index: s.index,
        }));

        await ctx.reply(`${ICONS.resume} <b>Available Sessions</b>\n\nSelect a session to resume:`, {
          parse_mode: 'HTML',
          reply_markup: buildResumeKeyboard(sessionItems),
        });
      } catch (e) {
        logger.error(`Error listing sessions for chat ${chatId}: ${e}`);
        await ctx.reply(`${ICONS.error} Failed to list sessions: ${e}`);
      }
      return;
    }

    // Resume the specified session
    try {
      const message = await resumeSession(session, arg);
      await ctx.reply(`${ICONS.done} ${message}`, {
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error resuming session for chat ${chatId}: ${e}`);
      await ctx.reply(
        `${ICONS.error} Failed to resume: ${e instanceof Error ? e.message : String(e)}`,
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
        `${ICONS.model} <b>Select Model</b>\n\nCurrent: <code>${currentModel}</code>`,
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
      await ctx.reply(`${ICONS.model} <b>Switched to model:</b>\n<code>${modelName}</code>`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error switching model for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} Failed to switch model: ${e}`);
    }
  });

  // ── Compact ──
  bot.command('compact', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} No active session.`);
      return;
    }

    try {
      await session.geminiClient.tryCompressChat(
        `daemon-${session.sessionId}`,
        true,
      );
      await ctx.reply(`${ICONS.compact} Chat history compacted.`, {
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error compacting chat for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} Failed to compact: ${e}`);
    }
  });

  // ── Stats ──
  bot.command('stats', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} No active session.`, {
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
      await ctx.reply(`${ICONS.folder} Usage: /addfolder <path>`);
      return;
    }

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} No active session. Send a message first.`);
      return;
    }

    try {
      session.config.getWorkspaceContext().addDirectory(arg);
      await ctx.reply(`${ICONS.done} Added <code>${arg}</code> (read+write) to this session.`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      await ctx.reply(`${ICONS.error} Failed to add folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Session ID ──
  bot.command('id', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} No active session.`);
      return;
    }

    await ctx.reply(`${ICONS.session} Session ID: <code>${session.sessionId}</code>`, {
      parse_mode: 'HTML',
    });
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
        await ctx.reply(`${ICONS.clock} <b>Schedule Manager</b>\n\nSchedule messages to be sent automatically at a specific time or repeating interval.\n\n<b>Commands:</b>\n<code>/schedule add &lt;time&gt; &lt;message&gt;</code> — One-time schedule\n<code>/schedule recurring &lt;minutes&gt; &lt;message&gt;</code> — Repeating schedule\n<code>/schedule list</code> — View all scheduled tasks\n<code>/schedule remove &lt;id&gt;</code> — Delete a task\n<code>/schedule toggle &lt;id&gt;</code> — Pause or resume a task\n\n<b>Time Examples:</b>\n• <code>now</code> — Send in 5 seconds\n• <code>in 5m</code>, <code>in 1h</code>, <code>in 2h</code>\n• <code>tomorrow</code>, <code>tomorrow at 14:00</code>\n• <code>tonight</code>, <code>morning</code>, <code>evening</code>\n• <code>14:30</code> — Today or tomorrow at 2:30 PM\n\n<b>Usage Examples:</b>\n<code>/schedule add in 1h Check server logs</code>\n<code>/schedule recurring 60 Backup database</code>\n<code>/schedule add tomorrow at 09:00 Daily standup reminder</code>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const lines = [
        `${ICONS.clock} <b>Scheduled Tasks</b>`,
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
          return `${status} <code>${t.id.slice(0, 8)}</code> — ${t.type}\n  ${ICONS.clock} ${timeStr}\n  ${t.message.substring(0, 50)}${t.message.length > 50 ? '...' : ''}`;
        }),
        '',
        'Use <code>/schedule remove &lt;id&gt;</code> to remove a task.',
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
        await ctx.reply(`${ICONS.warning} Usage: <code>/schedule add &lt;time&gt; &lt;message&gt;</code>\n\nExample: <code>/schedule add in 1h Check server logs</code>`, {
          parse_mode: 'HTML',
        });
        return;
      }

      try {
        const task = await scheduler.addTask(chatId, message, 'once', timeExpr);
        const nextRun = new Date(task.nextRun);
        await ctx.reply(
          `${ICONS.done} <b>Task Scheduled</b>\n\nID: <code>${task.id.slice(0, 8)}</code>\nTime: ${nextRun.toLocaleString()}\nMessage: <i>${message}</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch (e) {
        await ctx.reply(`${ICONS.error} Failed to schedule: ${e instanceof Error ? e.message : String(e)}`);
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
        await ctx.reply(`${ICONS.warning} Usage: <code>/schedule recurring &lt;minutes&gt; &lt;message&gt;</code>\n\nExample: <code>/schedule recurring 60 Check disk space</code>`, {
          parse_mode: 'HTML',
        });
        return;
      }

      try {
        const task = await scheduler.addTask(chatId, message, 'recurring', `every ${minutes}m`, minutes);
        await ctx.reply(
          `${ICONS.done} <b>Recurring Task Scheduled</b>\n\nID: <code>${task.id.slice(0, 8)}</code>\nInterval: Every ${minutes} minutes\nMessage: <i>${message}</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch (e) {
        await ctx.reply(`${ICONS.error} Failed to schedule: ${e instanceof Error ? e.message : String(e)}`);
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
        await ctx.reply(`${ICONS.done} Task <code>${idPrefix}</code> removed.`, {
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
        await ctx.reply(`${ICONS.warning} Usage: <code>/schedule toggle &lt;id&gt;</code>`);
        return;
      }

      const tasks = scheduler.getTasksForChat(chatId);
      const task = tasks.find((t) => t.id.startsWith(idPrefix));
      if (!task) {
        await ctx.reply(`${ICONS.error} Task not found.`);
        return;
      }

      const newState = await scheduler.toggleTask(task.id);
      await ctx.reply(`${ICONS.done} Task <code>${idPrefix}</code> is now ${newState ? 'active 🟢' : 'paused 🔴'}.`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    await ctx.reply(`${ICONS.warning} Unknown subcommand: <code>${subcommand}</code>\n\nAvailable: <code>list</code>, <code>add</code>, <code>recurring</code>, <code>remove</code>, <code>toggle</code>`, {
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
        await ctx.reply(`${ICONS.cancel} <b>Autopilot stopped.</b>`, {
          reply_markup: buildMainKeyboard(),
        });
      } else {
        await ctx.reply(`${ICONS.info} Autopilot is not active.`);
      }
      return;
    }

    // Start autopilot
    if (!arg) {
      await ctx.reply(
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nEnable the bot to work autonomously by auto-replying to itself. The AI will iteratively think, act, and improve until the goal is achieved or max iterations reached.\n\n<b>How it works:</b>\n1️⃣ You set a clear goal\n2️⃣ AI processes and responds\n3️⃣ AI feeds its own response back as input\n4️⃣ Steps 2-3 repeat until done (max 10 iterations)\n5️⃣ Final summary is delivered to you\n\n<b>Commands:</b>\n<code>/autopilot &lt;goal&gt;</code> — Start working on a goal\n<code>/autopilot stop</code> — Stop autopilot immediately\n\n<b>Best for:</b>\n• Refactoring code across multiple files\n• Writing documentation or tests\n• Fixing bugs requiring multiple steps\n• Researching and summarizing topics\n\n<b>Examples:</b>\n<code>/autopilot Refactor auth module to use JWT tokens</code>\n<code>/autopilot Write unit tests for all API endpoints</code>\n<code>/autopilot Fix all ESLint warnings in the project</code>\n<code>/autopilot Create a migration script for the database</code>`,
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
      `${ICONS.bot} <b>Autopilot Started</b>\n\n${ICONS.thinking} Goal: <i>${arg}</i>\n${ICONS.arrow} Max iterations: 10\n\n${ICONS.loading} Processing...`,
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

    // If no projects saved, scan home directory
    if (projects.length === 0) {
      await ctx.reply(`${ICONS.loading} Scanning for projects...`);
      try {
        projects = await projectManager.scanDirectory(os.homedir(), 1);
        await projectManager.saveProjects();
      } catch (e) {
        logger.error(`Failed to scan projects: ${e}`);
      }
    }

    if (projects.length === 0) {
      await ctx.reply(`${ICONS.info} No projects found. Use /addfolder to add a project directory.`, {
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    const session = sessionManager.getSession(chatId);
    const currentProjectId = session?.currentProject?.id;

    await ctx.reply(
      `${ICONS.project} <b>Select Project</b>\n\nChoose a project to work with:`,
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
      await ctx.reply(`${ICONS.warning} No project ID provided.`);
      return;
    }

    const projectManager = sessionManager.getProjectManager();
    const project = projectManager.getProject(arg);

    if (!project) {
      await ctx.reply(`${ICONS.error} Project not found.`);
      return;
    }

    try {
      // Reset session with new project
      await sessionManager.reset(chatId, {
        ...defaultOptions,
        project,
      });

      await ctx.reply(
        `${ICONS.done} <b>Project Selected</b>\n\n${formatProjectInfo(project)}`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
    } catch (e) {
      logger.error(`Error switching project for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} Failed to switch project: ${e}`);
    }
  });

  // ── Project Browse ──
  bot.command('project_browse', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const browsePath = arg || os.homedir();

    await ctx.reply(`${ICONS.loading} Scanning ${browsePath}...`);

    try {
      const projectManager = sessionManager.getProjectManager();
      const projects = await projectManager.scanDirectory(browsePath, 1);
      await projectManager.saveProjects();

      if (projects.length === 0) {
        await ctx.reply(`${ICONS.info} No projects found in <code>${browsePath}</code>.`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const session = sessionManager.getSession(chatId);
      const currentProjectId = session?.currentProject?.id;

      await ctx.reply(
        `${ICONS.project} <b>Found ${projects.length} Projects</b>\n\nSelect a project:`,
        {
          parse_mode: 'HTML',
          reply_markup: buildProjectKeyboard(projects.slice(0, PROJECTS_PER_PAGE), projects.length > PROJECTS_PER_PAGE, 0, currentProjectId),
        },
      );
    } catch (e) {
      logger.error(`Error browsing directory: ${e}`);
      await ctx.reply(`${ICONS.error} Failed to browse: ${e}`);
    }
  });

  // ── Callback Query Handler ──
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    
    if (!chatId) return;

    // Handle navigation callbacks
    if (data === '/start') {
      await ctx.answerCallbackQuery('Main menu');
      await ctx.editMessageText(formatWelcome(ctx.from?.first_name), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/new') {
      await ctx.answerCallbackQuery('Starting new session...');
      try {
        await sessionManager.reset(chatId, defaultOptions);
        await ctx.editMessageText(
          `${ICONS.new} <b>New session started!</b>\n\n${ICONS.arrow} Send me a message to get started.`,
          { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
        );
      } catch (e) {
        await ctx.answerCallbackQuery('Failed to start new session');
      }
      return;
    }

    if (data === '/projects') {
      await ctx.answerCallbackQuery('Loading projects...');
      // Reuse the projects command logic
      const projectManager = sessionManager.getProjectManager();
      let projects = projectManager.getProjects();

      if (projects.length === 0) {
        projects = await projectManager.scanDirectory(os.homedir(), 1);
        await projectManager.saveProjects();
      }

      if (projects.length === 0) {
        await ctx.editMessageText(`${ICONS.info} No projects found.`, {
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const session = sessionManager.getSession(chatId);
      const currentProjectId = session?.currentProject?.id;

      await ctx.editMessageText(
        `${ICONS.project} <b>Select Project</b>\n\nChoose a project to work with:`,
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
      await ctx.answerCallbackQuery('Loading models...');
      const session = sessionManager.getSession(chatId);
      const currentModel = session?.config.getModel() || 'unknown';

      const modelItems = AVAILABLE_MODELS.map((m, i) => ({
        id: (i + 1).toString(),
        display: getDisplayString(m) !== m ? `${m} — ${getDisplayString(m)}` : m,
        active: m === currentModel,
      }));

      await ctx.editMessageText(
        `${ICONS.model} <b>Select Model</b>\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems),
        },
      );
      return;
    }

    if (data === '/resume') {
      await ctx.answerCallbackQuery('Loading sessions...');
      // Reuse resume logic
      let session;
      try {
        session = await sessionManager.getOrCreate(chatId, defaultOptions);
      } catch {
        await ctx.answerCallbackQuery('Failed to load sessions');
        return;
      }

      try {
        const sessions = await listAvailableSessions(session.config);
        if (sessions.length === 0) {
          await ctx.editMessageText(`${ICONS.info} No sessions found.`, {
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
          `${ICONS.resume} <b>Available Sessions</b>\n\nSelect a session to resume:`,
          {
            parse_mode: 'HTML',
            reply_markup: buildResumeKeyboard(sessionItems),
          },
        );
      } catch {
        await ctx.answerCallbackQuery('Failed to list sessions');
      }
      return;
    }

    if (data === '/stats') {
      await ctx.answerCallbackQuery('Loading stats...');
      const session = sessionManager.getSession(chatId);
      if (!session) {
        await ctx.editMessageText(`${ICONS.warning} No active session.`, {
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
      await ctx.answerCallbackQuery('Loading help...');
      await ctx.editMessageText(formatHelp(), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/schedule') {
      await ctx.answerCallbackQuery('Loading schedule...');
      const scheduler = sessionManager.getChatScheduler();
      const tasks = scheduler.getTasksForChat(chatId);

      if (tasks.length === 0) {
        await ctx.editMessageText(`${ICONS.clock} <b>Schedule Manager</b>\n\nSchedule messages to be sent automatically at a specific time or repeating interval.\n\n<b>Commands:</b>\n<code>/schedule add &lt;time&gt; &lt;message&gt;</code> — One-time\n<code>/schedule recurring &lt;minutes&gt; &lt;message&gt;</code> — Repeating\n<code>/schedule list</code> — View all tasks\n<code>/schedule remove &lt;id&gt;</code> — Delete\n<code>/schedule toggle &lt;id&gt;</code> — Pause/resume\n\n<b>Time Examples:</b>\n<code>now</code>, <code>in 5m</code>, <code>in 1h</code>, <code>tomorrow at 09:00</code>, <code>14:30</code>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const lines = [
        `${ICONS.clock} <b>Scheduled Tasks</b>`,
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
      await ctx.answerCallbackQuery('Autopilot info');
      await ctx.editMessageText(
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nThe AI works autonomously by auto-replying to itself until the goal is achieved.\n\n<b>How it works:</b>\n1️⃣ Set a clear goal\n2️⃣ AI thinks → acts → improves\n3️⃣ Repeats until done (max 10x)\n4️⃣ Delivers final result\n\n<b>Commands:</b>\n<code>/autopilot &lt;goal&gt;</code> — Start working\n<code>/autopilot stop</code> — Stop immediately\n\n<b>Good for:</b> Refactoring, writing tests, fixing bugs, research`,
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

      try {
        const session = await sessionManager.getOrCreate(chatId, defaultOptions);
        session.config.setModel(modelName, false);
        await ctx.answerCallbackQuery(`Switched to ${modelName}`);
        await ctx.editMessageText(
          `${ICONS.model} <b>Switched to model:</b>\n<code>${modelName}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch {
        await ctx.answerCallbackQuery('Failed to switch model');
      }
      return;
    }

    // Handle project selection callback
    if (data.startsWith('/project_select ')) {
      const projectId = data.replace('/project_select ', '');
      const projectManager = sessionManager.getProjectManager();
      const project = projectManager.getProject(projectId);

      if (!project) {
        await ctx.answerCallbackQuery('Project not found');
        return;
      }

      try {
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          project,
        });

        await ctx.answerCallbackQuery(`Switched to ${project.name}`);
        await ctx.editMessageText(
          `${ICONS.done} <b>Project Selected</b>\n\n${formatProjectInfo(project)}`,
          {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          },
        );
      } catch {
        await ctx.answerCallbackQuery('Failed to switch project');
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

      await ctx.answerCallbackQuery(`Page ${page + 1}`);
      await ctx.editMessageText(
        `${ICONS.project} <b>Select Project</b> (Page ${page + 1})\n\nChoose a project:`,
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

    await ctx.answerCallbackQuery();
  });
}
