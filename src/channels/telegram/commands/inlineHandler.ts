import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionManager } from '../../../core/session.js';
import type { ProjectInfo, SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { getAgyDataDir } from '../../../config/userConfig.js';
import { formatTokenCount } from '../formatter/core.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { buildTierAwareChain } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { calculateCost } from '../../../utils/pricing.js';
import { ICONS } from '../ui.js';

export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

const MODEL_TIMEOUT_MS = 120_000;
const RESULTS_TTL = 120_000;

interface PendingResult {
  prompt: string;
  model: string;
  projectPath?: string;
  task?: InlineTask;
  createdAt: number;
  /** Refreshed on every stream chunk to prevent premature TTL expiry on long active streams. */
  lastActiveTime: number;
}

const pendingResults = new Map<string, PendingResult>();
const userControllers = new Map<string, AbortController>();
export const fullInlineOutputs = new Map<string, { prompt: string; output: string; model: string; createdAt: number }>();

interface RegenerateContext {
  prompt: string;
  model: string;
  projectPath?: string;
  fromId: number;
  inlineMessageId: string;
  task?: InlineTask;
  createdAt: number;
}

const regenerateContexts = new Map<string, RegenerateContext>();

/** Paginated pages of a finished answer, keyed by resultId. */
const inlinePages = new Map<string, string[]>();

const ACTION_TTL = 30 * 60_000;

/** Touch the lastActiveTime of a pending result to keep it alive while streaming. */
export function touchPendingResult(resultId: string): void {
  const entry = pendingResults.get(resultId);
  if (entry) entry.lastActiveTime = Date.now();
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RESULTS_TTL;
  for (const [key, val] of pendingResults) {
    // Only remove entries that have been INACTIVE for RESULTS_TTL.
    // Active streams continuously update lastActiveTime, so they are never
    // evicted mid-stream even if the session started more than RESULTS_TTL ago.
    if (val.lastActiveTime < cutoff) pendingResults.delete(key);
  }
  for (const [key, val] of fullInlineOutputs) {
    if (val.createdAt < cutoff) fullInlineOutputs.delete(key);
  }
  for (const [resultId, ctrl] of userControllers) {
    // Only abort controllers whose pendingResult has already been cleaned up
    // (i.e. truly inactive/expired), never abort an active stream.
    if (!pendingResults.has(resultId)) {
      try { ctrl.abort(); } catch {}
      userControllers.delete(resultId);
    }
  }
  const actionCutoff = Date.now() - ACTION_TTL;
  for (const [key, val] of regenerateContexts) {
    if (val.createdAt < actionCutoff) {
      regenerateContexts.delete(key);
      inlinePages.delete(key);
    }
  }
}, 60_000);
cleanupTimer.unref();

/**
 * Serialized, adaptive throttling queue with exponential 429 backoff for Inline message editing.
 */
export class InlineStreamQueue {
  private queue: Promise<void> = Promise.resolve();
  private pendingMarkdown: string | null = null;
  private pendingReplyMarkup: unknown = null;
  private isProcessing = false;
  private nextAllowedTime = 0;
  private currentThrottleMs = 500; // Start with fast 500ms adaptive throttle for smooth typing
  private minThrottleMs = 500;
  private maxThrottleMs = 4000;
  private lastEditTime = 0;
  private lastSentLen = 0;

  constructor(
    private api: any,
    private inlineMessageId: string,
  ) {}

  /**
   * Push a streaming chunk markdown update. Throttled & de-duplicated.
   */
  public enqueueStream(markdown: string): void {
    this.pendingMarkdown = markdown;
    this.scheduleProcess();
  }

  /**
   * Push final completion markdown and flush until success with 429 backoff retry.
   * @param replyMarkup optional inline keyboard attached to the final edit (e.g. regenerate / pagination buttons).
   */
  public async flushFinal(markdown: string, replyMarkup?: unknown): Promise<boolean> {
    this.pendingMarkdown = markdown;
    if (replyMarkup !== undefined) this.pendingReplyMarkup = replyMarkup;
    return new Promise<boolean>((resolve) => {
      this.queue = this.queue.then(async () => {
        const success = await this.executeEdit(true);
        resolve(success);
      });
    });
  }

  private scheduleProcess(): void {
    if (this.isProcessing) return;
    this.queue = this.queue.then(async () => {
      this.isProcessing = true;
      try {
        await this.processPending();
      } finally {
        this.isProcessing = false;
      }
    });
  }

  private async processPending(): Promise<void> {
    if (!this.pendingMarkdown) return;

    const now = Date.now();
    const textDelta = Math.abs(this.pendingMarkdown.length - this.lastSentLen);
    if (now < this.nextAllowedTime || (now - this.lastEditTime < this.currentThrottleMs && textDelta < 15)) {
      const waitMs = Math.max(50, Math.min(this.currentThrottleMs, this.nextAllowedTime - now));
      await new Promise((r) => setTimeout(r, waitMs));
      if (this.pendingMarkdown && Math.abs(this.pendingMarkdown.length - this.lastSentLen) >= 5) {
        await this.executeEdit(false);
      }
      return;
    }

    await this.executeEdit(false);
  }

  private async executeEdit(isFinal: boolean): Promise<boolean> {
    if (!this.pendingMarkdown) return false;

    const targetMarkdown = this.pendingMarkdown;
    let attempts = 0;
    const maxAttempts = isFinal ? 5 : 1;

    while (attempts < maxAttempts) {
      attempts++;
      const now = Date.now();
      if (now < this.nextAllowedTime) {
        await new Promise((r) => setTimeout(r, this.nextAllowedTime - now));
      }

      try {
        const editPayload: Record<string, unknown> = {
          inline_message_id: this.inlineMessageId,
          rich_message: {
            markdown: targetMarkdown,
          },
        };
        if (this.pendingReplyMarkup !== null) {
          editPayload['reply_markup'] = this.pendingReplyMarkup;
        }
        await this.api.raw.editMessageText(editPayload as any);

        this.lastEditTime = Date.now();
        this.lastSentLen = targetMarkdown.length;
        if (targetMarkdown === this.pendingMarkdown) {
          this.pendingMarkdown = null;
        }

        // Gradually recover throttle window towards minThrottleMs on clean success
        this.currentThrottleMs = Math.max(this.minThrottleMs, Math.floor(this.currentThrottleMs * 0.85));
        return true;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        const match429 = errMsg.match(/retry after (\d+)/i);

        if (match429) {
          const retrySec = parseInt(match429[1], 10);
          const backoffMs = (retrySec + 1) * 1000;
          this.nextAllowedTime = Date.now() + backoffMs;

          // Adaptively expand throttle window when 429 occurs
          this.currentThrottleMs = Math.min(this.maxThrottleMs, Math.max(this.currentThrottleMs * 2, backoffMs));
          logger.warn(`[InlineQueue] 429 Rate limited on inline_message_id=${this.inlineMessageId}: waiting ${retrySec}s, new throttleMs=${this.currentThrottleMs}`);

          if (isFinal) {
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          } else {
            break;
          }
        } else {
          if (errMsg.includes('message is not modified')) {
            this.lastSentLen = targetMarkdown.length;
            if (targetMarkdown === this.pendingMarkdown) this.pendingMarkdown = null;
            return true;
          } else {
            logger.warn(`[InlineQueue] Edit failed on inline_message_id=${this.inlineMessageId}: ${errMsg}`);
          }
          break;
        }
      }
    }
    return false;
  }
}

const MODEL_PREFIX_MAP: Record<string, string> = {
  '/flash': 'Gemini 3.6 Flash (High)',
  '/pro': 'Web2API: Gemini 3.1 Pro',
  '/deepseek': 'DeepSeek: Flash',
  '/opencode': 'OpenCode: DeepSeek V4 Flash Free',
};

export type InlineTask = 'translate' | 'summarize' | 'fix' | 'code' | 'image';

const TASK_PREFIX_MAP: Record<string, InlineTask> = {
  '/translate': 'translate',
  '/summarize': 'summarize',
  '/fix': 'fix',
  '/code': 'code',
  '/img': 'image',
};

const TASK_INSTRUCTION: Record<Exclude<InlineTask, 'image'>, string> = {
  translate: '请将以下内容翻译成中文，保持原意与格式：\n\n',
  summarize: '请用简洁的语言总结以下内容，列出要点：\n\n',
  fix: '请分析以下代码/报错信息并给出修复方案，附上修改后的代码：\n\n',
  code: '请给出实现以下需求的完整代码（含必要注释）：\n\n',
};

const THUMBNAIL_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72';
const THUMBNAILS = {
  bot: `${THUMBNAIL_BASE}/1f916.png`,
  sparkles: `${THUMBNAIL_BASE}/2728.png`,
  thinking: `${THUMBNAIL_BASE}/1f914.png`,
  warning: `${THUMBNAIL_BASE}/26a0.png`,
  chat: `${THUMBNAIL_BASE}/1f4ac.png`,
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
  task?: InlineTask;
} {
  let text = rawQuery.trim();
  let selectedModel = defaultModel;
  let aliasUsed: string | undefined;
  let projectUsed: ProjectInfo | undefined;
  let task: InlineTask | undefined;

  const parts = text.split(/\s+/);
  while (parts.length > 0 && parts[0].startsWith('/')) {
    const alias = parts[0].toLowerCase();
    if (MODEL_PREFIX_MAP[alias]) {
      selectedModel = MODEL_PREFIX_MAP[alias];
      aliasUsed = alias;
      parts.shift();
    } else if (TASK_PREFIX_MAP[alias]) {
      task = TASK_PREFIX_MAP[alias];
      parts.shift();
    } else {
      break;
    }
  }
  text = parts.join(' ').trim();

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

  if (task && task !== 'image') {
    const instr = TASK_INSTRUCTION[task];
    text = text ? `${instr}${text}` : instr.trim();
  }

  return {
    model: selectedModel,
    prompt: text,
    aliasUsed,
    projectUsed,
    task,
  };
}

export interface FallbackRunResult {
  result: AgyRunResult | null;
  modelUsed: string;
  isFallback: boolean;
}

export async function runModelWithFallbackChain(
  prompt: string,
  initialModel: string,
  defaultOptions: SessionOptions,
  signal?: AbortSignal,
  customCwd?: string,
  onChunk?: (chunk: string) => void,
  onModelStart?: (modelName: string) => void,
): Promise<FallbackRunResult> {
  const skipModels = new Set<string>();
  const chain = buildTierAwareChain(initialModel, skipModels);

  for (const modelToUse of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeoutCtrl = new AbortController();
      const timeout = setTimeout(() => timeoutCtrl.abort(), MODEL_TIMEOUT_MS);
      try {
        logger.info(`[InlineQuery] Attempting model="${modelToUse}" (${attempt}/2) for initial="${initialModel}"`);
        if (onModelStart) onModelStart(modelToUse);
        const result = await runAgyPrint({
          prompt,
          cwd: customCwd || defaultOptions.cwd || process.cwd(),
          model: modelToUse,
          proxy: defaultOptions.proxy,
          onChunk,
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

const PAGE_CHARS = 2500;
const PAGE_THRESHOLD = 6000;

function splitIntoPages(text: string, pageChars: number = PAGE_CHARS): string[] {
  if (text.length <= pageChars) return [text];
  const pages: string[] = [];
  const chunks = text.split(/\n{2,}/);
  let current = '';
  for (const chunk of chunks) {
    if (current && (current + '\n\n' + chunk).length > pageChars) {
      pages.push(current);
      current = chunk;
    } else {
      current = current ? current + '\n\n' + chunk : chunk;
    }
  }
  if (current) pages.push(current);
  if (pages.length === 0) pages.push(text);
  return pages;
}

async function findNewImageArtifacts(conversationId: string, turnStartTime: number): Promise<string[]> {
  if (!conversationId) return [];
  const artifactDir = path.join(getAgyDataDir(), 'brain', conversationId);
  const images: string[] = [];
  try {
    const files = await fs.readdir(artifactDir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.startsWith('.') || file === 'scratch' || file === '.system_generated' || file === '.user_uploaded') continue;
      const ext = path.extname(file).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) continue;
      const filePath = path.join(artifactDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs >= turnStartTime - 2000) {
        images.push(filePath);
      }
    }
  } catch (e) {
    logger.warn(`[InlineHandler] Error scanning image artifacts: ${e}`);
  }
  return images.sort((a, b) => a.localeCompare(b));
}

export function registerInlineHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions = {},
  options: InlineHandlerOptions = {},
): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const inlineMessageId = ctx.callbackQuery?.inline_message_id;
    if (!data || !inlineMessageId) return;

    if (data === 'inline_thinking') {
      await ctx.answerCallbackQuery({
        text: '🧠 AI 推理引擎正在全量计算中，回答完成后将自动原地更新，请稍候...',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    if (data.startsWith('inline_regenerate:')) {
      const resultId = data.slice('inline_regenerate:'.length);
      const regen = regenerateContexts.get(resultId);
      if (!regen) {
        await ctx.answerCallbackQuery({ text: '❌ 会话已过期，请重新发起提问。', show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: '🔄 正在重新生成回答，请稍候...' }).catch(() => {});
      const ctrl = new AbortController();
      userControllers.set(resultId, ctrl);
      const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
      let accumulatedText = '';
      let activeModelName = regen.model;
      const onModelStart = (modelName: string) => { accumulatedText = ''; activeModelName = modelName; };
      const onChunk = (chunk: string) => {
        accumulatedText += chunk;
        touchPendingResult(resultId);
        // Image task message becomes a photo after first run — text streaming
        // edits would fail ("no text in message to edit"), so skip them.
        if (regen.task === 'image') return;
        if (accumulatedText.trim().length > 0) {
          const displayPrompt = regen.prompt.length > 300 ? regen.prompt.slice(0, 300) + '...' : regen.prompt;
          const streamMarkdown = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${activeModelName})：**\n\n${accumulatedText}\n\n_✍️ AI 正在实时打字更新中..._`;
          streamQueue.enqueueStream(streamMarkdown);
        }
      };
      try {
        await runInlineGeneration(ctx, sessionManager, defaultOptions, {
          resultId,
          inlineMessageId,
          fromId: regen.fromId,
          prompt: regen.prompt,
          model: regen.model,
          projectPath: regen.projectPath,
          task: regen.task,
          ctrl,
          streamQueue,
          onModelStart,
          onChunk,
        });
      } catch (e) {
        logger.warn(`[InlineResult] Regenerate failed: ${e}`);
      } finally {
        userControllers.delete(resultId);
      }
      return;
    }

    if (data.startsWith('inline_page:')) {
      const [resultId, pageIdxStr] = data.slice('inline_page:'.length).split(':');
      const pageIdx = parseInt(pageIdxStr, 10);
      const pages = inlinePages.get(resultId);
      if (!pages || Number.isNaN(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) {
        await ctx.answerCallbackQuery({ text: '❌ 分页已过期。', show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: { markdown: pages[pageIdx] },
        reply_markup: {
          inline_keyboard: [
            [
              ...(pageIdx > 0 ? [{ text: '◀️ 上一页', callback_data: `inline_page:${resultId}:${pageIdx - 1}` }] : []),
              { text: `${pageIdx + 1}/${pages.length}`, callback_data: 'inline_noop' },
              ...(pageIdx < pages.length - 1 ? [{ text: '下一页 ▶️', callback_data: `inline_page:${resultId}:${pageIdx + 1}` }] : []),
            ],
            [{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }],
          ],
        },
      } as any).catch((e: Error) => logger.warn(`[InlineResult] Page edit failed: ${e}`));
      return;
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
        thumbnail_url: THUMBNAILS.warning,
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
    const { model: modelToUse, prompt, aliasUsed, projectUsed, task } = parseInlineModelAndPrompt(rawQuery, activeModel, allProjects);

    // Default to active session project if no explicit @p:N flag was provided
    const targetProjectPath = projectUsed?.path || activeSession?.currentProject?.path || defaultOptions.cwd;

    if (!prompt && task !== 'image') {
      const projectHelpList = allProjects.slice(0, 5).map((p, idx) => `• <code>@p${idx + 1} 提问</code> — ${escapeHtmlText(p.name)}`).join('\n');
      const results = [
        {
          type: 'article' as const,
          id: 'help-main',
          title: `🤖 Ask AI — Gemini / DeepSeek / OpenCode`,
          description: `Type a question to ask AI (model: ${modelToUse})`,
          thumbnail_url: THUMBNAILS.bot,
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
          thumbnail_url: THUMBNAILS.sparkles,
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
          thumbnail_url: THUMBNAILS.thinking,
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
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🔍 <b>DeepSeek Model</b>\n\nUse <code>/deepseek</code> prefix:\n<code>@static32bot /deepseek 你的问题</code>\n\nForces DeepSeek Flash model.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-task',
          title: '🎯 任务型前缀：翻译 / 总结 / 修复 / 代码 / 图片',
          description: '/translate /summarize /fix /code /img 一键调用',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🎯 <b>任务型前缀</b>\n\n在提问前加前缀即可一键调用专用模式，可与模型前缀混用（如 <code>/flash /summarize ...</code>）：\n\n🌐 <code>/translate 内容</code> — 翻译成中文\n📋 <code>/summarize 内容</code> — 总结要点\n🛠️ <code>/fix 代码/报错</code> — 分析修复\n💻 <code>/code 需求</code> — 生成完整代码\n🖼️ <code>/img 提示词</code> — 生成图片（原地内嵌显示）`,
            parse_mode: 'HTML' as const,
          },
        },
      ];
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => {});
      return;
    }

    // Store prompt info (no model startup — zero latency)
    logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} task=${task || 'chat'} project="${projectUsed?.name || 'default'}" prompt="${prompt.slice(0, 40)}..."`);
    const resultId = `ai-${Date.now()}-${fromId}`;
    pendingResults.set(resultId, { prompt, model: modelToUse, projectPath: targetProjectPath, task, createdAt: Date.now(), lastActiveTime: Date.now() });

    try {
      const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
      const taskLabel = task === 'image'
        ? '🖼️ **图像生成模式**'
        : task === 'translate' ? '🌐 **翻译模式**'
        : task === 'summarize' ? '📋 **总结模式**'
        : task === 'fix' ? '🛠️ **修复模式**'
        : task === 'code' ? '💻 **代码模式**'
        : undefined;
      const initTitle = task === 'image'
        ? `🖼️ 点击生成图片 [${modelToUse}]`
        : task === 'translate' ? `🌐 点击翻译 [${modelToUse}]`
        : task === 'summarize' ? `📋 点击总结 [${modelToUse}]`
        : task === 'fix' ? `🛠️ 点击修复 [${modelToUse}]`
        : task === 'code' ? `💻 点击生成代码 [${modelToUse}]`
        : `🤔 点击发送并开始思考 [${modelToUse}]`;
      let initMarkdown: string;
      if (task === 'image') {
        initMarkdown = `**🎨 图像生成模式**\n\n**💬 提示词：**\n> ${displayPrompt}\n\n*🚀 正在生成图片，完成后将自动原地更新。*`;
      } else {
        const modelLine = `**🧠 目标模型：** \`${modelToUse}\`\n`;
        initMarkdown = `${taskLabel ? taskLabel + '\n\n' : ''}✨ **AI 推理引擎已启动**\n\n${modelLine}**💬 提问内容：**\n> ${displayPrompt}\n\n*🚀 正在深度推演，回答完成后将自动原地更新。*`;
      }

      const results = [
        {
          type: 'article' as const,
          id: resultId,
          title: initTitle,
          description: `${task === 'image' ? '生成图片' : `点击发送，${prompt.slice(0, 40)}...`} AI ${task === 'image' ? '图片' : '回答'}将自动更新`,
          thumbnail_url: task === 'image' ? THUMBNAILS.sparkles : THUMBNAILS.thinking,
          input_message_content: {
            rich_message: {
              markdown: initMarkdown,
            },
          } as any,
        },
        {
          type: 'article' as const,
          id: `prompt-${Date.now()}`,
          title: `💬 发送提问卡片 (${aliasUsed || '默认模型'})`,
          description: `模型: ${modelToUse} | "${prompt.slice(0, 40)}..."`,
          thumbnail_url: THUMBNAILS.chat,
          input_message_content: {
            rich_message: {
              markdown: `**💬 AI 提问卡片**\n\n**模型：** \`${modelToUse}\`\n**问题：** ${displayPrompt}\n\n*${ICONS.sparkles} 提问卡片已发送。*`,
            },
          } as any,
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

    userControllers.get(chosen.result_id)?.abort();
    const ctrl = new AbortController();
    userControllers.set(chosen.result_id, ctrl);

    logger.info(`[ChosenInline] userId=${chosen.from.id} resultId=${chosen.result_id} model=${pending.model} task=${pending.task || 'chat'} — starting model`);

    const streamQueue = new InlineStreamQueue(ctx.api, chosen.inline_message_id);

    let accumulatedText = '';
    let activeModelName = pending.model;

    const onModelStart = (modelName: string) => {
      accumulatedText = '';
      activeModelName = modelName;
    };

    const onChunk = (chunk: string) => {
      accumulatedText += chunk;
      // BUG-01: Refresh lastActiveTime on every chunk so the cleanup timer
      // never kills an actively-streaming long response.
      touchPendingResult(chosen.result_id);
      if (accumulatedText.trim().length > 0) {
        const displayPrompt = pending.prompt.length > 300 ? pending.prompt.slice(0, 300) + '...' : pending.prompt;
        const streamMarkdown = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${activeModelName})：**\n\n${accumulatedText}\n\n_✍️ AI 正在实时打字更新中..._`;
        streamQueue.enqueueStream(streamMarkdown);
      }
    };

    try {
      await runInlineGeneration(ctx, sessionManager, defaultOptions, {
        resultId: chosen.result_id,
        inlineMessageId: chosen.inline_message_id,
        fromId: chosen.from.id,
        prompt: pending.prompt,
        model: pending.model,
        projectPath: pending.projectPath,
        task: pending.task,
        ctrl,
        streamQueue,
        onModelStart,
        onChunk,
      });
    } catch (e) {
      logger.warn(`[InlineResult] Failed to edit message: ${e}`);
    } finally {
      pendingResults.delete(chosen.result_id);
      userControllers.delete(chosen.result_id);
    }
  });
}

interface InlineGenerationContext {
  resultId: string;
  inlineMessageId: string;
  fromId: number;
  prompt: string;
  model: string;
  projectPath?: string;
  task?: InlineTask;
  ctrl: AbortController;
  streamQueue: InlineStreamQueue;
  onModelStart: (modelName: string) => void;
  onChunk: (chunk: string) => void;
}

async function runInlineGeneration(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  gctx: InlineGenerationContext,
): Promise<void> {
  const {
    resultId, inlineMessageId, fromId, prompt, model, projectPath,
    task, ctrl, streamQueue, onModelStart, onChunk,
  } = gctx;

  // Keep regenerate context alive so the 🔄 button can re-run this prompt.
  regenerateContexts.set(resultId, {
    prompt,
    model,
    projectPath,
    fromId,
    inlineMessageId,
    task,
    createdAt: Date.now(),
  });

  const { result, modelUsed, isFallback } = await runModelWithFallbackChain(
    prompt,
    model,
    defaultOptions,
    ctrl.signal,
    projectPath,
    onChunk,
    onModelStart,
  );

  if (task === 'image') {
    await finalizeImageResult(ctx, resultId, inlineMessageId, fromId, prompt, result, modelUsed);
    return;
  }

  if (result?.output) {
    const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

    let footerParts: string[] = [];
    footerParts.push(`⏱️ ${((result.durationMs || 1000) / 1000).toFixed(1)}s`);
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

    const cleanOutput = stripWholeMessageCodeFence(result.output);
    const rawOutputLen = cleanOutput.length;

    let fullMarkdown: string;
    let replyMarkup: unknown;
    let isCollapsible = false;
    let pageCount = 1;

      if (cleanOutput.trim().length > 250) {
      if (cleanOutput.length > PAGE_THRESHOLD) {
        // Long answer → paginate while keeping per-page <details> fold.
        const pages = splitIntoPages(cleanOutput);
        pageCount = pages.length;
        inlinePages.set(resultId, pages);
        const header = `**💬 问题：** ${displayPrompt}`;
        const pageMarkdowns = pages.map((page) => {
          const summaryTitle = `💡 展开本页 AI 回答 (${modelUsed} · ${page.length} 字)`;
          const details = `<details><summary>${summaryTitle}</summary>\n\n${page}\n\n</details>`;
          const footer = footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : '';
          return `${header}\n\n${details}${footer}`;
        });
        fullMarkdown = pageMarkdowns[0];
        const baseButtons: { text: string; callback_data: string }[] = [
          { text: '◀️ 上一页', callback_data: 'inline_noop' },
          { text: `1/${pageCount}`, callback_data: 'inline_noop' },
          { text: '下一页 ▶️', callback_data: `inline_page:${resultId}:1` },
        ];
        replyMarkup = {
          inline_keyboard: [
            baseButtons.filter((b) => !(b.text === '◀️ 上一页')),
            [{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }],
          ],
        };
      } else {
        // Medium answer → single collapsible fold (existing behavior)
        const summaryTitle = `💡 点击展开 AI 完整回答 (${modelUsed} · ${rawOutputLen} 字)`;
        const bodyMarkdown = `<details><summary>${summaryTitle}</summary>\n\n${cleanOutput}\n\n</details>`;
        isCollapsible = true;
        fullMarkdown = `**💬 问题：** ${displayPrompt}\n\n${bodyMarkdown}${footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : ''}`;
        replyMarkup = {
          inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
        };
      }
    } else {
      // Short answer → plain text
      fullMarkdown = `**💬 问题：** ${displayPrompt}\n\n${cleanOutput}${footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : ''}`;
      replyMarkup = {
        inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
      };
    }

    logger.info(`[InlineResult] Submitting final flush edit: userId=${fromId} rawOutputLen=${rawOutputLen} fullMarkdownLen=${fullMarkdown.length} isCollapsible=${isCollapsible}`);

    const success = await streamQueue.flushFinal(fullMarkdown, replyMarkup);
    if (success) {
      logger.info(`[InlineResult] Successfully flushed final inline message: inline_message_id=${inlineMessageId} userId=${fromId}`);
    }
  } else {
    const displayPrompt = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;
    const failText = `<b>💬 问题：</b> ${escapeHtmlText(displayPrompt)}\n\n⚠️ <b>生成回答失败</b>\n模型未返回有效的文本输出，请重试。`;
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      text: failText,
      parse_mode: 'HTML',
    } as any).catch(() => {});
  }
}

async function finalizeImageResult(
  ctx: Context,
  resultId: string,
  inlineMessageId: string,
  fromId: number,
  prompt: string,
  result: AgyRunResult | null,
  modelUsed: string,
): Promise<void> {
  const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

  if (!result?.conversationId) {
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      text: `<b>🎨 图像生成失败</b>\n模型未返回会话信息，请重试。`,
      parse_mode: 'HTML',
    } as any).catch(() => {});
    return;
  }

  const images = await findNewImageArtifacts(result.conversationId, Date.now() - (result.durationMs || 60_000));
  if (images.length === 0) {
    const output = (result.output || '').trim();
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      rich_message: {
        markdown: `**🎨 图像生成结果**\n\n**💬 提示词：** ${displayPrompt}\n\n${output || '模型未生成图片文件。'}`,
      },
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
      },
    } as any).catch(() => {});
    return;
  }

  const imagePath = images[images.length - 1];

  // Inline messages can only reference media via a URL or an existing
  // file_id (no local upload). Upload the file through a transient rich-message
  // relay to the user's private chat to obtain a file_id, then delete the relay
  // message so the image only ever appears in-place in the inline message.
  let fileId: string | null = null;
  let relayMessageId: number | null = null;
  try {
    const relayMediaId = `img${Date.now().toString(36)}`;
    const sentMsg = await ctx.api.sendRichMessage(fromId, {
      markdown: `![生成的图片](tg://photo?id=${relayMediaId})\n\n*上传中转中...*`,
      media: [{ id: relayMediaId, media: { type: 'photo', media: new InputFile(imagePath) } }],
    });
    relayMessageId = sentMsg?.message_id ?? null;
    const photoBlock = (sentMsg?.rich_message?.blocks as Array<Record<string, any>> | undefined)?.find((b) => b?.['type'] === 'photo');
    const sizes: Array<{ file_id: string; file_size?: number }> = photoBlock?.['photo'] ?? [];
    const largest = sizes.slice().sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    fileId = largest?.file_id || null;
    logger.info(`[InlineResult] Uploaded image via rich-message relay, file_id=${fileId ? fileId.slice(0, 24) + '...' : 'NONE'}`);
  } catch (e) {
    logger.error(`[InlineResult] Failed to relay-upload image: ${e}`);
  } finally {
    // Remove the transient relay copy so the image is only shown in the inline message.
    if (relayMessageId != null) {
      await ctx.api.deleteMessage(fromId, relayMessageId).catch(() => {});
    }
  }

  const caption = `**💬 提示词：** ${displayPrompt}\n_模型: ${modelUsed}_`;
  const regenButton = {
    inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
  };

  if (fileId) {
    // Render the image in-place AND rich text via rich_message: the markdown
    // references the attached photo through tg://photo?id=, with the actual
    // media supplied in the media array. editMessageMedia cannot carry
    // rich_message, so editMessageText is the correct transport here.
    const mediaId = `img${Date.now().toString(36)}`;
    const richMarkdown = `![生成的图片](tg://photo?id=${mediaId})\n\n${caption}\n\n_🖼️ 图片已生成，可点击 🔄 重新生成。_`;
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      rich_message: {
        markdown: richMarkdown,
        media: [{ id: mediaId, media: { type: 'photo', media: fileId } }],
      },
      reply_markup: regenButton,
    } as any).catch((e: Error) => {
      logger.error(`[InlineResult] rich_message media edit failed, falling back to text: ${e}`);
      const fallbackText = `**🖼️ 图片已生成**\n\n${caption}\n\n_⚠️ 原地渲染失败。_`;
      return ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: { markdown: fallbackText },
        reply_markup: regenButton,
      } as any).catch(() => {});
    });
    return;
  }

  // No file_id (relay upload failed): describe the image as text.
  const finalText = `**🖼️ 图片已生成**\n\n${caption}\n\n_⚠️ 未能上传渲染（请先给机器人发消息开启私聊）_\n\n_文件: ${path.basename(imagePath)}_`;
  await ctx.api.raw.editMessageText({
    inline_message_id: inlineMessageId,
    rich_message: { markdown: finalText },
    reply_markup: regenButton,
  } as any).catch(() => {});
}

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
