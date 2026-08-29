/**
 * @file configHandlers.ts
 * @description Telegram bot handlers for model selection (/model), help (/help),
 * status (/status), and system info (/sysinfo). Provides paginated model
 * picker and backend health dashboard.
 */

import { Bot, type Context, InlineKeyboard } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getAvailableModels } from '../../../agy/agyCli.js';
import { getAllBackendHealthStatus } from '../../../core/backendHealth.js';
import { AUTO_MODEL_NAME } from '../../../core/router.js';
import { ICONS, buildMainKeyboard, buildModelKeyboard, MODELS_PER_PAGE, formatSessionStats, formatHelp } from '../ui.js';

export function registerConfigHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  // ── Model Selection ──
  bot.command('model', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      const session = sessionManager.getSession(chatId, threadId);
      const currentModel = session?.config?.getModel() || 'unknown';
      const models = await getAvailableModels();
      const page = 0;
      const start = page * MODELS_PER_PAGE;
      const pageModels = models.slice(start, start + MODELS_PER_PAGE);
      const modelItems = pageModels.map((m, i) => ({
        id: ((page * MODELS_PER_PAGE) + i + 1).toString(),
        display: m,
        active: m === currentModel,
      }));

      await ctx.reply(
        `${ICONS.model} <b>Model Selection</b> (🚀 Flagship Reasoning)\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page, 0),
        },
      );
      return;
    }

    // Resolve number to model name or auto
    const models = await getAvailableModels();
    let modelName: string;
    if (arg.toLowerCase() === 'auto' || arg.includes('Auto')) {
      modelName = AUTO_MODEL_NAME;
    } else {
      const num = parseInt(arg, 10);
      modelName =
        !isNaN(num) && num >= 1 && num <= models.length
          ? models[num - 1]
          : arg;
    }

    try {
      const session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
      session.config!.setModel(modelName, false);
      await ctx.reply(`${ICONS.model} <b>Brain Switched</b>\n\nNow using: <code>${modelName}</code>`, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
    } catch (e) {
      logger.error(`Error switching model for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Switch failed:</b> ${e}`);
    }
  });

  // ── Status ──
  bot.command('status', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId, threadId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`, {
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    const stats = formatSessionStats({
      sessionId: session.sessionId,
      model: session.config!.getModel(),
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
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply(`${ICONS.folder} <b>Usage:</b>\n<code>/addfolder &lt;path&gt;</code>`, { parse_mode: 'HTML' });
      return;
    }

    const session = sessionManager.getSession(chatId, threadId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>\nSend a message first.`);
      return;
    }

    try {
      session.config!.getWorkspaceContext().addDirectory(arg);
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
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const session = sessionManager.getSession(chatId, threadId);
    if (!session) {
      await ctx.reply(`${ICONS.warning} <b>No active session.</b>`);
      return;
    }

    await ctx.reply(`${ICONS.session} <b>Session ID:</b>\n<code>${session.sessionId}</code>`, {
      parse_mode: 'HTML',
    });
  });

  // ── Backends Health Monitor ──
  bot.command('backends', async (ctx: Context) => {
    const { text, keyboard } = formatBackendsStatus();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // ── Help ──
  bot.command('help', async (ctx: Context) => {
    await ctx.reply(formatHelp(), {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(),
    });
  });
}

/**
 * Format the real-time health and cooldown status of all 7 backend channels.
 */
export function formatBackendsStatus(): { text: string; keyboard: InlineKeyboard } {
  const statuses = getAllBackendHealthStatus();
  const channelNames: Record<string, string> = {
    codex: 'Codex CLI',
    claude: 'Claude CLI',
    agy: 'Google Antigravity (AGY)',
    opencode: 'OpenCode Local Engine',
    deepseek: 'DeepSeek Proxy',
    web2api: 'Web2API Proxy',
    glm: 'GLM Proxy (chatglm)',
  };

  const lines = statuses.map((s) => {
    const name = channelNames[s.channel] || s.channel;
    if (s.isHealthy) {
      return `🟢 <b>${name}</b>\n   └ 状态：<code>正常运作 (Healthy)</code>`;
    }
    return `🔴 <b>${name}</b>\n   └ 状态：<code>熔断冷却中 (${s.cooldownRemainingSeconds}s 剩余, 失败 ${s.failCount} 次)</code>`;
  });

  const text = `🛡️ <b>Model Backends Health Monitor</b>\n\n${lines.join('\n\n')}\n\n<i>Last checked: ${new Date().toLocaleTimeString()}</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔄 刷新状态', 'backends:refresh')
    .text('⚡ 恢复所有后端', 'backends:reset')
    .row()
    .text('⚙️ 切换模型', 'cmd:model');

  return { text, keyboard };
}
