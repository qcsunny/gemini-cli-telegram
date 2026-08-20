/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file projectHandlers.ts
 * @description Telegram bot handlers for project selection (/project, /projects).
 * Lists available projects with disk usage, lets users switch the active
 * working directory, and shows project directory info.
 */

import type { Bot, Context } from 'grammy';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getBrowseRoot } from '../../../config/userConfig.js';
import { ICONS, buildMainKeyboard, buildProjectKeyboard, formatProjectInfo, escapeHtml } from '../ui.js';

export const PROJECTS_PER_PAGE = 5;

export function registerProjectHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('projects', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
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

    const session = sessionManager.getSession(chatId, threadId);
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

  bot.command('project_select', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
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
      }, threadId);

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

  bot.command('project_browse', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
    if (!chatId) return;

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const session = sessionManager.getSession(chatId, threadId);
    const baseDir = session?.config?.getTargetDir() || process.cwd();
    
    let browsePath: string;
    if (!arg) {
      browsePath = getBrowseRoot();
    } else if (arg.startsWith('~')) {
      browsePath = arg.replace(/^~(?=$|\/|\\)/, os.homedir());
    } else if (arg.startsWith('/')) {
      // Explicit absolute path — allowed as-is (user is whitelisted).
      browsePath = path.resolve(arg);
    } else {
      // Relative path: resolve within the session base dir and clamp any
      // `../` traversal that would escape it.
      const resolved = path.resolve(baseDir, arg);
      const baseRoot = path.resolve(baseDir);
      browsePath = resolved.startsWith(baseRoot + path.sep) || resolved === baseRoot
        ? resolved
        : baseRoot;
      if (browsePath !== resolved) {
        logger.warn(`[project_browse] Clamped traversal "${arg}" to ${baseRoot}`);
      }
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

      const session = sessionManager.getSession(chatId, threadId);
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
}
