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

const INLINE_TIMEOUT_MS = 1200;

/** Supported inline model prefix aliases for instant model switching */
const MODEL_PREFIX_MAP: Record<string, string> = {
  '/flash': 'Gemini 3.6 Flash (High)',
  '/pro': 'Web2API: Gemini 3.1 Pro',
  '/deepseek': 'DeepSeek: Flash',
  '/opencode': 'OpenCode: DeepSeek V4 Flash Free',
};

function cleanInlineHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '')
    .trim();
}

/**
 * Resolve target model and clean prompt from inline query string.
 * E.g. "@bot_name /flash 提问" -> { model: 'Gemini 3.6 Flash (High)', prompt: '提问' }
 */
export function parseInlineModelAndPrompt(
  rawQuery: string,
  defaultModel: string,
): { model: string; prompt: string; aliasUsed?: string } {
  const parts = rawQuery.trim().split(/\s+/);
  if (parts.length > 0 && parts[0].startsWith('/')) {
    const alias = parts[0].toLowerCase();
    if (MODEL_PREFIX_MAP[alias]) {
      return {
        model: MODEL_PREFIX_MAP[alias],
        prompt: parts.slice(1).join(' '),
        aliasUsed: alias,
      };
    }
  }
  return { model: defaultModel, prompt: rawQuery.trim() };
}

/**
 * Register Telegram Inline Query handler (`@bot_name query`).
 * Enables real-time AI responses and inline model switching directly from any chat.
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
      await ctx.answerInlineQuery([unauthorizedResult], { cache_time: 10 }).catch(() => {});
      return;
    }

    const rawQuery = inlineQuery.query;
    const activeSession = sessionManager.getSession(fromId);
    const activeModel = activeSession?.config?.getModel() || defaultOptions.model;
    const { model: modelToUse, prompt, aliasUsed } = parseInlineModelAndPrompt(rawQuery, activeModel);

    // 2. Empty query help hint & model selection cards
    if (!prompt) {
      const results: InlineQueryResultArticle[] = [
        {
          type: 'article',
          id: 'help-main',
          title: `💡 当前模型: ${modelToUse}`,
          description: '直接输入问题提问，或使用前缀切换模型 (/flash, /pro...)',
          input_message_content: {
            message_text: `${ICONS.bot} <b>Gemini CLI Inline Mode</b>\n\n当前模型：<code>${modelToUse}</code>\n\n直接输入问题即可调用，或输入前缀切换：\n• <code>/flash 提问</code> - 极速 Flash 模型\n• <code>/pro 提问</code> - 深度推理模型\n• <code>/deepseek 提问</code> - DeepSeek 模型`,
            parse_mode: 'HTML',
          },
        },
        {
          type: 'article',
          id: 'help-flash',
          title: '⚡ 快速使用 /flash 极速模型',
          description: '输入 @bot_name /flash 您的提问',
          input_message_content: {
            message_text: `💡 提示：输入 <code>@bot_name /flash 提问内容</code> 可强制使用 <code>Gemini 3.6 Flash</code> 极速响应。`,
            parse_mode: 'HTML',
          },
        },
        {
          type: 'article',
          id: 'help-pro',
          title: '🧠 快速使用 /pro 深度模型',
          description: '输入 @bot_name /pro 您的提问',
          input_message_content: {
            message_text: `💡 提示：输入 <code>@bot_name /pro 提问内容</code> 可使用 <code>Gemini 3.1 Pro</code> 深度分析。`,
            parse_mode: 'HTML',
          },
        },
      ];
      await ctx.answerInlineQuery(results, { cache_time: 2 }).catch(() => {});
      return;
    }

    // 3. Process AI query with instantaneous guaranteed fallback + 1.2s model race
    try {
      const cwd = defaultOptions.cwd || process.cwd();
      logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} prompt="${prompt.slice(0, 40)}..."`);

      let aiResultText: string | null = null;
      try {
        const runPromise = runAgyPrint({
          prompt,
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
        logger.warn(`[InlineQuery] Model execution error: ${err}`);
      }

      const results: InlineQueryResultArticle[] = [];

      // A. Fast AI Answer (if finished within 1.2s)
      if (aiResultText) {
        const cleanedHtml = cleanInlineHtml(markdownToHtml(aiResultText, false));
        const previewText = aiResultText.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').slice(0, 100);

        results.push({
          type: 'article',
          id: `ai-${Date.now()}`,
          title: `🤖 AI 解答 [${modelToUse}]: ${prompt.slice(0, 30)}`,
          description: previewText || '点击发送完整回答',
          input_message_content: {
            message_text: `<b>💬 问题：</b> ${escapeHtmlText(prompt)}\n\n<b>🤖 回答 (${modelToUse})：</b>\n${cleanedHtml}`,
            parse_mode: 'HTML',
          },
        });
      }

      // B. Instant Prompt Card (Zero-latency fallback, 100% immune to Telegram timeouts)
      results.push({
        type: 'article',
        id: `prompt-${Date.now()}`,
        title: `💬 点击发送提问卡片 (${aliasUsed ? aliasUsed : '默认模型'})`,
        description: `模型: ${modelToUse} | 提问: "${prompt.slice(0, 40)}..."`,
        input_message_content: {
          message_text: `<b>💬 AI 提问卡片</b>\n\n<b>模型：</b> <code>${modelToUse}</code>\n<b>问题：</b> ${escapeHtmlText(prompt)}\n\n<i>${ICONS.sparkles} 提问卡片已发送。</i>`,
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
