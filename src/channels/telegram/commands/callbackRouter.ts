/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file callbackRouter.ts
 * @description Central callback_query router for Telegram inline keyboard actions.
 * Routes callback data (model selection, session resume, project switch,
 * settings, stock comparison, image relay, etc.) to their respective handlers
 * with a prefix-matching dispatch table.
 */

import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import { getBrowseRoot, getDefaultProjectName, loadUserConfig } from '../../../config/userConfig.js';
import { loadModelsConfig } from '../../../core/modelRegistry.js';
import { getAvailableModels } from '../../../agy/agyCli.js';
import { loadMessages } from '../../../agy/messageStore.js';
import { ICONS, buildMainKeyboard, buildModelKeyboard, MODELS_PER_PAGE, buildProjectKeyboard, buildResumeKeyboard, formatProjectInfo, formatSessionStats, formatHelp, formatWelcome, escapeHtml } from '../ui.js';
import { formatBackendsStatus } from './configHandlers.js';
import { clearBackendHealth } from '../../../core/backendHealth.js';
import { extractTitleFromMarkdown, saveMarkdownToAnswerSaveDir } from './helpers.js';
import { PROJECTS_PER_PAGE } from './projectHandlers.js';
import { AUTO_MODEL_NAME } from '../../../core/router.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMessageNotModifiedError(err: unknown): boolean {
  const e = asRecord(err);
  const desc = typeof e?.['description'] === 'string' ? e['description'] : String(err);
  return desc.includes('message is not modified');
}

function isCallbackQueryExpiredError(err: unknown): boolean {
  const e = asRecord(err);
  const desc = typeof e?.['description'] === 'string' ? e['description'] : String(err);
  return desc.includes('query is too old') || desc.includes('query ID is invalid');
}

async function safeEditMessageText(
  ctx: Context,
  text: string,
  other?: Parameters<Context['editMessageText']>[1],
): Promise<void> {
  try {
    await ctx.editMessageText(text, other);
  } catch (err: unknown) {
    if (isMessageNotModifiedError(err)) {
      return;
    }
    throw err;
  }
}

function safeAnswerCallback(ctx: Context, text?: string): void {
  ctx.answerCallbackQuery(text).catch((e: unknown) => {
    if (isCallbackQueryExpiredError(e)) {
      logger.debug(`[callbackRouter] Callback query expired or invalid: ${e}`);
    } else {
      logger.warn(`[callbackRouter] Failed callback query: ${e}`);
    }
  });
}

export function registerCallbackRouter(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.on('callback_query:data', async (ctx, next) => {
    // Inline-message callbacks (chosen_inline_result edits) have no chat —
    // they belong to the inline handler. Hand off without answering so the
    // inline handler owns the callback_query lifecycle (answer + edit).
    if (ctx.callbackQuery.inline_message_id) {
      await next();
      return;
    }

    // Answer immediately to dismiss Telegram UI loading state (guaranteed fire)
    try {
      ctx.answerCallbackQuery().catch(() => {});
    } catch {
      // ignore
    }

    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    const threadId = ctx.callbackQuery?.message?.message_thread_id;

    // Hand off watchlist callbacks directly to watchlist handler
    if (data && data.startsWith('wl_')) {
      await next();
      return;
    }

    if (!chatId) return;

    // Handle navigation callbacks
    if (data === '/start') {
      safeAnswerCallback(ctx, 'Main Menu');
      await safeEditMessageText(ctx, formatWelcome(ctx.from?.first_name), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === 'backends:refresh') {
      safeAnswerCallback(ctx, 'Refreshing backends...');
      const { text, keyboard } = formatBackendsStatus();
      await safeEditMessageText(ctx, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    }

    if (data === 'backends:reset') {
      safeAnswerCallback(ctx, 'Resetting cooldowns...');
      clearBackendHealth();
      const { text, keyboard } = formatBackendsStatus();
      await safeEditMessageText(ctx, `⚡ <b>All backend cooldowns have been reset!</b>\n\n${text}`, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    }

    if (data === 'cmd:model') {
      safeAnswerCallback(ctx, 'Loading models...');
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

      await safeEditMessageText(
        ctx,
        `${ICONS.model} <b>Model Selection</b> (🚀 Flagship Reasoning)\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page, 0),
        },
      );
      return;
    }

    if (data === '/new') {
      safeAnswerCallback(ctx, 'Resetting session...');
      logger.info(`[DEBUG /new] defaultOptions = ${JSON.stringify(defaultOptions)}`);
      try {
        const projectManager = sessionManager.getProjectManager();
        const allProjects = projectManager.getProjects();
        const defaultProj = allProjects.find(p => p.name === getDefaultProjectName()) || allProjects[0];
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          project: defaultProj,
        }, threadId);
        await safeEditMessageText(
          ctx,
          `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>${defaultOptions.model}</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
          { parse_mode: 'HTML', reply_markup: buildMainKeyboard() },
        );
      } catch (e) {
        logger.error(`Failed to reset session: ${e}`);
      }
      return;
    }

    if (data === '/projects') {
      safeAnswerCallback(ctx, 'Loading workspaces...');
      const projectManager = sessionManager.getProjectManager();
      const projects = projectManager.getProjects();

      if (projects.length === 0) {
        await safeEditMessageText(ctx, `${ICONS.info} <b>No projects found.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
        return;
      }

      const session = sessionManager.getSession(chatId, threadId);
      const currentProjectId = session?.currentProject?.id;

      await safeEditMessageText(
        ctx,
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
      safeAnswerCallback(ctx, 'Loading models...');
      const session = sessionManager.getSession(chatId, threadId);
      const currentModel = session?.config?.getModel() || 'unknown';
      const models = await getAvailableModels();
      const page = 0;
      const start = page * MODELS_PER_PAGE;
      const pageModels = models.slice(start, start + MODELS_PER_PAGE);
      const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);

      const modelItems = pageModels.map((m, i) => ({
        id: ((page * MODELS_PER_PAGE) + i + 1).toString(),
        display: m,
        active: m === currentModel,
      }));

      await safeEditMessageText(
        ctx,
        `${ICONS.model} <b>Model Selection</b> (Page ${page + 1}/${totalPages})\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page),
        },
      );
      return;
    }

    if (data.startsWith('/model_tier ')) {
      const tier = parseInt(data.replace('/model_tier ', ''), 10);
      const tierNames = ['🚀 Flagship Reasoning', '⚡ Advanced Reasoning', '💡 General Capability', '🍃 Light & Free', '🔁 Remote Backends'];
      const tierName = tierNames[tier] || 'Model category';
      safeAnswerCallback(ctx, `✨ Switched category: ${tierName}`);

      const session = sessionManager.getSession(chatId, threadId);
      const currentModel = session?.config?.getModel() || 'unknown';
      const models = await getAvailableModels();

      const cfg = loadUserConfig();
      const modelsConfig = loadModelsConfig();
      const tiers = cfg?.modelsConfig?.tiers || modelsConfig?.tiers || [];
      const targetTierObj = tiers[tier];

      let pageModels: string[] = [];
      if (targetTierObj && targetTierObj.models && targetTierObj.models.length > 0) {
        const normalize = (s: string) => s.toLowerCase().replace(/^(web2api|deepseek|opencode):\s*/i, '').trim();
        const tierModelSet = new Set(targetTierObj.models.map(normalize));

        pageModels = models.filter(m => tierModelSet.has(normalize(m)));
      }

      if (pageModels.length === 0) {
        // Fallback: chunk models into distinct non-overlapping slices
        const totalTiers = Math.max(1, tiers.length);
        const chunkSize = Math.ceil(models.length / totalTiers);
        const start = tier * chunkSize;
        pageModels = models.slice(start, start + chunkSize);
      }

      const modelItems = pageModels.map((m) => {
        const foundIdx = models.findIndex(allM => allM === m);
        const modelId = foundIdx >= 0 ? (foundIdx + 1).toString() : m;
        return {
          id: modelId,
          display: m,
          active: m === currentModel,
        };
      });

      await safeEditMessageText(
        ctx,
        `${ICONS.model} <b>Model Selection</b> (${tierName})\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, false, 0, tier),
        },
      );
      return;
    }

    if (data.startsWith('/model_page ')) {
      const page = parseInt(data.replace('/model_page ', ''), 10);
      const session = sessionManager.getSession(chatId, threadId);
      const currentModel = session?.config?.getModel() || 'unknown';
      const models = await getAvailableModels();
      const start = page * MODELS_PER_PAGE;
      const pageModels = models.slice(start, start + MODELS_PER_PAGE);
      const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);

      safeAnswerCallback(ctx, `Page ${page + 1}`);
      const modelItems = pageModels.map((m, i) => ({
        id: (start + i + 1).toString(),
        display: m,
        active: m === currentModel,
      }));

      await safeEditMessageText(
        ctx,
        `${ICONS.model} <b>Model Selection</b> (Page ${page + 1}/${totalPages})\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page),
        },
      );
      return;
    }

    if (data === '/save') {
      safeAnswerCallback(ctx, 'Saving latest response...');
      const lastContext = messageCache.getLastReplyContextForChat(chatId);
      if (!lastContext || (!lastContext.answerMarkdown.trim() && !lastContext.thinkingMarkdown.trim())) {
        // Fallback: try loading from DB (survives restart)
        const session = sessionManager.getSession(chatId, threadId);
        const convId = session?.conversationId;
        const model = session?.model || '';
        if (convId) {
          const backend = model.includes('DeepSeek') ? 'deepseek' as const : model.includes('Web2API') ? 'web2api' as const : 'gemini-direct' as const;
          const msgs = loadMessages(convId, backend);
          const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            const msgTitle = extractTitleFromMarkdown(lastAssistant.content);
            const filePath = saveMarkdownToAnswerSaveDir({ title: msgTitle, answerMarkdown: lastAssistant.content });
            await ctx.reply(`${ICONS.save} <b>Saved Latest Response</b>\n\nFile: <code>${escapeHtml(filePath)}</code>`, { parse_mode: 'HTML' });
            return;
          }
        }
        await ctx.reply(`${ICONS.warning} <b>No AI response found to save.</b>\n\nGenerate a response first or reply to a message with <code>/save</code>.`, { parse_mode: 'HTML' });
        return;
      }
      try {
        const answerMarkdown = lastContext.answerMarkdown;
        const thinkingMarkdown = lastContext.thinkingMarkdown;
        const title = lastContext.title || extractTitleFromMarkdown(answerMarkdown);
        const filePath = saveMarkdownToAnswerSaveDir({ title, answerMarkdown, thinkingMarkdown });

        await ctx.reply(`${ICONS.save} <b>Saved Latest Response</b>\n\nFile: <code>${escapeHtml(filePath)}</code>`, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error(`Error saving message via callback: ${e}`);
        await ctx.reply(`${ICONS.error} <b>Failed to save:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (data === '/resume' || data.startsWith('/resume ')) {
      safeAnswerCallback(ctx, 'Loading session...');
      let session;
      try {
        session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
      } catch {
        return;
      }

      if (data.startsWith('/resume ')) {
        const targetIdx = data.replace('/resume ', '').trim();
        try {
          const resultMsg = await resumeSession(session, targetIdx);
          await ctx.reply(`${ICONS.success} <b>Session Switched Successfully</b>\n\n${escapeHtml(resultMsg)}`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
        } catch (e) {
          logger.error(`Failed to resume session: ${e}`);
          await ctx.reply(`${ICONS.error} <b>Failed to Switch Session:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
        }
        return;
      }

      try {
        const sessions = await listAvailableSessions(session.config);
        if (sessions.length === 0) {
          await safeEditMessageText(ctx, `${ICONS.info} <b>No saved sessions found.</b>`, {
            parse_mode: 'HTML',
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

        await safeEditMessageText(
          ctx,
          `${ICONS.resume} <b>Restore Session</b>\n\n${sessionListText}\n\n<i>Send <code>/resume &lt;index&gt;</code> to switch, or tap a button below:</i>`,
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
      safeAnswerCallback(ctx, 'Loading status...');
      const session = sessionManager.getSession(chatId, threadId);
      if (!session) {
        await safeEditMessageText(ctx, `${ICONS.warning} <b>No active session.</b>`, {
          parse_mode: 'HTML',
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

      await safeEditMessageText(ctx, stats, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/help') {
      safeAnswerCallback(ctx, 'Loading Help...');
      await safeEditMessageText(ctx, formatHelp(), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/project_browse') {
      safeAnswerCallback(ctx, 'Browsing...');
      const browsePath = getBrowseRoot();
      
      // Update message to show scanning status
      await safeEditMessageText(ctx, `${ICONS.loading} <b>Scanning:</b> <code>${escapeHtml(browsePath)}</code>`, { parse_mode: 'HTML' });

      try {
        const projectManager = sessionManager.getProjectManager();
        const projects = await projectManager.scanDirectory(browsePath, 3);
        await projectManager.saveProjects();

        if (projects.length === 0) {
          await safeEditMessageText(ctx, `${ICONS.info} <b>No projects found</b> in <code>${escapeHtml(browsePath)}</code>.\n\nYou can use <code>/addfolder &lt;path&gt;</code> for manual access.`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const session = sessionManager.getSession(chatId, threadId);
        const currentProjectId = session?.currentProject?.id;

        await safeEditMessageText(
          ctx,
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
        await safeEditMessageText(ctx, `${ICONS.error} <b>Failed to browse directory.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      }
      return;
    }

    if (data === '/project_scan_documents') {
      safeAnswerCallback(ctx, 'Scanning Documents...');
      const scanPath = getBrowseRoot();
      
      // Update message to show scanning status
      await safeEditMessageText(ctx, `${ICONS.loading} <b>Scanning:</b> <code>${escapeHtml(scanPath)}</code>`, { parse_mode: 'HTML' });

      try {
        const projectManager = sessionManager.getProjectManager();
        const projects = await projectManager.scanDirectory(scanPath, 3);
        await projectManager.saveProjects();

        if (projects.length === 0) {
          await safeEditMessageText(ctx, `${ICONS.info} <b>No projects found</b> in <code>${escapeHtml(scanPath)}</code>.\n\nYou can use <code>/addfolder &lt;path&gt;</code> for manual access.`, {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
          return;
        }

        const session = sessionManager.getSession(chatId, threadId);
        const currentProjectId = session?.currentProject?.id;

        await safeEditMessageText(
          ctx,
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
        await safeEditMessageText(ctx, `${ICONS.error} <b>Failed to scan Documents.</b>`, {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        });
      }
      return;
    }

    if (data === '/schedule') {
      safeAnswerCallback(ctx, 'Loading Scheduler...');
      const scheduler = sessionManager.getChatScheduler();
      const tasks = scheduler.getTasksForChat(chatId);

      if (tasks.length === 0) {
        await safeEditMessageText(ctx, `${ICONS.clock} <b>Schedule Manager</b>\n\nAutomate tasks by scheduling messages to be sent at specific times or intervals.\n\n<b>Commands:</b>\n• <code>/schedule add &lt;time&gt; &lt;msg&gt;</code>\n• <code>/schedule recurring &lt;min&gt; &lt;msg&gt;</code>\n• <code>/schedule list</code>\n• <code>/schedule remove &lt;id&gt;</code>\n• <code>/schedule toggle &lt;id&gt;</code>`, {
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

      await safeEditMessageText(ctx, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(),
      });
      return;
    }

    if (data === '/autopilot') {
      safeAnswerCallback(ctx, 'Autopilot Mode');
      await safeEditMessageText(
        ctx,
        `${ICONS.bot} <b>Autopilot Mode</b>\n\nI will work autonomously by auto-replying to myself until your goal is achieved.\n\n<b>Workflow:</b>\n1️⃣ Set a clear goal\n2️⃣ I think → act → verify\n3️⃣ I repeat until goal achieved (Timeout: 30 mins)\n4️⃣ I provide a final summary\n\n<b>Commands:</b>\n• <code>/autopilot &lt;goal&gt;</code> — Start working\n• <code>/autopilot stop</code> — Stop immediately`,
        {
          parse_mode: 'HTML',
          reply_markup: buildMainKeyboard(),
        },
      );
      return;
    }

    // Handle model selection callback
    if (data.startsWith('/model ')) {
      const models = await getAvailableModels();
      const modelArg = data.replace('/model ', '');
      let modelName: string;
      if (modelArg.toLowerCase() === 'auto' || modelArg.includes('Auto')) {
        modelName = AUTO_MODEL_NAME;
      } else {
        const num = parseInt(modelArg, 10);
        modelName =
          !isNaN(num) && num >= 1 && num <= models.length
            ? models[num - 1]
            : modelArg;
      }

      safeAnswerCallback(ctx, `Brain: ${modelName}`);

      try {
        const session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
        session.config!.setModel(modelName, false);
        const backKeyboard = new InlineKeyboard().text(`${ICONS.back} Main Menu`, '/start');
        await safeEditMessageText(
          ctx,
          `${ICONS.model} <b>Brain Switched</b>\n\nNow using: <code>${escapeHtml(modelName)}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: backKeyboard,
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
        safeAnswerCallback(ctx, 'Project not found');
        return;
      }

      safeAnswerCallback(ctx, `Workspace: ${project.name}`);

      const currentSession = sessionManager.getSession(chatId, threadId);
      const currentModel = currentSession?.model;

      try {
        await sessionManager.reset(chatId, {
          ...defaultOptions,
          project,
          model: currentModel || defaultOptions.model,
        }, threadId);

        await safeEditMessageText(
          ctx,
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
      const session = sessionManager.getSession(chatId, threadId);
      const currentProjectId = session?.currentProject?.id;

      safeAnswerCallback(ctx, `Page ${page + 1}`);
      await safeEditMessageText(
        ctx,
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

    await next();
  });
}
