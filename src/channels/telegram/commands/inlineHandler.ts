/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot, Context } from 'grammy';
import type { InlineQueryResultArticle } from '@grammyjs/types';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { markdownToHtml } from '../formatter.js';
import { logger } from '../../../utils/logger.js';
import { ICONS } from '../ui.js';

export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

/**
 * Register Telegram Inline Query handler (`@bot_name query`).
 * Enables real-time AI responses directly from any chat.
 */
export function registerInlineHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  options: InlineHandlerOptions = {},
): void {
  bot.on('inline_query', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const inlineQuery = ctx.inlineQuery;
    if (!inlineQuery || !fromId) return;

    // 1. Whitelist authorization check
    if (options.allowedUsers && options.allowedUsers.length > 0 && !options.allowedUsers.includes(fromId)) {
      const unauthorizedResult: InlineQueryResultArticle = {
        type: 'article',
        id: 'unauthorized',
        title: '⚠️ 未授权访问 / Unauthorized',
        description: '您的 Telegram ID 未在白名单许可列表中。',
        input_message_content: {
          message_text: `${ICONS.warning} <b>未授权访问</b>\n\n您的 Telegram ID (<code>${fromId}</code>) 未获得此 AI Bot 的 Inline 使用权限。`,
          parse_mode: 'HTML',
        },
      };
      await ctx.answerInlineQuery([unauthorizedResult], { cache_time: 10 }).catch(e => {
        logger.error(`Error answering unauthorized inline query: ${e}`);
      });
      return;
    }

    const query = inlineQuery.query.trim();

    // 2. Empty query help hint card
    if (!query) {
      const helpResult: InlineQueryResultArticle = {
        type: 'article',
        id: 'help',
        title: '💡 使用 Gemini/AI 模型解答任何问题',
        description: '示例：@bot_name 简述量子计算 / 翻译成英文...',
        input_message_content: {
          message_text: `${ICONS.bot} <b>Gemini CLI Inline Mode</b>\n\n在任意聊天框中输入 <code>@bot_name 您的提问</code> 即可随时调用 AI 助手。`,
          parse_mode: 'HTML',
        },
      };
      await ctx.answerInlineQuery([helpResult], { cache_time: 5 }).catch(e => {
        logger.error(`Error answering empty inline query: ${e}`);
      });
      return;
    }

    // 3. Process AI query
    try {
      const activeSession = sessionManager.getSession(fromId);
      const modelToUse = activeSession?.config?.getModel() || defaultOptions.model;
      const cwd = defaultOptions.cwd || process.cwd();

      logger.info(`[InlineQuery] Processing query from userId=${fromId}: "${query.slice(0, 50)}..." (model=${modelToUse})`);

      const response = await runAgyPrint({
        prompt: query,
        cwd,
        model: modelToUse,
        proxy: defaultOptions.proxy,
      });

      const rawText = response.output || '无回答内容';
      const htmlContent = markdownToHtml(rawText, false);
      const previewText = rawText.replace(/<[^>]+>/g, '').slice(0, 100);

      const aiResult: InlineQueryResultArticle = {
        type: 'article',
        id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: `🤖 AI: ${query.slice(0, 40)}${query.length > 40 ? '...' : ''}`,
        description: previewText || '点击发送完整回答',
        input_message_content: {
          message_text: `<b>💬 问题：</b> ${escapeHtmlText(query)}\n\n<b>🤖 回答：</b>\n${htmlContent}`,
          parse_mode: 'HTML',
        },
      };

      await ctx.answerInlineQuery([aiResult], { cache_time: 10 }).catch(e => {
        logger.error(`Error answering inline query result: ${e}`);
      });
    } catch (e) {
      logger.error(`Failed to process inline query: ${e}`);
      const errorResult: InlineQueryResultArticle = {
        type: 'article',
        id: `err-${Date.now()}`,
        title: '❌ AI 生成解答失败',
        description: e instanceof Error ? e.message : String(e),
        input_message_content: {
          message_text: `${ICONS.error} <b>Inline AI 处理失败：</b>\n<i>${escapeHtmlText(e instanceof Error ? e.message : String(e))}</i>`,
          parse_mode: 'HTML',
        },
      };
      await ctx.answerInlineQuery([errorResult], { cache_time: 0 }).catch(() => {});
    }
  });
}

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
