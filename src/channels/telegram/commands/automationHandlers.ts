import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions, DaemonSession } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { ICONS, buildMainKeyboard, escapeHtml, truncate } from '../ui.js';

export function registerAutomationHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  triggerAutopilot?: (session: DaemonSession, ctx: Context) => Promise<void>,
): void {
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
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nI will work autonomously by auto-replying to myself until your goal is achieved.\n\n<b>Workflow:</b>\n1️⃣ Set a clear goal\n2️⃣ I think → act → verify\n3️⃣ I repeat until goal achieved (Timeout: 30 mins)\n4️⃣ I provide a final summary\n\n<b>Commands:</b>\n• <code>/autopilot &lt;goal&gt;</code> — Start working\n• <code>/autopilot stop</code> — Stop immediately\n\n<b>Best for:</b> Refactoring, writing tests, fixing bugs, and research.`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
      return;
    }

    const session = await sessionManager.getOrCreate(chatId, defaultOptions);

    // Set autopilot config (unlimited iterations, 30 min timeout)
    session.autopilot = {
      goal: arg,
      maxIterations: Infinity,
      currentIteration: 0,
      active: true,
      stopKeywords: ['AUTOPILOT_COMPLETE', 'AUTOPILOT_STOP'],
      startTime: Date.now(),
      timeoutMs: 30 * 60 * 1000, // 30 minutes
    };

    await ctx.reply(
      `${ICONS.bot} <b>Autopilot Initialized</b>\n\n${ICONS.thinking} <b>Goal:</b> <i>${escapeHtml(arg)}</i>\n${ICONS.clock} <b>Timeout:</b> 30 minutes (Unlimited steps)\n\n${ICONS.loading} <i>Working on the first step...</i>`,
      {
        parse_mode: 'HTML',
      },
    );

    // Auto-ignite the loop immediately!
    if (triggerAutopilot) {
      triggerAutopilot(session, ctx).catch(e => logger.error(`Autopilot auto-trigger failed: ${e}`));
    }
  });
}
