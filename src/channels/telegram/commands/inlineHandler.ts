import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionManager } from '../../../core/session.js';
import type { ProjectInfo, SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { getAgyDataDir } from '../../../config/userConfig.js';
import { formatTokenCount, findSafeCutPoint } from '../formatter/core.js';
import { markdownToRichBlocks } from '../formatter/blocks.js';
import type { RichBlock } from '../richMessage.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { buildTierAwareChain, getEffectiveModelOrder } from '../../../core/modelRegistry.js';
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

/** In-progress /v multi-model comparison state, keyed by resultId. */
const compareContexts = new Map<string, CompareContext>();

/** Check whether a resultId belongs to a multi-model comparison task. */
export function isCompareInlineResult(resultId: string): boolean {
  return compareContexts.has(resultId) || regenerateContexts.get(resultId)?.task === 'compare';
}

export interface InlinePage {
  markdown?: string;
  blocks?: RichBlock[];
}

/** Paginated pages of a finished answer, keyed by resultId. */
const inlinePages = new Map<string, InlinePage[]>();

/** Max models user can pick for a /v multi-model comparison. */
export const MAX_COMPARE_MODELS = 3;
/** Max candidate models offered per page in the picker. */
const COMPARE_MODELS_PER_PAGE = 4;

interface CompareContext {
  resultId: string;
  inlineMessageId: string;
  fromId: number;
  prompt: string;
  projectPath?: string;
  /** Ordered candidate model list offered to the user. */
  candidates: string[];
  /** Current page index (0-based) of candidate selection. */
  currentPage: number;
  /** Indices into `candidates` that the user has selected so far. */
  selectedIdx: number[];
  createdAt: number;
}

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
  for (const [key, val] of compareContexts) {
    if (val.createdAt < actionCutoff) {
      compareContexts.delete(key);
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
    /** Time scaling factor for backoff/throttle waits. Tests inject a tiny value. */
    private waitScale = 1,
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
      await new Promise((r) => setTimeout(r, waitMs * this.waitScale));
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
        await new Promise((r) => setTimeout(r, (this.nextAllowedTime - now) * this.waitScale));
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
          const backoffMs = (retrySec + 1) * 1000 * this.waitScale;
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

export type InlineTask = 'translate' | 'summarize' | 'image' | 'compare';
const TASK_PREFIX_MAP: Record<string, InlineTask> = {
  '/translate': 'translate',
  '/summarize': 'summarize',
  '/img': 'image',
  '/v': 'compare',
};

export const IMAGE_TASK_INSTRUCTION =
  '请使用 generate_image 工具为以下主题生成图片（可一次生成多张不同风格/构图的图片）。只调用工具生成图片，不要用文字描述图片：\n\n';

/** Max photos a <tg-collage> / album can contain. */
export const MAX_COLLAGE_IMAGES = 10;

/** Max model-suggestion cards appended to inline query results. */
export const MAX_MODEL_SUGGESTIONS = 5;

/** Fallback model suggestions shown when no model keyword matched. */
const FALLBACK_MODEL_SUGGESTIONS = [
  'Gemini 3.6 Flash (High)',
  'Web2API: Gemini 3.1 Pro',
  'DeepSeek: Flash',
  'Claude Sonnet 4.6 (Thinking)',
  'OpenCode: DeepSeek V4 Flash Free',
];

const CHANNEL_PREFIX_RE = /^(Web2API|DeepSeek|OpenCode)\s*:\s*/i;

/** Strips the channel prefix so "Web2API: Gemini 3.1 Pro" matches "gemini 3.1 pro". */
function normalizeModelName(name: string): string {
  return name.replace(CHANNEL_PREFIX_RE, '').toLowerCase();
}

/**
 * Fuzzy-matches a query against available model names.
 * Each query token that appears as a substring of a normalized model name scores +1.
 * Returns up to `limit` models sorted by descending score.
 */
export function fuzzyMatchModels(query: string, models: string[], limit: number = MAX_MODEL_SUGGESTIONS): string[] {
  const tokens = query
    .toLowerCase()
    .replace(CHANNEL_PREFIX_RE, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const scored = models
    .map((model) => {
      const norm = normalizeModelName(model);
      const score = tokens.reduce((acc, tok) => acc + (norm.includes(tok) ? 1 : 0), 0);
      return { model, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

  return scored.slice(0, limit).map((x) => x.model);
}

const TASK_INSTRUCTION: Record<InlineTask, string> = {
  translate: '请将以下内容翻译成中文，保持原意与格式：\n\n',
  summarize: '请用简洁的语言总结以下内容，列出要点：\n\n',
  image: IMAGE_TASK_INSTRUCTION,
  compare: '',
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
  family?: string;
  families: string[];
  projectUsed?: ProjectInfo;
  task?: InlineTask;
} {
  let text = rawQuery.trim();
  let selectedModel = defaultModel;
  const families: string[] = [];
  let projectUsed: ProjectInfo | undefined;
  let task: InlineTask | undefined;

  const parts = text.split(/\s+/);
  while (parts.length > 0 && (parts[0].startsWith('/') || parts[0].startsWith('@'))) {
    const token = parts[0];

    // Task prefixes take precedence over project switches so a literal
    // task flag is never swallowed by the /p project matcher below.
    const alias = token.toLowerCase();
    if (TASK_PREFIX_MAP[alias]) {
      task = TASK_PREFIX_MAP[alias];
      parts.shift();
      continue;
    }

    // Project switch: /p2 or /p:2 (index or name fragment).
    const projMatch = token.match(/^\/p:?(\d+|[^\s]+)/i);
    if (projMatch) {
      const target = projMatch[1];
      const num = parseInt(target, 10);
      if (!isNaN(num) && num >= 1 && num <= availableProjects.length) {
        projectUsed = availableProjects[num - 1];
      } else {
        projectUsed = availableProjects.find((p) => p.name.toLowerCase().includes(target.toLowerCase()));
      }
      parts.shift();
      continue;
    }

    // Model family search: any @keyword fuzzy-matches model names.
    if (token.startsWith('@')) {
      const tag = token.slice(1).toLowerCase();
      if (tag) families.push(tag);
      parts.shift();
      continue;
    }

    break;
  }
  text = parts.join(' ').trim();

  if (task) {
    const instr = TASK_INSTRUCTION[task];
    text = text ? `${instr}${text}` : instr.trim();
  }

  return {
    model: selectedModel,
    prompt: text,
    family: families.length > 0 ? families[families.length - 1] : undefined,
    families,
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
        // A user-initiated stop (or timeout) must terminate the whole chain
        // immediately — never auto-retry an aborted attempt.
        if ((err as Error)?.name === 'AbortError') {
          return { result: null, modelUsed: initialModel, isFallback: false };
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
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= pageChars) {
      pages.push(remaining);
      break;
    }
    let cut = findSafeCutPoint(remaining, pageChars);
    if (cut <= 0 || cut >= remaining.length) {
      cut = pageChars;
    }
    const pageChunk = remaining.slice(0, cut).trim();
    if (pageChunk) pages.push(pageChunk);
    remaining = remaining.slice(cut).trim();
  }
  if (pages.length === 0) pages.push(text);
  return pages;
}

export async function findNewImageArtifacts(conversationId: string, turnStartTime: number): Promise<string[]> {
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

/** Renders the compare picker (selection screen) markdown for a /v result. */
function renderComparePicker(cmp: CompareContext): string {
  const displayPrompt = cmp.prompt.length > 300 ? cmp.prompt.slice(0, 300) + '...' : cmp.prompt;
  const picked = cmp.selectedIdx.map((idx, i) => `**${i + 1}.** ${cmp.candidates[idx]}`).join('\n');
  const pickedBlock = picked ? `\n✅ **已选模型：**\n${picked}\n` : '';

  if (cmp.currentPage === 0) {
    return `**⚖️ 多模型对比**\n\n**💬 提问：**\n> ${displayPrompt}\n\n${pickedBlock}_点击“▶️ 浏览/选择模型”展开全量模型清单，或点击“🚀 默认组对比”。_`;
  }

  const countText = cmp.selectedIdx.length === 0
    ? '① 请选择第 1 个模型'
    : cmp.selectedIdx.length === 1
      ? '② 请选择第 2 个模型（或点“开始对比”）'
      : '③ 请选择第 3 个模型（可跳过，点“开始对比”）';
  return `**⚖️ 多模型对比**\n\n**💬 提问：**\n> ${displayPrompt}\n\n${pickedBlock}${countText}\n\n_点击下方模型按钮选择，选满 2-${MAX_COMPARE_MODELS} 个后点“🚀 开始对比”。_`;
}

/** Builds the picker keyboard for a /v selection screen. */
function buildCompareKeyboard(cmp: CompareContext): unknown {
  const rows: { text: string; callback_data: string }[][] = [];

  // Add selected models display (compact, no buttons)
  if (cmp.selectedIdx.length > 0) {
    rows.push([{ text: `已选 ${cmp.selectedIdx.length}/${MAX_COMPARE_MODELS}：${cmp.selectedIdx.map(i => cmp.candidates[i].slice(0, 15)).join(' · ')}`, callback_data: 'inline_noop' }]);
  }

  if (cmp.currentPage === 0) {
    // Cover mode: ZERO model buttons on page 0 for maximum privacy
    rows.push([{ text: '🚀 默认组对比 (Opus + R1 + Gemini)', callback_data: `inline_cmp_default:${cmp.resultId}` }]);
    rows.push([{ text: '▶️ 浏览/选择模型 (展开全量清单)', callback_data: `inline_cmp_page:${cmp.resultId}:1` }]);
    if (cmp.selectedIdx.length >= 2) {
      rows.push([{ text: '🚀 开始对比', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
    }
    if (cmp.selectedIdx.length > 0) {
      rows.push([{ text: '♻️ 清空选择', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
    }
    return { inline_keyboard: rows };
  }

  // Model list pages (currentPage >= 1)
  const listPageIndex = cmp.currentPage - 1;
  const startIdx = listPageIndex * COMPARE_MODELS_PER_PAGE;
  const endIdx = Math.min(startIdx + COMPARE_MODELS_PER_PAGE, cmp.candidates.length);
  const totalListPages = Math.ceil(cmp.candidates.length / COMPARE_MODELS_PER_PAGE);

  let row: { text: string; callback_data: string }[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    if (cmp.selectedIdx.includes(i)) continue;
    const model = cmp.candidates[i];
    const display = model.length > 20 ? model.slice(0, 20) + '…' : model;
    row.push({ text: display, callback_data: `inline_cmp_pick:${cmp.resultId}:${i}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);

  // Pagination navigation bar
  const navRow: { text: string; callback_data: string }[] = [];
  if (listPageIndex > 0) {
    navRow.push({ text: '◀️ 上一页', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage - 1}` });
  } else {
    navRow.push({ text: '◀️ 首页', callback_data: `inline_cmp_page:${cmp.resultId}:0` });
  }
  navRow.push({ text: `${listPageIndex + 1}/${totalListPages}`, callback_data: 'inline_noop' });
  if (startIdx + COMPARE_MODELS_PER_PAGE < cmp.candidates.length) {
    navRow.push({ text: '下一页 ▶️', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage + 1}` });
  }
  rows.push(navRow);

  rows.push([{ text: '♻️ 清空选择', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
  if (cmp.selectedIdx.length >= 2) {
    rows.push([{ text: '🚀 开始对比', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
  }

  return { inline_keyboard: rows };
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

    if (data.startsWith('inline_stop:')) {
      const resultId = data.slice('inline_stop:'.length);
      const ctrl = userControllers.get(resultId);
      if (!ctrl) {
        await ctx.answerCallbackQuery({ text: '⚠️ 该任务已完成或已停止。', show_alert: true }).catch(() => {});
        return;
      }
      ctrl.abort();
      await ctx.answerCallbackQuery({ text: '⏹ 已发送停止指令，正在停止…', show_alert: true }).catch(() => {});
      return;
    }

    if (data.startsWith('inline_regenerate:')) {
      const resultId = data.slice('inline_regenerate:'.length);
      const regen = regenerateContexts.get(resultId);
      if (!regen) {
        await ctx.answerCallbackQuery({ text: '❌ 会话已过期，请重新发起提问。', show_alert: true }).catch(() => {});
        return;
      }

      if (regen.task === 'compare') {
        const candidates = getEffectiveModelOrder();
        const cmp: CompareContext = {
          resultId,
          inlineMessageId,
          fromId: regen.fromId,
          prompt: regen.prompt,
          projectPath: regen.projectPath,
          candidates,
          currentPage: 0,
          selectedIdx: [],
          createdAt: Date.now(),
        };
        compareContexts.set(resultId, cmp);
        await ctx.answerCallbackQuery({ text: '⚖️ 请重新选择对比模型', show_alert: false }).catch(() => {});
        await ctx.api.raw.editMessageText({
          inline_message_id: inlineMessageId,
          rich_message: { markdown: renderComparePicker(cmp) },
          reply_markup: buildCompareKeyboard(cmp),
        } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare regenerate edit failed: ${e}`));
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

    if (data === 'inline_noop') {
      await ctx.answerCallbackQuery().catch(() => {});
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
      const targetPage = pages[pageIdx];
      const richMessagePayload = targetPage.blocks && targetPage.blocks.length > 0
        ? { blocks: targetPage.blocks }
        : { markdown: targetPage.markdown || '' };
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: richMessagePayload,
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

    if (data.startsWith('inline_cmp_pick:')) {
      const [resultId, idxStr] = data.slice('inline_cmp_pick:'.length).split(':');
      const idx = parseInt(idxStr, 10);
      const cmp = compareContexts.get(resultId);
      if (!cmp || Number.isNaN(idx) || idx < 0 || idx >= cmp.candidates.length) {
        await ctx.answerCallbackQuery({ text: '❌ 选择已过期，请重新发起 /v 提问。', show_alert: true }).catch(() => {});
        return;
      }
      if (cmp.selectedIdx.includes(idx)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      if (cmp.selectedIdx.length >= MAX_COMPARE_MODELS) {
        await ctx.answerCallbackQuery({ text: `⚠️ 最多选 ${MAX_COMPARE_MODELS} 个模型，点击“🚀 开始对比”执行。`, show_alert: true }).catch(() => {});
        return;
      }
      cmp.selectedIdx.push(idx);
      await ctx.answerCallbackQuery({ text: `✅ 已选择 ${cmp.candidates[idx]}`, show_alert: true }).catch(() => {});
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: { markdown: renderComparePicker(cmp) },
        reply_markup: buildCompareKeyboard(cmp),
      } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare pick edit failed: ${e}`));
      return;
    }

    if (data.startsWith('inline_cmp_reset:')) {
      const resultId = data.slice('inline_cmp_reset:'.length);
      const cmp = compareContexts.get(resultId);
      if (!cmp) {
        await ctx.answerCallbackQuery({ text: '❌ 会话已过期。', show_alert: true }).catch(() => {});
        return;
      }
      cmp.selectedIdx = [];
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: { markdown: renderComparePicker(cmp) },
        reply_markup: buildCompareKeyboard(cmp),
      } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare reset edit failed: ${e}`));
      return;
    }

    if (data.startsWith('inline_cmp_page:')) {
      const [resultId, pageStr] = data.slice('inline_cmp_page:'.length).split(':');
      const pageIdx = parseInt(pageStr, 10);
      let cmp = compareContexts.get(resultId);
      // Auto-rebuild if bot restarted and context was lost in memory
      if (!cmp) {
        const candidates = getEffectiveModelOrder();
        cmp = {
          resultId,
          inlineMessageId: inlineMessageId!,
          fromId: ctx.from?.id ?? 0,
          prompt: '',
          projectPath: undefined,
          candidates,
          currentPage: 0,
          selectedIdx: [],
          createdAt: Date.now(),
        };
        compareContexts.set(resultId, cmp);
      }
      if (Number.isNaN(pageIdx) || pageIdx < 0 || pageIdx >= Math.ceil(cmp.candidates.length / COMPARE_MODELS_PER_PAGE)) {
        await ctx.answerCallbackQuery({ text: '❌ 页码超出范围。', show_alert: true }).catch(() => {});
        return;
      }
      cmp.currentPage = pageIdx;
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: { markdown: renderComparePicker(cmp) },
        reply_markup: buildCompareKeyboard(cmp),
      } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare page edit failed: ${e}`));
      return;
    }

    if (data.startsWith('inline_cmp_default:')) {
      const resultId = data.slice('inline_cmp_default:'.length);
      let cmp = compareContexts.get(resultId);
      // Auto-rebuild if bot restarted and context was lost in memory
      if (!cmp) {
        const candidates = getEffectiveModelOrder();
        cmp = {
          resultId,
          inlineMessageId: inlineMessageId!,
          fromId: ctx.from?.id ?? 0,
          prompt: '',
          projectPath: undefined,
          candidates,
          currentPage: 0,
          selectedIdx: [],
          createdAt: Date.now(),
        };
        compareContexts.set(resultId, cmp);
      }
      const activeCmp = cmp!;
      activeCmp.selectedIdx = [0, 1, 2].filter(i => i < activeCmp.candidates.length);
      if (activeCmp.selectedIdx.length < 2) {
        activeCmp.selectedIdx = activeCmp.candidates.map((_, i) => i).slice(0, 3);
      }
      const models = activeCmp.selectedIdx.map((idx: number) => activeCmp.candidates[idx]);
      await ctx.answerCallbackQuery({ text: '🚀 开始默认顶级组对比…' }).catch(() => {});
      const ctrl = new AbortController();
      userControllers.set(resultId, ctrl);
      const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
      try {
        await runCompareGeneration(ctx, sessionManager, defaultOptions, {
          resultId,
          inlineMessageId,
          fromId: activeCmp.fromId,
          prompt: activeCmp.prompt,
          projectPath: activeCmp.projectPath,
          models,
          ctrl,
          streamQueue,
        });
      } catch (e) {
        logger.warn(`[InlineResult] Compare default generation failed: ${e}`);
      } finally {
        userControllers.delete(resultId);
        compareContexts.delete(resultId);
      }
      return;
    }

    if (data.startsWith('inline_cmp_start:')) {
      const resultId = data.slice('inline_cmp_start:'.length);
      const cmp = compareContexts.get(resultId);
      if (!cmp || cmp.selectedIdx.length < 2) {
        await ctx.answerCallbackQuery({ text: '❌ 至少选择 2 个模型才能对比。', show_alert: true }).catch(() => {});
        return;
      }
      const models = cmp.selectedIdx.map((idx: number) => cmp.candidates[idx]);
      await ctx.answerCallbackQuery({ text: '⚖️ 开始多模型对比…' }).catch(() => {});
      const ctrl = new AbortController();
      userControllers.set(resultId, ctrl);
      const streamQueue = new InlineStreamQueue(ctx.api, inlineMessageId);
      try {
        await runCompareGeneration(ctx, sessionManager, defaultOptions, {
          resultId,
          inlineMessageId,
          fromId: cmp.fromId,
          prompt: cmp.prompt,
          projectPath: cmp.projectPath,
          models,
          ctrl,
          streamQueue,
        });
      } catch (e) {
        logger.warn(`[InlineResult] Compare generation failed: ${e}`);
      } finally {
        userControllers.delete(resultId);
        compareContexts.delete(resultId);
      }
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
    const { model: modelToUse, prompt, family, families, projectUsed, task } = parseInlineModelAndPrompt(rawQuery, activeModel, allProjects);

    // Default to active session project if no explicit /pN flag was provided
    const targetProjectPath = projectUsed?.path || activeSession?.currentProject?.path || defaultOptions.cwd;

    if (!prompt && task !== 'image') {
      const projectHelpList = allProjects.slice(0, 5).map((p, idx) => `• <code>/p${idx + 1} 提问</code> — ${escapeHtmlText(p.name)}`).join('\n');
      const results = [
        {
          type: 'article' as const,
          id: 'help-main',
          title: `🤖 Ask AI — Gemini / DeepSeek / OpenCode`,
          description: `Type a question to ask AI (model: ${modelToUse})`,
          thumbnail_url: THUMBNAILS.bot,
          input_message_content: {
            message_text: `<b>🤖 AI Inline — @static32bot</b>\n\nType a question after @static32bot to get an AI answer using ${modelToUse}.\n\n<b>Model switches (@keyword):</b>\n• <code>@flash 提问</code> — 列出所有 Flash 模型可选\n• <code>@pro 提问</code> — 列出所有 Pro 模型可选\n• <code>@deep 提问</code> — 列出所有 DeepSeek 模型可选\n• <code>@think 提问</code> — 列出所有 Thinking 模型可选\n\n<b>Project switches (/pN):</b>\n${projectHelpList || '• 自动继承 Bot 当前绑定的项目'}`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-flash',
          title: '⚡ @static32bot @flash 提问',
          description: 'List all Flash-family models',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `⚡ <b>Model search</b>\n\nUse any <code>@keyword</code> prefix to list matching models:\n<code>@static32bot @flash 什么是量子计算？</code>\n<code>@static32bot @think 分析这个</code>\n\nPick any matching model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-pro',
          title: '🧠 @static32bot @pro 提问',
          description: 'List all Pro-family models',
          thumbnail_url: THUMBNAILS.thinking,
          input_message_content: {
            message_text: `🧠 <b>Pro family</b>\n\nUse <code>@pro</code> prefix to list all Pro models:\n<code>@static32bot @pro 请详细解释...</code>\n\nPick any Pro-family model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-deepseek',
          title: '🔍 @static32bot @deep 提问',
          description: 'List all DeepSeek models',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🔍 <b>DeepSeek family</b>\n\nUse <code>@deep</code> or <code>@deepseek</code> prefix:\n<code>@static32bot @deep 你的问题</code>\n\nPick any DeepSeek-family model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-task',
          title: '🎯 任务型前缀：翻译 / 总结 / 图片 / 对比',
          description: '/translate /summarize /img /v 一键调用',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🎯 <b>任务型前缀</b>\n\n在提问前加前缀即可一键调用专用模式，可与搜索前缀混用（如 <code>@flash /summarize ...</code>）：\n\n🌐 <code>/translate 内容</code> — 翻译成中文\n📋 <code>/summarize 内容</code> — 总结要点\n🖼️ <code>/img 提示词</code> — 生成图片（原地内嵌显示）\n⚖️ <code>/v 问题</code> — 多模型对比（逐步点选 2-3 个模型）`,
            parse_mode: 'HTML' as const,
          },
        },
      ];
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => {});
      return;
    }

    // Store prompt info (no model startup — zero latency)
    logger.info(`[InlineQuery] userId=${fromId} model=${modelToUse} task=${task || 'chat'} project="${projectUsed?.name || 'default'}" prompt="${prompt.slice(0, 40)}..."`);

    // Model suggestion cards: when a family keyword (@think/@flash/...) was
    // given, list every model in that family so the user can pick one from the
    // floating cards. Otherwise fuzzy-match the query against all models; if no
    // keyword matches, fall back to the fixed popular suggestions.
    let suggestionCandidates: string[] = [];
    if (task !== 'image') {
      const availableModels = getEffectiveModelOrder();
      if (families.length > 0) {
        // Match models containing ALL keywords first (intersection)
        let matched = availableModels.filter((m) => {
          const lower = m.toLowerCase();
          return families.every((tag) => lower.includes(tag));
        });
        // Fallback to union if intersection is empty
        if (matched.length === 0) {
          matched = availableModels.filter((m) => {
            const lower = m.toLowerCase();
            return families.some((tag) => lower.includes(tag));
          });
        }
        suggestionCandidates = matched;
      } else {
        suggestionCandidates = fuzzyMatchModels(prompt, availableModels, MAX_MODEL_SUGGESTIONS);
        if (suggestionCandidates.length === 0) {
          suggestionCandidates = FALLBACK_MODEL_SUGGESTIONS.filter((m) => availableModels.includes(m));
        }
      }
      suggestionCandidates = suggestionCandidates.filter((m) => m !== modelToUse);
      if (families.length === 0) suggestionCandidates = suggestionCandidates.slice(0, MAX_MODEL_SUGGESTIONS);
    }

    // Family mode: show ONLY one card per matching model (no primary/ask card).
    // The user picks a card and that model answers the prompt directly.
    const familyMode = !!family && suggestionCandidates.length > 0;
    const resultId = `ai-${Date.now()}-${fromId}`;

    if (task === 'compare') {
      let candidates = getEffectiveModelOrder();
      if (families.length > 0 && suggestionCandidates.length > 0) {
        candidates = suggestionCandidates;
      }
      const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
      compareContexts.set(resultId, {
        resultId,
        inlineMessageId: '',
        fromId,
        prompt,
        projectPath: targetProjectPath,
        candidates,
        currentPage: 0,
        selectedIdx: [],
        createdAt: Date.now(),
      });
      const results = [{
        type: 'article' as const,
        id: resultId,
        title: '⚖️ 点击选择模型对比',
        description: `选择 2-${MAX_COMPARE_MODELS} 个模型并行对比相同问题`,
        thumbnail_url: THUMBNAILS.sparkles,
        input_message_content: {
          rich_message: {
            markdown: `**⚖️ 多模型对比**\n\n**💬 提问：**\n> ${displayPrompt}\n\n_点击后选择 ${MAX_COMPARE_MODELS} 个以内的模型进行并行对比。_`,
          },
        } as any,
        reply_markup: {
          inline_keyboard: [[{ text: '⏹ 停止', callback_data: `inline_stop:${resultId}` }]],
        },
      }];
      logger.info(`[InlineQuery] Compare mode: sending picker card for "${prompt.slice(0, 40)}..."`);
      await ctx.answerInlineQuery(results, { cache_time: 0 });
      return;
    }

    if (!familyMode) {
      pendingResults.set(resultId, { prompt, model: modelToUse, projectPath: targetProjectPath, task, createdAt: Date.now(), lastActiveTime: Date.now() });
    }

    try {
      const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
      const taskLabel = task === 'image'
        ? '🖼️ **图像生成模式**'
        : task === 'translate' ? '🌐 **翻译模式**'
        : task === 'summarize' ? '📋 **总结模式**'
        : task === 'compare' ? '⚖️ **多模型对比模式**'
        : undefined;

      if (familyMode) {
        const now = Date.now();
        const results = suggestionCandidates.map((candidateModel, idx) => {
          const candidateId = `m-${now}-${idx}`;
          pendingResults.set(candidateId, { prompt, model: candidateModel, projectPath: targetProjectPath, task, createdAt: now, lastActiveTime: now });
          return {
            type: 'article' as const,
            id: candidateId,
            title: `🧠 ${candidateModel}`,
            description: `点击后用 ${candidateModel} 回答`,
            thumbnail_url: THUMBNAILS.sparkles,
            input_message_content: {
              rich_message: {
                markdown: `${taskLabel ? taskLabel + '\n\n' : ''}**🧠 目标模型：** \`${candidateModel}\`\n\n**💬 提问内容：**\n> ${displayPrompt}\n\n*🚀 正在深度推演，回答完成后将自动原地更新。*`,
              },
            } as any,
            // An inline keyboard is REQUIRED for Telegram to return
            // inline_message_id on chosen_inline_result, which is the handle used
            // to stream/update the message in-place (BUGFIX: removed 1056263).
            reply_markup: {
              inline_keyboard: [[
                { text: '⏹ 停止', callback_data: `inline_stop:${candidateId}` }
              ]],
            },
          };
        });

        logger.info(`[InlineQuery] Family mode "${family}": sending ${results.length} model card(s) ids=${results.map((r) => r.id).join(',')}`);
        await ctx.answerInlineQuery(results, { cache_time: 0 });
        return;
      }

      const initTitle = task === 'image'
        ? `🖼️ 点击生成图片 [${modelToUse}]`
        : task === 'translate' ? `🌐 点击翻译 [${modelToUse}]`
        : task === 'summarize' ? `📋 点击总结 [${modelToUse}]`
        : task === 'compare' ? '⚖️ 点击选择模型对比'
        : `🤔 点击发送并开始思考 [${modelToUse}]`;
      let initMarkdown: string;
      if (task === 'image') {
        initMarkdown = `**🎨 图像生成模式**\n\n**💬 提示词：**\n> ${displayPrompt}\n\n*🚀 正在生成图片，完成后将自动原地更新。*`;
      } else {
        const modelLine = `**🧠 目标模型：** \`${modelToUse}\`\n`;
        initMarkdown = `${taskLabel ? taskLabel + '\n\n' : ''}✨ **AI 推理引擎已启动**\n\n${modelLine}**💬 提问内容：**\n> ${displayPrompt}\n\n*🚀 正在深度推演，回答完成后将自动原地更新。*`;
      }

      const suggestionCards: any[] = [];
      {
        const candidates = suggestionCandidates.filter((m) => m !== modelToUse);
        const now = Date.now();
        candidates.forEach((candidateModel, idx) => {
          const candidateId = `m-${now}-${idx}`;
          pendingResults.set(candidateId, { prompt, model: candidateModel, projectPath: targetProjectPath, task, createdAt: now, lastActiveTime: now });
          suggestionCards.push({
            type: 'article' as const,
            id: candidateId,
            title: `🧠 用 ${candidateModel} 回答`,
            description: `切换到模型 ${candidateModel}`,
            thumbnail_url: THUMBNAILS.sparkles,
            input_message_content: {
              rich_message: {
                markdown: `**🧠 模型切换：** \`${candidateModel}\`\n\n**💬 提问内容：**\n> ${displayPrompt}\n\n*🚀 正在深度推演，回答完成后将自动原地更新。*`,
              },
            } as any,
            reply_markup: {
              inline_keyboard: [[
                { text: '⏹ 停止', callback_data: `inline_stop:${candidateId}` }
              ]],
            },
          });
        });
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
          // An inline keyboard is REQUIRED for Telegram to return
          // inline_message_id on chosen_inline_result, which is the handle used
          // to stream/update the message in-place (BUGFIX: removed 1056263).
          reply_markup: {
            inline_keyboard: [[
              { text: '⏹ 停止', callback_data: `inline_stop:${resultId}` }
            ]],
          },
        },
        {
          type: 'article' as const,
          id: `prompt-${Date.now()}`,
          title: `💬 发送提问卡片 (默认模型)`,
          description: `模型: ${modelToUse} | "${prompt.slice(0, 40)}..."`,
          thumbnail_url: THUMBNAILS.chat,
          input_message_content: {
            rich_message: {
              markdown: `**💬 AI 提问卡片**\n\n**模型：** \`${modelToUse}\`\n**问题：** ${displayPrompt}\n\n*${ICONS.sparkles} 提问卡片已发送。*`,
            },
          } as any,
        },
        ...suggestionCards,
      ];

      logger.info(`[InlineQuery] Sending ${results.length} result(s) family="${family || ''}" primary="${modelToUse}" suggestions=${suggestionCandidates.length} ids=${results.map((r) => (r as any).id).join(',')}`);
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

    const cmp = compareContexts.get(chosen.result_id);
    if (cmp) {
      cmp.inlineMessageId = chosen.inline_message_id;
      logger.info(`[ChosenInline] Compare mode selected: userId=${chosen.from.id} resultId=${chosen.result_id} candidates=${cmp.candidates.length}`);
      await ctx.api.raw.editMessageText({
        inline_message_id: chosen.inline_message_id,
        rich_message: { markdown: renderComparePicker(cmp) },
        reply_markup: buildCompareKeyboard(cmp),
      } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare picker initial edit failed: ${e}`));
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
        // Long answer → paginate
        const pages = splitIntoPages(cleanOutput);
        pageCount = pages.length;
        const header = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${modelUsed})：**`;
        const pageItems: InlinePage[] = pages.map((page) => {
          const footer = footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : '';
          const fullMd = `${header}\n\n${page}${footer}`;
          const blocks = markdownToRichBlocks(fullMd);
          return { markdown: fullMd, blocks: blocks.length > 0 ? blocks : undefined };
        });
        inlinePages.set(resultId, pageItems);
        fullMarkdown = pageItems[0].markdown || '';
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
        // Standard answer → direct display
        fullMarkdown = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${modelUsed})：**\n\n${cleanOutput}${footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : ''}`;
        replyMarkup = {
          inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
        };
      }
    } else {
      // Short answer → plain text
      fullMarkdown = `**💬 问题：** ${displayPrompt}\n\n**🤖 回答 (${modelUsed})：**\n\n${cleanOutput}${footerText ? `\n\n_${footerText}${isFallback ? ' (已自动降级)' : ''}_` : ''}`;
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
    const wasStopped = ctrl.signal.aborted;
    const displayPrompt = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;
    const failText = wasStopped
      ? `<b>💬 问题：</b> ${escapeHtmlText(displayPrompt)}\n\n⏹ <b>已停止生成</b>\n任务被手动停止。`
      : `<b>💬 问题：</b> ${escapeHtmlText(displayPrompt)}\n\n⚠️ <b>生成回答失败</b>\n模型未返回有效的文本输出，请重试。`;
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      text: failText,
      parse_mode: 'HTML',
    } as any).catch(() => {});
  }
}

interface CompareGenerationContext {
  resultId: string;
  inlineMessageId: string;
  fromId: number;
  prompt: string;
  projectPath?: string;
  models: string[];
  ctrl: AbortController;
  streamQueue: InlineStreamQueue;
}

/**
 * Runs a /v multi-model comparison: all selected models answer the same
 * prompt in parallel (each with its own fresh conversation), streaming a
 * per-model progress card, then flushing a paginated comparison (one page
 * per model) that reuses the standard inline_page machinery.
 */
async function runCompareGeneration(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  gctx: CompareGenerationContext,
): Promise<void> {
  const { resultId, inlineMessageId, fromId, prompt, projectPath, models, ctrl, streamQueue } = gctx;
  const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

  const statuses: { model: string; done: boolean; output?: string; error?: string }[] = models.map((m) => ({ model: m, done: false }));
  let startedAt = Date.now();

  const renderStatus = (): string => {
    const lines = statuses.map((s, i) => {
      const num = ['①', '②', '③'][i] ?? `${i + 1}.`;
      if (s.error) return `${num} \`${s.model}\`\n❌ 生成失败`;
      if (s.done) return `${num} \`${s.model}\`\n✅ 完成`;
      return `${num} \`${s.model}\`\n⏳ 思考中...`;
    }).join('\n\n');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    return `**⚖️ 多模型对比中...**\n\n**💬 提问：**\n> ${displayPrompt}\n\n${lines}\n\n_⏱️ ${elapsed}s 已运行，回答完成后将自动原地更新。_`;
  };

  // Parallel execution, one runModelWithFallbackChain per model.
  const runs = models.map(async (model, i) => {
    let out = '';
    const onChunk = (chunk: string) => {
      out += chunk;
      touchPendingResult(resultId);
      // Update the progress card only when a model finishes (set in onModelStart? no — use this flag).
      void out;
    };
    const { result, modelUsed, isFallback } = await runModelWithFallbackChain(
      prompt,
      model,
      defaultOptions,
      ctrl.signal,
      projectPath,
      onChunk,
    );
    if (result?.output) {
      statuses[i] = { model: `${modelUsed}${isFallback ? '（降级）' : ''}`, done: true, output: result.output };
    } else {
      statuses[i] = { model, done: true, error: ctrl.signal.aborted ? '已停止' : '无输出' };
    }
    streamQueue.enqueueStream(renderStatus());
  });

  try {
    // Initial progress card so the user sees parallel execution start.
    streamQueue.enqueueStream(renderStatus());
    await Promise.all(runs);
  } catch (e) {
    logger.warn(`[InlineResult] Compare generation error: ${e}`);
  }

  const doneModels = statuses.filter((s) => s.output);
  const failedModels = statuses.filter((s) => !s.output);

  if (doneModels.length === 0) {
    const wasStopped = ctrl.signal.aborted;
    const failText = wasStopped
      ? `**💬 提问：** ${displayPrompt}\n\n⏹ **已停止对比**\n任务被手动停止。`
      : `**💬 提问：** ${displayPrompt}\n\n⚠️ **对比失败**\n所有模型均未返回有效输出，请重试。`;
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      rich_message: { markdown: failText },
    } as any).catch(() => {});
    return;
  }

  // Build paginated comparison: one page per successfully answered model.
  const header = `**⚖️ 多模型对比**\n\n**💬 提问：**\n> ${displayPrompt}\n\n`;
  const pageItems: InlinePage[] = doneModels.map((s, i) => {
    const clean = stripWholeMessageCodeFence(s.output || '');
    const num = ['①', '②', '③'][i] ?? `${i + 1}.`;
    const modelLine = `**${num} ${s.model}**\n\n`;
    const footer = `\n\n_⏱️ ${((Date.now() - startedAt) / 1000).toFixed(1)}s_`;
    const fullMd = `${header}${modelLine}${clean}${footer}`;
    const blocks = markdownToRichBlocks(fullMd);
    return { markdown: fullMd, blocks: blocks.length > 0 ? blocks : undefined };
  });
  inlinePages.set(resultId, pageItems);
  const pageCount = pageItems.length;

  const allSucceeded = failedModels.length === 0;
  const doneStr = doneModels.map((s) => s.model).join('、');
  const failNote = failedModels.length > 0 ? `\n\n_⚠️ 生成失败：${failedModels.map((s) => s.model).join('、')}_` : '';

  // First page + pagination keyboard + regenerate.
  const footerText = `${allSucceeded ? '对比完成' : '部分完成'}：${doneStr}${failNote}`;
  const firstPage = `${pageItems[0].markdown}\n\n_${footerText}_`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '◀️ 上一页', callback_data: 'inline_noop' },
        { text: `1/${pageCount}`, callback_data: 'inline_noop' },
        { text: '下一页 ▶️', callback_data: `inline_page:${resultId}:1` },
      ].filter((b) => b.text !== '◀️ 上一页'),
      [{ text: '🔄 重新对比', callback_data: `inline_regenerate:${resultId}` }],
    ],
  };

  regenerateContexts.set(resultId, {
    prompt,
    model: models[0],
    projectPath,
    fromId,
    inlineMessageId,
    task: 'compare',
    createdAt: Date.now(),
  });

  const success = await streamQueue.flushFinal(firstPage, replyMarkup);
  if (success) {
    logger.info(`[InlineResult] Compare flushed ${doneModels.length}/${models.length} models: ${doneStr}`);
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

  // Chunk into collages of MAX_COLLAGE_IMAGES so >10 photos still render.
  const chunks: string[][] = [];
  for (let i = 0; i < images.length; i += MAX_COLLAGE_IMAGES) {
    chunks.push(images.slice(i, i + MAX_COLLAGE_IMAGES));
  }
  const imageCount = images.length;

  // Inline messages can only reference media via a URL or an existing
  // file_id (no local upload). Upload every generated image through a transient
  // rich-message relay to the user's private chat to obtain file_ids, then
  // delete the relay message so the images only ever appear in-place in the
  // inline message.
  const fileIds: string[] = [];
  let relayMessageId: number | null = null;
  try {
    const relayMarkdown = chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![生成的图片](tg://photo?id=r${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n');
    const relayMedia = chunks.flatMap((chunk, ci) =>
      chunk.map((imgPath, i) => ({ id: `r${ci}_${i}`, media: { type: 'photo' as const, media: new InputFile(imgPath) } })),
    );
    const sentMsg = await ctx.api.sendRichMessage(fromId, {
      markdown: `${relayMarkdown}\n\n*上传中转中...*`,
      media: relayMedia,
    });
    relayMessageId = sentMsg?.message_id ?? null;
    // Collect photo blocks recursively (they may be nested inside a collage block).
    const collectPhotos = (blocks: Array<Record<string, any>> | undefined, out: Array<Record<string, any>>) => {
      for (const b of blocks ?? []) {
        if (b?.['type'] === 'photo') out.push(b);
        else if (Array.isArray(b?.['blocks'])) collectPhotos(b['blocks'], out);
      }
    };
    const photoBlocks: Array<Record<string, any>> = [];
    collectPhotos(sentMsg?.rich_message?.blocks as Array<Record<string, any>> | undefined, photoBlocks);
    for (const block of photoBlocks) {
      const sizes: Array<{ file_id: string; file_size?: number }> = block?.['photo'] ?? [];
      const largest = sizes.slice().sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
      if (largest?.file_id) fileIds.push(largest.file_id);
    }
    logger.info(`[InlineResult] Uploaded ${fileIds.length}/${imageCount} image(s) via rich-message relay`);
  } catch (e) {
    logger.error(`[InlineResult] Failed to relay-upload images: ${e}`);
  } finally {
    // Remove the transient relay copy so the images are only shown in the inline message.
    if (relayMessageId != null) {
      await ctx.api.deleteMessage(fromId, relayMessageId).catch(() => {});
    }
  }

  const caption = `**💬 提示词：** ${displayPrompt}\n\n_模型: ${modelUsed} · 共 ${images.length} 张_`;
  const regenButton = {
    inline_keyboard: [[{ text: '🔄 重新生成', callback_data: `inline_regenerate:${resultId}` }]],
  };

  if (fileIds.length > 0) {
    // Render all images in-place as collages via rich_message: the markdown
    // references each attached photo through tg://photo?id=, with the actual
    // media supplied in the media array. editMessageMedia cannot carry
    // rich_message, so editMessageText is the correct transport here.
    const chunks: string[][] = [];
    for (let i = 0; i < fileIds.length; i += MAX_COLLAGE_IMAGES) {
      chunks.push(fileIds.slice(i, i + MAX_COLLAGE_IMAGES));
    }
    const richMarkdown = `${chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![生成的图片](tg://photo?id=med${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n')}\n\n${caption}\n\n_🖼️ 图片已生成，可点击 🔄 重新生成。_`;
    const media = chunks.flatMap((chunk, ci) =>
      chunk.map((fileId, i) => ({ id: `med${ci}_${i}`, media: { type: 'photo', media: fileId } })),
    );
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      rich_message: {
        markdown: richMarkdown,
        media,
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

  // No file_id (relay upload failed): describe the images as text.
  const filesText = images.map((p) => path.basename(p)).join(', ');
  const finalText = `**🖼️ 图片已生成**\n\n${caption}\n\n_⚠️ 未能上传渲染（请先给机器人发消息开启私聊）_\n\n_文件: ${filesText}_`;
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
