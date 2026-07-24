/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot } from 'grammy';
import * as fs from 'node:fs';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { listAvailableSessions, resumeSession } from '../../../core/resume.js';
import { logger } from '../../../utils/logger.js';
import { messageCache } from '../../../utils/messageCache.js';
import { getBrowseRoot, getInboxDir } from '../../../config/userConfig.js';
import { getAvailableModels } from '../../../agy/agyCli.js';
import { loadMessages } from '../../../agy/messageStore.js';
import { ICONS, buildMainKeyboard, buildModelKeyboard, MODELS_PER_PAGE, buildProjectKeyboard, buildResumeKeyboard, formatProjectInfo, formatSessionStats, formatHelp, formatWelcome, escapeHtml } from '../ui.js';
import { extractTitleFromMarkdown } from './helpers.js';
import { PROJECTS_PER_PAGE } from './projectHandlers.js';

export function registerCallbackRouter(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.on('callback_query:data', async (ctx) => {
    // Answer immediately to dismiss Telegram UI loading state
    ctx.answerCallbackQuery().catch(() => {});

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
          model: 'Gemini 3.6 Flash (High)',
        });
        await ctx.editMessageText(
          `${ICONS.new} <b>Session Reset</b>\n\nI've cleared the current context and started a fresh session for you using <code>Gemini 3.6 Flash (High)</code>.\n\n${ICONS.arrow} <i>Send a message to begin.</i>`,
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

      await ctx.editMessageText(
        `${ICONS.model} <b>Model Selection</b> (Page ${page + 1}/${totalPages})\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page),
        },
      );
      return;
    }

    if (data.startsWith('/model_page ')) {
      const page = parseInt(data.replace('/model_page ', ''), 10);
      const session = sessionManager.getSession(chatId);
      const currentModel = session?.config?.getModel() || 'unknown';
      const models = await getAvailableModels();
      const start = page * MODELS_PER_PAGE;
      const pageModels = models.slice(start, start + MODELS_PER_PAGE);
      const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);

      ctx.answerCallbackQuery(`Page ${page + 1}`).catch(e => logger.error(`Failed callback: ${e}`));
      const modelItems = pageModels.map((m, i) => ({
        id: ((page * MODELS_PER_PAGE) + i + 1).toString(),
        display: m,
        active: m === currentModel,
      }));

      await ctx.editMessageText(
        `${ICONS.model} <b>Model Selection</b> (Page ${page + 1}/${totalPages})\n\nSelect the AI brain for this session:\n\nCurrent: <code>${currentModel}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: buildModelKeyboard(modelItems, models.length > start + MODELS_PER_PAGE, page),
        },
      );
      return;
    }

    if (data === '/save') {
      ctx.answerCallbackQuery('Saving latest response...').catch(e => logger.error(`Failed callback: ${e}`));
      const lastContext = messageCache.getLastReplyContext();
      if (!lastContext || (!lastContext.answerMarkdown.trim() && !lastContext.thinkingMarkdown.trim())) {
        // Fallback: try loading from DB (survives restart)
        const session = sessionManager.getSession(chatId);
        const convId = session?.conversationId;
        const model = session?.model || '';
        if (convId) {
          const backend = model.includes('DeepSeek') ? 'deepseek' as const : model.includes('Web2API') ? 'web2api' as const : 'gemini-direct' as const;
          const msgs = loadMessages(convId, backend);
          const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            const msgTitle = extractTitleFromMarkdown(lastAssistant.content);
            let reassembled = '';
            if (msgTitle) reassembled += `# ${msgTitle}\n\n`;
            reassembled += lastAssistant.content;
            const dateStr = new Date().toISOString().slice(0, 10);
            const sanitizeTitle = (msgTitle || 'untitled').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').substring(0, 30);
            const filename = `${dateStr}_${sanitizeTitle}.md`;
            const inboxDir = getInboxDir();
            if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
            fs.writeFileSync(`${inboxDir}/${filename}`, reassembled, 'utf8');
            await ctx.reply(`${ICONS.save} <b>Saved Latest Response</b>\n\nFile: <code>${escapeHtml(filename)}</code>`, { parse_mode: 'HTML' });
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
        let reassembledMarkdown = '';
        if (title) reassembledMarkdown += `# ${title}\n\n`;
        if (thinkingMarkdown && thinkingMarkdown.trim()) {
          reassembledMarkdown += `<details>\n<summary>Thinking Process</summary>\n\n${thinkingMarkdown.trim()}\n\n</details>\n\n`;
        }
        reassembledMarkdown += answerMarkdown;

        const dateStr = new Date().toISOString().slice(0, 10);
        const sanitizeTitle = (title || 'untitled').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').substring(0, 30);
        const filename = `${dateStr}_${sanitizeTitle}.md`;
        const inboxDir = getInboxDir();
        if (!fs.existsSync(inboxDir)) {
          fs.mkdirSync(inboxDir, { recursive: true });
        }
        const filePath = `${inboxDir}/${filename}`;
        fs.writeFileSync(filePath, reassembledMarkdown, 'utf8');

        await ctx.reply(`${ICONS.save} <b>Saved Latest Response</b>\n\nFile: <code>${escapeHtml(filename)}</code>`, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error(`Error saving message via callback: ${e}`);
        await ctx.reply(`${ICONS.error} <b>Failed to save:</b> ${e instanceof Error ? e.message : String(e)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (data === '/resume' || data.startsWith('/resume ')) {
      ctx.answerCallbackQuery('Loading session...').catch(e => logger.error(`Failed callback: ${e}`));
      let session;
      try {
        session = await sessionManager.getOrCreate(chatId, defaultOptions);
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
          await ctx.editMessageText(`${ICONS.info} <b>No saved sessions found.</b>`, {
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

        await ctx.editMessageText(
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
        model: session.config!.getModel(),
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
      const browsePath = getBrowseRoot();
      
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
      const scanPath = getBrowseRoot();
      
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
      const num = parseInt(modelArg, 10);
      const modelName =
        !isNaN(num) && num >= 1 && num <= models.length
          ? models[num - 1]
          : modelArg;

      ctx.answerCallbackQuery(`Brain: ${modelName}`).catch(e => logger.error(`Failed callback: ${e}`));

      try {
        const session = await sessionManager.getOrCreate(chatId, defaultOptions);
        session.config!.setModel(modelName, false);
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
