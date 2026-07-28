/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { markdownToRichBlocks } from '../formatter/blocks.js';
import { logger } from '../../../utils/logger.js';
import { ICONS } from '../ui.js';

export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

const MODEL_TIMEOUT_MS = 60_000;
const RESULTS_TTL = 120_000;

interface PendingResult {
  prompt: string;
  model: string;
  promise: Promise<AgyRunResult | null>;
  createdAt: number;
}

const pendingResults = new Map<string, PendingResult>();
const userControllers = new Map<number, AbortController>();

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RESULTS_TTL;
  for (const [key, val] of pendingResults) {
    if (val.createdAt < cutoff) pendingResults.delete(key);
  }
  // Also clean stale user controllers (no pending results for that user)
  const activeUsers = new Set<string>();
  for (const key of pendingResults.keys()) {
    const parts = key.split('-');
    if (parts.length >= 3) activeUsers.add(parts[2]);
  }
  for (const [userId, ctrl] of userControllers) {
    if (!activeUsers.has(String(userId))) {
      try { ctrl.abort(); } catch {}
      userControllers.delete(userId);
    }
  }
}, 60_000);
cleanupTimer.unref();

/** Supported inline model prefix aliases for instant model switching */
const MODEL_PREFIX_MAP: Record<string, string> = {
  '/flash': 'Gemini 3.6 Flash (High)',
  '/pro': 'Web2API: Gemini 3.1 Pro',
  '/deepseek': 'DeepSeek: Flash',
  '/opencode': 'OpenCode: DeepSeek V4 Flash Free',
};

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

async function runModelWithTimeout(
  prompt: string,
  modelToUse: string,
  defaultOptions: SessionOptions,
  signal?: AbortSignal,
): Promise<AgyRunResult | null> {
  const timeoutCtrl = new AbortController();
  const timeout = setTimeout(() => timeoutCtrl.abort(), MODEL_TIMEOUT_MS);
  try {
    const result = await runAgyPrint({
      prompt,
      cwd: defaultOptions.cwd || process.cwd(),
      model: modelToUse,
      proxy: defaultOptions.proxy,
      signal: signal ? anySignal(signal, timeoutCtrl.signal) : timeoutCtrl.signal,
    });
    return result;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null;
    logger.warn(`[InlineQuery] Model execution error: ${err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
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
      const unauthorizedResult = {
        type: 'article' as const,
        id: 'unauthorized',
        title: '⚠️ 未授权访问 / Unauthorized',
        description: '您的 Telegram ID 未在白名单许可列表中。',
        input_message_content: {
          message_text: `${ICONS.warning} <b>未授权访问</b>\n\n您的 Telegram ID (<code>${fromId}</code>) 未获得此 AI Bot 的 Inline 使用权限。`,
          parse_mode: 'HTML' as const,
        },
      };
      await ctx.answerInlineQuery([unauthorizedResult], { cache_time: 10 }).catch(() => {});
      return;
    }

    const rawQuery = inlineQuery.query;
    const activeSession = sessionManager.getSession(fromId);
    const sessionModel = activeSession?.config?.getModel();
    const activeModel = sessionModel || defaultOptions.model || '';
    const { model: modelToUse, prompt, aliasUsed } = parseInlineModelAndPrompt(rawQuery, activeModel);

    // 2. Empty query help hint & model selection cards
    if (!prompt) {
      const results = [
        {
          type: 'article' as const,
          id: 'help-main',
          title: `💡 当前模型: ${modelToUse}`,
          description: '直接输入问题提问，或使用前缀切换模型 (/flash, /pro...)',
          input_message_content: {
            message_text: `${ICONS.bot} <b>Gemini CLI Inline Mode</b>\n\n当前模型：<code>${modelToUse}</code>\n\n直接输入问题即可调用，或输入前缀切换：\n• <code>/flash 提问</code> - 极速 Flash 模型\n• <code>/pro 提问</code> - 深度推理模型\n• <code>/deepseek 提问</code> - DeepSeek 模型`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-flash',
          title: '⚡ 快速使用 /flash 极速模型',
          description: '输入 @bot_name /flash 您的提问',
          input_message_content: {
            message_text: `💡 提示：输入 <code>@bot_name /flash 提问内容</code> 可强制使用 <code>Gemini 3.6 Flash</code> 极速响应。`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-pro',
          title: '🧠 快速使用 /pro 深度模型',
          description: '输入 @bot_name /pro 您的提问',
          input_message_content: {
            message_text: `💡 提示：输入 <code>@bot_name /pro 提问内容</code> 可使用 <code>Gemini 3.1 Pro</code> 深度分析。`,
            parse_mode: 'HTML' as const,
          },
        },
      ];
      await ctx.answerInlineQuery(results, { cache_time: 2 }).catch(() => {});
      return;
    }

    // 3. Cancel previous model execution for this user, start new one
    logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} prompt="${prompt.slice(0, 40)}..."`);

    userControllers.get(fromId)?.abort();
    const ctrl = new AbortController();
    userControllers.set(fromId, ctrl);

    const resultId = `ai-${Date.now()}-${fromId}`;
    const modelPromise = runModelWithTimeout(prompt, modelToUse, defaultOptions, ctrl.signal);
    pendingResults.set(resultId, { prompt, model: modelToUse, promise: modelPromise, createdAt: Date.now() });

    // 4. Answer inline query instantly with placeholder cards
    try {
      const results = [
        {
          type: 'article' as const,
          id: resultId,
          title: `🤔 思考中... [${modelToUse}]`,
          description: `点击发送，${prompt.slice(0, 40)}... AI 回答将自动更新`,
          input_message_content: {
            message_text: `<b>🤔 AI 正在思考中...</b>\n\n<b>模型：</b> <code>${escapeHtmlText(modelToUse)}</code>\n<b>问题：</b> ${escapeHtmlText(prompt)}\n\n回答完成后将自动更新。`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: `prompt-${Date.now()}`,
          title: `💬 发送提问卡片 (${aliasUsed || '默认模型'})`,
          description: `模型: ${modelToUse} | "${prompt.slice(0, 40)}..."`,
          input_message_content: {
            message_text: `<b>💬 AI 提问卡片</b>\n\n<b>模型：</b> <code>${escapeHtmlText(modelToUse)}</code>\n<b>问题：</b> ${escapeHtmlText(prompt)}\n\n<i>${ICONS.sparkles} 提问卡片已发送。</i>`,
            parse_mode: 'HTML' as const,
          },
        },
      ];

      await ctx.answerInlineQuery(results, { cache_time: 0, button: { text: '打开私聊', start_parameter: 'inline' } });
    } catch (e) {
      logger.error(`Error answering inline query: ${e}`);
      pendingResults.delete(resultId);
    }
  });

  // 5. Chosen inline result — edit placeholder with AI answer via native rich blocks
  bot.on('chosen_inline_result', async (ctx: Context) => {
    const chosen = ctx.chosenInlineResult;
    if (!chosen?.inline_message_id) return;

    const pending = pendingResults.get(chosen.result_id);
    if (!pending) return;

    try {
      const result = await pending.promise;

      if (result?.output) {
        const markdown = `**💬 问题：** ${pending.prompt}\n\n**🤖 回答 (${pending.model})：**\n\n${result.output}`;
        const blocks = markdownToRichBlocks(markdown);

        await ctx.api.raw.editMessageText({
          inline_message_id: chosen.inline_message_id,
          rich_message: { blocks },
        });

        logger.info(`[InlineResult] Edited: userId=${chosen.from.id} model=${pending.model}`);
      } else {
        await ctx.api.raw.editMessageText({
          inline_message_id: chosen.inline_message_id,
          rich_message: { blocks: [{ type: 'paragraph', text: `${ICONS.warning} 处理失败或超时\n\n模型：${pending.model}\n问题：${pending.prompt}` }] },
        });
      }
    } catch (e) {
      logger.warn(`[InlineResult] Failed to edit message: ${e}`);
    } finally {
      pendingResults.delete(chosen.result_id);
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
