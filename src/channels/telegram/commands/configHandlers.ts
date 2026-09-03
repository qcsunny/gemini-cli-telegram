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
import { runModelSync, type GeminiUpgrade } from '../../../core/modelSync.js';
import type { OpenCodeSyncResult } from '../../../core/modelSyncOpenCode.js';
import type { HttpBackendName, HttpSyncResult } from '../../../core/modelSyncHttp.js';
import { ICONS, buildMainKeyboard, buildModelKeyboard, MODELS_PER_PAGE, formatSessionStats, formatHelp, escapeHtml } from '../ui.js';

function formatUpgrades(upgrades: GeminiUpgrade[]): string {
  return upgrades
    .map((u) => `  <code>${escapeHtml(u.from)}</code> → <code>${escapeHtml(u.to)}</code>`)
    .join('\n');
}

function formatOpenCodeSection(oc: OpenCodeSyncResult): string {
  const lines: string[] = [];
  if (oc.status === 'error') {
    lines.push(`${ICONS.warning} <b>OpenCode 同步失败</b>（不影响 Gemini 结果）: ${escapeHtml(oc.error ?? 'unknown')}`);
    return lines.join('\n');
  }
  if (oc.status === 'up-to-date' && !oc.note) return '';

  lines.push(`${ICONS.success} <b>OpenCode 模型已同步</b>`);
  if (oc.removals.length > 0) {
    lines.push('移除失效模型：');
    lines.push(...oc.removals.map((r) => `  ✗ <code>${escapeHtml(r.display)}</code> (${escapeHtml(r.routingId)}) · ${escapeHtml(r.tierName)}`));
  }
  if (oc.upgrades.length > 0) {
    lines.push('升级版本：');
    lines.push(...oc.upgrades.map((u) => `  <code>${escapeHtml(u.display)}</code> → <code>${escapeHtml(u.newDisplay)}</code>`));
  }
  if (oc.additions.length > 0) {
    lines.push(`新增免费模型（${escapeHtml(oc.additions[0]!.tierName)}）：`);
    lines.push(...oc.additions.map((a) => `  + <code>${escapeHtml(a.display)}</code>`));
  }
  if (oc.note) lines.push(`  ℹ️ ${escapeHtml(oc.note)}`);
  return lines.join('\n');
}

const HTTP_BACKEND_LABELS: Record<HttpBackendName, string> = {
  web2api: 'Web2API',
  glm: 'GLM',
  qwen: 'Qwen',
  mimo: 'MiMo',
  deepseek: 'DeepSeek',
};

function formatHttpSection(http: Record<HttpBackendName, HttpSyncResult>): string {
  const errored: string[] = [];
  const notes: string[] = [];
  const lines: string[] = [];
  const order: HttpBackendName[] = ['web2api', 'glm', 'qwen', 'mimo', 'deepseek'];

  for (const service of order) {
    const r = http[service];
    if (!r) continue;
    if (r.status === 'error') {
      errored.push(`  ⚠️ ${HTTP_BACKEND_LABELS[service]}: ${escapeHtml(r.error ?? 'unknown')}`);
      continue;
    }
    if (r.status === 'up-to-date') {
      if (r.note) notes.push(`  ℹ️ ${HTTP_BACKEND_LABELS[service]}: ${escapeHtml(r.note)}`);
      continue;
    }
    const label = HTTP_BACKEND_LABELS[service];
    if (r.note) notes.push(`  ℹ️ ${label}: ${escapeHtml(r.note)}`);
    for (const u of r.upgrades) {
      lines.push(`  <code>${escapeHtml(u.display)}</code> → <code>${escapeHtml(u.newDisplay)}</code> (${label})`);
    }
    for (const m of r.mediaReplacements) {
      lines.push(`  🔄 ${escapeHtml(m.displays.join(' + '))} → <code>${escapeHtml(m.newDisplay)}</code> (${label} ${escapeHtml(m.newRoutingId)})`);
    }
    for (const rm of r.removals) {
      lines.push(`  ✗ <code>${escapeHtml(rm.display)}</code> (${label} 失效移除)`);
    }
  }

  const parts: string[] = [];
  if (lines.length > 0) parts.push(`${ICONS.success} <b>远程后端模型已同步</b>`, ...lines);
  if (errored.length > 0) {
    parts.push(`${ICONS.warning} <b>部分远程后端同步失败</b>（不影响其他结果）:`);
    parts.push(...errored);
  }
  if (notes.length > 0) parts.push('ℹ️ <b>备注</b>:', ...notes);
  return parts.join('\n');
}

async function handleModelSync(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const pending = await ctx.reply('⏳ 正在从 agy / opencode / 远程后端获取可用模型列表…');
  let text: string;
  try {
    const result = await runModelSync();
    const ocSection = formatOpenCodeSection(result.opCode);
    const httpSection = formatHttpSection(result.http);
    if (result.status === 'updated' || ocSection || httpSection) {
      const lines: string[] = [];
      if (result.status === 'updated') {
        lines.push(`${ICONS.success} <b>Gemini 模型已升级到本地最新版本</b>`, '');
        if (result.upgrades.length > 0) {
          lines.push(formatUpgrades(result.upgrades), '');
        }
        lines.push(`生效位置：${result.appliedLocations.map(escapeHtml).join('、')}`);
        lines.push('config.json 已写入并热生效（无需重启）。');
        if (result.modelsJsonUpdated) {
          lines.push('src/config/models.json 已同步。');
        } else if (result.modelsJsonError) {
          lines.push(`⚠️ src/config/models.json 同步失败（不影响运行）: ${escapeHtml(result.modelsJsonError)}`);
        }
      }
      if (ocSection) {
        if (lines.length > 0) lines.push('');
        lines.push(ocSection);
      }
      if (httpSection) {
        if (lines.length > 0) lines.push('');
        lines.push(httpSection);
      }
      text = lines.join('\n');
    } else if (result.status === 'up-to-date') {
      text = `${ICONS.success} 已是最新版本，无需更新。`;
    } else {
      text = `${ICONS.warning} agy 模型列表中没有 Gemini Flash/Pro 模型，未做任何修改。`;
    }
  } catch (e) {
    logger.error(`[modelSync] /model sync failed: ${e}`);
    text = `${ICONS.error} <b>/model sync 失败:</b> ${escapeHtml(e instanceof Error ? e.message : String(e))}\n请检查 agy / opencode 已安装、代理可用 (config.proxy)、远程后端在线，或稍后重试。`;
  }
  try {
    await ctx.api.editMessageText(chatId, pending.message_id, text, { parse_mode: 'HTML' });
  } catch (e) {
    // editMessageText can fail (message too old / not modified); fall back to a plain reply
    logger.warn(`[modelSync] editMessageText failed, falling back to reply: ${e}`);
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}

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

    // `/model sync` — upgrade Gemini Flash/Pro references to the latest local agy versions
    if (arg.toLowerCase() === 'sync') {
      await handleModelSync(ctx);
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
 * Format the real-time health and cooldown status of all 8 backend channels.
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
    qwen: 'Qwen Proxy (tongyi)',
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
