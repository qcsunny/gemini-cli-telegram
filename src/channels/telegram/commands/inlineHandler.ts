import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { ProjectInfo, SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { buildFinalBlocks } from '../formatter/blocks.js';
import { formatTokenCount, markdownToIR, renderIRToHtml } from '../formatter/core.js';
import { buildTierAwareChain } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { calculateCost } from '../../../utils/pricing.js';
import { ICONS } from '../ui.js';

export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

const MODEL_TIMEOUT_MS = 60_000;
const RESULTS_TTL = 120_000;

interface PendingResult {
  prompt: string;
  model: string;
  projectPath?: string;
  createdAt: number;
}

const pendingResults = new Map<string, PendingResult>();
const userControllers = new Map<number, AbortController>();
export const fullInlineOutputs = new Map<string, { prompt: string; output: string; model: string; createdAt: number }>();

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RESULTS_TTL;
  for (const [key, val] of pendingResults) {
    if (val.createdAt < cutoff) pendingResults.delete(key);
  }
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

const MODEL_PREFIX_MAP: Record<string, string> = {
  '/flash': 'Gemini 3.6 Flash (High)',
  '/pro': 'Web2API: Gemini 3.1 Pro',
  '/deepseek': 'DeepSeek: Flash',
  '/opencode': 'OpenCode: DeepSeek V4 Flash Free',
};

export function parseInlineModelAndPrompt(
  rawQuery: string,
  defaultModel: string,
  availableProjects: ProjectInfo[] = [],
): {
  model: string;
  prompt: string;
  aliasUsed?: string;
  projectUsed?: ProjectInfo;
} {
  let text = rawQuery.trim();
  let selectedModel = defaultModel;
  let aliasUsed: string | undefined;
  let projectUsed: ProjectInfo | undefined;

  const parts = text.split(/\s+/);
  if (parts.length > 0 && parts[0].startsWith('/')) {
    const alias = parts[0].toLowerCase();
    if (MODEL_PREFIX_MAP[alias]) {
      selectedModel = MODEL_PREFIX_MAP[alias];
      aliasUsed = alias;
      text = parts.slice(1).join(' ').trim();
    }
  }

  const pMatch = text.match(/@p:?(\d+|[^\s]+)/i);
  if (pMatch) {
    const target = pMatch[1];
    text = text.replace(pMatch[0], '').replace(/\s+/g, ' ').trim();

    const num = parseInt(target, 10);
    if (!isNaN(num) && num >= 1 && num <= availableProjects.length) {
      projectUsed = availableProjects[num - 1];
    } else {
      projectUsed = availableProjects.find((p) => p.name.toLowerCase().includes(target.toLowerCase()));
    }
  }

  return {
    model: selectedModel,
    prompt: text,
    aliasUsed,
    projectUsed,
  };
}

export interface FallbackRunResult {
  result: AgyRunResult | null;
  modelUsed: string;
  isFallback: boolean;
}

async function runModelWithFallbackChain(
  prompt: string,
  initialModel: string,
  defaultOptions: SessionOptions,
  signal?: AbortSignal,
  customCwd?: string,
): Promise<FallbackRunResult> {
  const skipModels = new Set<string>();
  const chain = buildTierAwareChain(initialModel, skipModels);

  for (const modelToUse of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeoutCtrl = new AbortController();
      const timeout = setTimeout(() => timeoutCtrl.abort(), MODEL_TIMEOUT_MS);
      try {
        logger.info(`[InlineQuery] Attempting model="${modelToUse}" (${attempt}/2) for initial="${initialModel}"`);
        const result = await runAgyPrint({
          prompt,
          cwd: customCwd || defaultOptions.cwd || process.cwd(),
          model: modelToUse,
          proxy: defaultOptions.proxy,
          signal: signal ? anySignal(signal, timeoutCtrl.signal) : timeoutCtrl.signal,
        });
        clearTimeout(timeout);
        if (result?.output) {
          return {
            result,
            modelUsed: modelToUse,
            isFallback: modelToUse !== initialModel,
          };
        }
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error)?.name === 'AbortError') {
          if (attempt === 2 && modelToUse === chain[chain.length - 1]) return { result: null, modelUsed: initialModel, isFallback: false };
        }
        logger.warn(`[InlineQuery] Attempt ${attempt}/2 failed for model="${modelToUse}": ${err}`);
      }
    }
  }

  return { result: null, modelUsed: initialModel, isFallback: false };
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export function registerInlineHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions = {},
  options: InlineHandlerOptions = {},
): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    if (ctx.callbackQuery?.data === 'inline_thinking') {
      await ctx.answerCallbackQuery({
        text: '🧠 AI 推理引擎正在全量计算中，回答完成后将自动原地更新，请稍候...',
        show_alert: true,
      }).catch(() => {});
    }
  });

  bot.on('inline_query', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const inlineQuery = ctx.inlineQuery;
    logger.info(`🔥 [INLINE_QUERY TRIGGERED] fromId=${fromId} rawQuery="${inlineQuery?.query}"`);
    if (!inlineQuery || !fromId) return;

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
      await ctx.answerInlineQuery([unauthorizedResult], { cache_time: 10, is_personal: true }).catch(() => {});
      return;
    }

    const rawQuery = inlineQuery.query;
    const activeSession = sessionManager.getSession(fromId);
    const sessionModel = activeSession?.config?.getModel();
    const activeModel = sessionModel || defaultOptions.model || '';
    const allProjects = sessionManager.getProjects();
    const { model: modelToUse, prompt, aliasUsed, projectUsed } = parseInlineModelAndPrompt(rawQuery, activeModel, allProjects);

    // Default to active session project if no explicit @p:N flag was provided
    const targetProjectPath = projectUsed?.path || activeSession?.currentProject?.path || defaultOptions.cwd;

    if (!prompt) {
      const projectHelpList = allProjects.slice(0, 5).map((p, idx) => `• <code>@p${idx + 1} 提问</code> — ${escapeHtmlText(p.name)}`).join('\n');
      const results = [
        {
          type: 'article' as const,
          id: 'help-main',
          title: `🤖 Ask AI — Gemini / DeepSeek / OpenCode`,
          description: `Type a question to ask AI (model: ${modelToUse})`,
          input_message_content: {
            message_text: `<b>🤖 AI Inline — @static32bot</b>\n\nType a question after @static32bot to get an AI answer using ${modelToUse}.\n\n<b>Quick model switches:</b>\n• <code>/flash 提问</code> — Gemini 3.6 Flash\n• <code>/pro 提问</code> — Gemini 3.1 Pro\n• <code>/deepseek 提问</code> — DeepSeek Flash\n\n<b>Project switches (@pN):</b>\n${projectHelpList || '• 自动继承 Bot 当前绑定的项目'}`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-flash',
          title: '⚡ @static32bot /flash 提问',
          description: 'Gemini 3.6 Flash — fastest responses',
          input_message_content: {
            message_text: `⚡ <b>Fast mode</b>\n\nUse <code>/flash</code> prefix for quick answers:\n<code>@static32bot /flash 什么是量子计算？</code>\n\nForces Gemini 3.6 Flash model for fast response.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-pro',
          title: '🧠 @static32bot /pro 提问',
          description: 'Gemini 3.1 Pro — deep reasoning',
          input_message_content: {
            message_text: `🧠 <b>Pro / Deep Reasoning</b>\n\nUse <code>/pro</code> prefix for complex analysis:\n<code>@static32bot /pro 请详细解释...</code>\n\nForces Gemini 3.1 Pro model for deep reasoning.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-deepseek',
          title: '🔍 @static32bot /deepseek 提问',
          description: 'DeepSeek Flash model',
          input_message_content: {
            message_text: `🔍 <b>DeepSeek Model</b>\n\nUse <code>/deepseek</code> prefix:\n<code>@static32bot /deepseek 你的问题</code>\n\nForces DeepSeek Flash model.`,
            parse_mode: 'HTML' as const,
          },
        },
      ];
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => {});
      return;
    }

    // Store prompt info (no model startup — zero latency)
    logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} project="${projectUsed?.name || 'default'}" prompt="${prompt.slice(0, 40)}..."`);
    const resultId = `ai-${Date.now()}-${fromId}`;
    pendingResults.set(resultId, { prompt, model: modelToUse, projectPath: targetProjectPath, createdAt: Date.now() });

    try {
      const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
      const initText = `✨ <b>AI 推理引擎已启动</b>\n\n<b>🧠 目标模型：</b> <code>${escapeHtmlText(modelToUse)}</code>\n<b>💬 提问内容：</b>\n<blockquote>${escapeHtmlText(displayPrompt)}</blockquote>\n\n<i>🚀 正在通过 Antigravity 引擎深度推演，回答完成后将自动原地更新。</i>`;

      const results = [
        {
          type: 'article' as const,
          id: resultId,
          title: `🤔 点击发送并开始思考 [${modelToUse}]`,
          description: `点击发送，${prompt.slice(0, 40)}... AI 回答将自动更新`,
          input_message_content: {
            message_text: initText,
            parse_mode: 'HTML' as const,
          },
          reply_markup: {
            inline_keyboard: [[
              { text: `${ICONS.bot} ⏳ AI 正在深度思考中...`, callback_data: 'inline_thinking' }
            ]],
          },
        },
        {
          type: 'article' as const,
          id: `prompt-${Date.now()}`,
          title: `💬 发送提问卡片 (${aliasUsed || '默认模型'})`,
          description: `模型: ${modelToUse} | "${prompt.slice(0, 40)}..."`,
          input_message_content: {
            message_text: `<b>💬 AI 提问卡片</b>\n\n<b>模型：</b> <code>${escapeHtmlText(modelToUse)}</code>\n<b>问题：</b> ${escapeHtmlText(displayPrompt)}\n\n<i>${ICONS.sparkles} 提问卡片已发送。</i>`,
            parse_mode: 'HTML' as const,
          },
        },
      ];

      await ctx.answerInlineQuery(results, { cache_time: 0 });
    } catch (e) {
      logger.error(`Error answering inline query: ${e}`);
      pendingResults.delete(resultId);
    }
  });

  bot.on('chosen_inline_result', async (ctx: Context) => {
    const chosen = ctx.chosenInlineResult;
    logger.info(`🔥 [CHOSEN_INLINE_RESULT DETECTED] result_id=${chosen?.result_id} inline_message_id=${chosen?.inline_message_id} fromId=${chosen?.from?.id}`);

    if (!chosen?.inline_message_id) {
      logger.warn(`[ChosenInline] Missing inline_message_id for result_id=${chosen?.result_id}`);
      return;
    }

    const pending = pendingResults.get(chosen.result_id);
    if (!pending) {
      logger.warn(`[ChosenInline] No pending result found for result_id=${chosen.result_id}`);
      return;
    }

    userControllers.get(chosen.from.id)?.abort();
    const ctrl = new AbortController();
    userControllers.set(chosen.from.id, ctrl);

    logger.info(`[ChosenInline] userId=${chosen.from.id} model=${pending.model} — starting model`);

    const startTime = Date.now();
    try {
      const { result, modelUsed, isFallback } = await runModelWithFallbackChain(
        pending.prompt,
        pending.model,
        defaultOptions,
        ctrl.signal,
        pending.projectPath,
      );
      const duration = result?.durationMs || (Date.now() - startTime);

      if (result?.output) {
        const displayPrompt = pending.prompt.length > 300 ? pending.prompt.slice(0, 300) + '...' : pending.prompt;
        
        let footerParts: string[] = [];
        footerParts.push(`⏱️ ${(duration / 1000).toFixed(1)}s`);
        if (result.usage) {
          const inCount = result.usage.input || 0;
          const outCount = result.usage.output || 0;
          const cachedCount = result.usage.cached || 0;
          const thinkingCount = result.usage.thinking || 0;
          if (inCount) footerParts.push(`📥 In: ${formatTokenCount(inCount)}`);
          if (outCount) footerParts.push(`📤 Out: ${formatTokenCount(outCount)}`);
          const totalTokens = inCount + outCount;
          if (totalTokens > 0) {
            let tokenStr = `🪙 ${formatTokenCount(totalTokens)} tokens`;
            const { totalCost, currency } = calculateCost(modelUsed, inCount, outCount, cachedCount, thinkingCount);
            if (totalCost > 0) {
              const sym = currency === 'CNY' ? '¥' : '$';
              const costStr = totalCost < 0.0001 ? '<0.0001' : totalCost.toFixed(5);
              tokenStr += ` (${sym}${costStr})`;
            }
            footerParts.push(tokenStr);
          }
        }
        const footerText = footerParts.join(' · ');
        const fallbackNote = isFallback ? ` · ⚠️ 选定的 ${pending.model} 暂时不可用，已自动降级` : '';

        const fullMarkdown = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${modelUsed}${fallbackNote})：**\n\n${result.output}`;
        const blocks = buildFinalBlocks(fullMarkdown, undefined, {
          footerText: footerText ? `${footerText}${isFallback ? ' (已自动降级)' : ''}` : undefined,
        });

        const fallbackHtml = `<b>💬 问题：</b> ${escapeHtmlText(displayPrompt)}\n\n<b>🤖 回答 (${escapeHtmlText(modelUsed)}${escapeHtmlText(fallbackNote)})：</b>\n\n${renderIRToHtml(markdownToIR(result.output))}`;
        const finalHtml = footerText ? `${fallbackHtml}\n\n<i>${escapeHtmlText(footerText)}${isFallback ? ' (已自动降级)' : ''}</i>` : fallbackHtml;

        await ctx.api.raw.editMessageText({
          inline_message_id: chosen.inline_message_id,
          text: finalHtml,
          parse_mode: 'HTML',
        });

        logger.info(`[InlineResult] Edited with HTML formatting: userId=${chosen.from.id} model=${pending.model} outputLen=${result.output.length}`);
      } else {
        const displayPrompt = pending.prompt.length > 200 ? pending.prompt.slice(0, 200) + '...' : pending.prompt;
        const failText = `${ICONS.warning} <b>处理失败或超时</b>\n\n<b>模型：</b> ${escapeHtmlText(pending.model)}\n<b>问题：</b> ${escapeHtmlText(displayPrompt)}`;
        await ctx.api.raw.editMessageText({
          inline_message_id: chosen.inline_message_id,
          text: failText,
          parse_mode: 'HTML',
        });
      }
    } catch (e) {
      logger.warn(`[InlineResult] Failed to edit message: ${e}`);
    } finally {
      pendingResults.delete(chosen.result_id);
      userControllers.delete(chosen.from.id);
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
