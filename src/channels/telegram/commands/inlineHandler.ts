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

const INLINE_TIMEOUT_MS = 2000;

function cleanInlineHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '')
    .trim();
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
        description: '在任意聊天中输入 @bot_name 您的提问',
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

    // 3. Process AI query with strict 2s timeout to prevent Telegram 400 timeout
    try {
      const activeSession = sessionManager.getSession(fromId);
      const modelToUse = activeSession?.config?.getModel() || defaultOptions.model;
      const cwd = defaultOptions.cwd || process.cwd();

      logger.info(`[InlineQuery] Received query from userId=${fromId}: "${query.slice(0, 50)}..."`);

      // Race between agy run and timeout
      let aiResultText: string | null = null;
      try {
        const runPromise = runAgyPrint({
          prompt: query,
          cwd,
          model: modelToUse,
          proxy: defaultOptions.proxy,
        });

        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), INLINE_TIMEOUT_MS));
        const res = await Promise.race([runPromise, timeoutPromise]);

        if (res && typeof res === 'object' && 'output' in res && res.output) {
          aiResultText = res.output;
        }
      } catch (err) {
        logger.warn(`[InlineQuery] Quick model execution error: ${err}`);
      }

      const results: InlineQueryResultArticle[] = [];

      if (aiResultText) {
        // Option A: Fast AI Answer card
        const cleanedHtml = cleanInlineHtml(markdownToHtml(aiResultText, false));
        const previewText = aiResultText.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').slice(0, 100);

        results.push({
          type: 'article',
          id: `ai-${Date.now()}`,
          title: `🤖 AI 解答: ${query.slice(0, 30)}${query.length > 30 ? '...' : ''}`,
          description: previewText || '点击发送 AI 解答',
          input_message_content: {
            message_text: `<b>💬 问题：</b> ${escapeHtmlText(query)}\n\n<b>🤖 回答：</b>\n${cleanedHtml}`,
            parse_mode: 'HTML',
          },
        });
      }

      // Option B: Always present quick-send card (guarantees instantaneous response)
      results.push({
        type: 'article',
        id: `prompt-${Date.now()}`,
        title: `💬 发送提问卡片到当前聊天`,
        description: `问: "${query.slice(0, 50)}..."`,
        input_message_content: {
          message_text: `<b>💬 AI 提问卡片</b>\n\n<b>问题：</b> ${escapeHtmlText(query)}\n\n<i>${ICONS.sparkles} 提问已发送至 AI 助手。</i>`,
          parse_mode: 'HTML',
        },
      });

      await ctx.answerInlineQuery(results, { cache_time: 2 }).catch(e => {
        logger.error(`Error answering inline query result: ${e}`);
      });
    } catch (e) {
      logger.error(`Failed to process inline query: ${e}`);
      const errorResult: InlineQueryResultArticle = {
        type: 'article',
        id: `err-${Date.now()}`,
        title: '❌ 无法处理请求',
        description: e instanceof Error ? e.message : String(e),
        input_message_content: {
          message_text: `${ICONS.error} <b>Inline 处理失败：</b>\n<i>${escapeHtmlText(e instanceof Error ? e.message : String(e))}</i>`,
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
