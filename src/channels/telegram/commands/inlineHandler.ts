import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionManager } from '../../../core/session.js';
import type { ProjectInfo, SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { getAgyDataDir, getDefaultModel } from '../../../config/userConfig.js';
import { findSafeCutPoint, formatTokenCount } from '../formatter/core.js';
import { markdownToRichBlocks } from '../formatter/blocks.js';
import type { RichBlock } from '../richMessage.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { buildTierAwareChain, getEffectiveModelOrder } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';
import { calculateCost, estimateTokens, type TokenUsage } from '../../../utils/pricing.js';
import { ICONS } from '../ui.js';

export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

/** Inactivity timeout — aborts when no stream activity for this long. */
const INACTIVITY_TIMEOUT_MS = 60_000;
/** Hard ceiling — aborts regardless of activity to prevent infinite agent loops. */
const HARD_TIMEOUT_MS = 600_000;
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

import * as fsSync from 'node:fs';

export interface InlinePage {
  markdown?: string;
  blocks?: RichBlock[];
}

// ---------------------------------------------------------------------------
// Persistent inline-pages store (survives bot restarts)
// ---------------------------------------------------------------------------
const INLINE_PAGES_TTL = 7 * 24 * 60 * 60_000; // 7 days

interface InlinePagesStore {
  [resultId: string]: { pages: InlinePage[]; createdAt: number };
}

function getInlinePagesFile(): string {
  return path.join(getAgyDataDir(), 'inline_pages.json');
}

function loadInlinePagesFromDisk(): Map<string, InlinePage[]> {
  const map = new Map<string, InlinePage[]>();
  try {
    const raw = fsSync.readFileSync(getInlinePagesFile(), 'utf8');
    const store: InlinePagesStore = JSON.parse(raw);
    const cutoff = Date.now() - INLINE_PAGES_TTL;
    for (const [id, entry] of Object.entries(store)) {
      if (entry.createdAt > cutoff) map.set(id, entry.pages);
    }
  } catch {
    // file doesn't exist yet or is corrupt — start fresh
  }
  return map;
}

async function saveInlinePagesToDisk(map: Map<string, InlinePage[]>): Promise<void> {
  try {
    const store: InlinePagesStore = {};
    const cutoff = Date.now() - INLINE_PAGES_TTL;
    // Include only non-expired entries when writing
    for (const [id, pages] of map) {
      // We don't track createdAt per entry in the Map, so preserve existing timestamps
      const existing = _inlinePagesOnDisk[id];
      const createdAt = existing?.createdAt ?? Date.now();
      if (createdAt > cutoff) store[id] = { pages, createdAt };
    }
    _inlinePagesOnDisk = store;
    await fs.writeFile(getInlinePagesFile(), JSON.stringify(store), 'utf8');
  } catch (e) {
    logger.warn(`[inlinePages] Failed to persist to disk: ${e}`);
  }
}

let _inlinePagesOnDisk: InlinePagesStore = {};

/** Paginated pages of a finished answer, keyed by resultId. Disk-backed. */
const inlinePages = loadInlinePagesFromDisk();

function setInlinePages(resultId: string, pages: InlinePage[]): void {
  inlinePages.set(resultId, pages);
  _inlinePagesOnDisk[resultId] = { pages, createdAt: Date.now() };
  saveInlinePagesToDisk(inlinePages).catch(() => {});
}

function deleteInlinePages(resultId: string): void {
  inlinePages.delete(resultId);
  delete _inlinePagesOnDisk[resultId];
  saveInlinePagesToDisk(inlinePages).catch(() => {});
}

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
      deleteInlinePages(key);
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
  private pendingBlocks: RichBlock[] | null = null;
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
   * @param blocks optional native 10.2 blocks for rich message rendering.
   */
  public async flushFinal(markdown: string, replyMarkup?: unknown, blocks?: RichBlock[]): Promise<boolean> {
    this.pendingMarkdown = markdown;
    if (replyMarkup !== undefined) this.pendingReplyMarkup = replyMarkup;
    if (blocks !== undefined) this.pendingBlocks = blocks;
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
          rich_message: this.pendingBlocks && this.pendingBlocks.length > 0
            ? { blocks: this.pendingBlocks }
            : { markdown: targetMarkdown },
        };
        if (this.pendingReplyMarkup !== null) {
          editPayload['reply_markup'] = this.pendingReplyMarkup;
        }
        await this.api.raw.editMessageText(editPayload as any);

        this.lastEditTime = Date.now();
        this.lastSentLen = targetMarkdown.length;
        if (targetMarkdown === this.pendingMarkdown) {
          this.pendingMarkdown = null;
          this.pendingBlocks = null;
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
  'Use the generate_image tool to generate images for the topic below (can generate multiple images of different styles/compositions at once). Only call the tool to generate images, do not describe the images with text:\n\n';

/** Max photos a <tg-collage> / album can contain. */
export const MAX_COLLAGE_IMAGES = 10;

/** Max model-suggestion cards appended to inline query results. */
export const MAX_MODEL_SUGGESTIONS = 5;

/** Fallback model suggestions shown when no model keyword matched. */
function getFallbackModelSuggestions(): string[] {
  return [
    getDefaultModel() || 'Gemini 3.6 Flash (High)',
    'Web2API: Gemini 3.1 Pro',
    'DeepSeek: Flash',
    'Claude Sonnet 4.6 (Thinking)',
    'OpenCode: DeepSeek V4 Flash Free',
  ];
}

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
  translate: 'Translate the following content between Chinese and English (or to the target language if one is specified), preserving the original meaning and formatting:\n\n',
  summarize: 'Summarize the following content concisely and list the key points. Reply in the same language as the user\'s message:\n\n',
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
      // Sliding inactivity timer (reset on every stream chunk) + hard ceiling.
      // Tool-calling/agentic models may work for a long time without emitting a
      // final answer — a fixed deadline would kill them mid-tool-call. We abort
      // only when the model goes silent, or after the hard ceiling.
      const timeoutCtrl = new AbortController();
      let inactivityTimer: NodeJS.Timeout;
      let hardTimer: NodeJS.Timeout;
      const armTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => timeoutCtrl.abort(), INACTIVITY_TIMEOUT_MS);
      };
      armTimer();
      hardTimer = setTimeout(() => timeoutCtrl.abort(), HARD_TIMEOUT_MS);
      const clearTimers = () => {
        clearTimeout(inactivityTimer);
        clearTimeout(hardTimer);
      };
      // Reset the inactivity timer whenever the model streams something.
      const wrappedChunk = onChunk
        ? (chunk: string) => {
            armTimer();
            onChunk(chunk);
          }
        : undefined;
      try {
        logger.info(`[InlineQuery] Attempting model="${modelToUse}" (${attempt}/2) for initial="${initialModel}"`);
        if (onModelStart) onModelStart(modelToUse);
        const result = await runAgyPrint({
          prompt,
          cwd: customCwd || defaultOptions.cwd || process.cwd(),
          model: modelToUse,
          proxy: defaultOptions.proxy,
          onChunk: wrappedChunk,
          signal: signal ? anySignal(signal, timeoutCtrl.signal) : timeoutCtrl.signal,
        });
        clearTimers();
        // A timed-out run may carry partial stdout; treat it as a failure rather
        // than returning a truncated "successful" answer.
        if (result?.output && !result.isTimeout) {
          return {
            result,
            modelUsed: modelToUse,
            isFallback: modelToUse !== initialModel,
          };
        }
        logger.warn(`[AgentQuery] attempt ${attempt}/2 incomplete for model="${modelToUse}" output=${result?.output ? result.output.length : 0} isTimeout=${result?.isTimeout}`);
      } catch (err) {
        clearTimers();
        // A user-initiated stop must terminate the whole chain immediately —
        // never auto-retry an aborted attempt. Inactivity/hard timeouts surface
        // as a resolving result (with isTimeout), not a reject.
        if ((err as Error)?.name === 'AbortError') {
          return { result: null, modelUsed: initialModel, isFallback: false };
        }
        logger.warn(`[Agent] Attempt ${attempt}/2 failed for model="${modelToUse}": ${err}`);
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
  const pickedBlock = picked ? `\n✅ **Selected models:**\n${picked}\n` : '';

  if (cmp.currentPage === 0) {
    return `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${pickedBlock}_Click "▶️ Browse/select models" to expand the full model list, or click "🚀 Default group compare"._`;
  }

  const countText = cmp.selectedIdx.length === 0
    ? '1. Please pick model 1'
    : cmp.selectedIdx.length === 1
      ? '2. Please pick model 2 (or tap "Start comparison")'
      : '3. Please pick model 3 (optional, tap "Start comparison")';
  return `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${pickedBlock}${countText}\n\n_Tap the model buttons below to select up to ${MAX_COMPARE_MODELS} models, then tap "🚀 Start comparison"._`;
}

/** Builds the picker keyboard for a /v selection screen. */
function buildCompareKeyboard(cmp: CompareContext): unknown {
  const rows: { text: string; callback_data: string }[][] = [];

  // Add selected models display (compact, no buttons)
  if (cmp.selectedIdx.length > 0) {
    rows.push([{ text: `Selected ${cmp.selectedIdx.length}/${MAX_COMPARE_MODELS}: ${cmp.selectedIdx.map(i => cmp.candidates[i].slice(0, 15)).join(' · ')}`, callback_data: 'inline_noop' }]);
  }

  if (cmp.currentPage === 0) {
    // Cover mode: ZERO model buttons on page 0 for maximum privacy
    rows.push([{ text: '🚀 Default group compare (Opus + R1 + Gemini)', callback_data: `inline_cmp_default:${cmp.resultId}` }]);
    rows.push([{ text: '▶️ Browse/select models (full list)', callback_data: `inline_cmp_page:${cmp.resultId}:1` }]);
    if (cmp.selectedIdx.length >= 2) {
      rows.push([{ text: '🚀 Start comparison', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
    }
    if (cmp.selectedIdx.length > 0) {
      rows.push([{ text: '♻️ Clear selection', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
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
    navRow.push({ text: '◀️ Prev', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage - 1}` });
  } else {
    navRow.push({ text: '◀️ First', callback_data: `inline_cmp_page:${cmp.resultId}:0` });
  }
  navRow.push({ text: `${listPageIndex + 1}/${totalListPages}`, callback_data: 'inline_noop' });
  if (startIdx + COMPARE_MODELS_PER_PAGE < cmp.candidates.length) {
    navRow.push({ text: 'Next ▶️', callback_data: `inline_cmp_page:${cmp.resultId}:${cmp.currentPage + 1}` });
  }
  rows.push(navRow);

  rows.push([{ text: '♻️ Clear selection', callback_data: `inline_cmp_reset:${cmp.resultId}` }]);
  if (cmp.selectedIdx.length >= 2) {
    rows.push([{ text: '🚀 Start comparison', callback_data: `inline_cmp_start:${cmp.resultId}` }]);
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
        text: '🧠 AI is computing in full; the answer will update in place when complete, please wait...',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    if (data.startsWith('inline_stop:')) {
      const resultId = data.slice('inline_stop:'.length);
      const ctrl = userControllers.get(resultId);
      if (!ctrl) {
        await ctx.answerCallbackQuery({ text: '⚠️ This task is already complete or stopped.', show_alert: true }).catch(() => {});
        return;
      }
      ctrl.abort();
      await ctx.answerCallbackQuery({ text: '⏹ Stop requested, stopping...', show_alert: true }).catch(() => {});
      return;
    }

    if (data.startsWith('inline_regenerate:')) {
      const resultId = data.slice('inline_regenerate:'.length);
      const regen = regenerateContexts.get(resultId);
      if (!regen) {
        await ctx.answerCallbackQuery({ text: '❌ Session expired, please ask again.', show_alert: true }).catch(() => {});
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
        await ctx.answerCallbackQuery({ text: '⚖️ Please reselect comparison models', show_alert: false }).catch(() => {});
        await ctx.api.raw.editMessageText({
          inline_message_id: inlineMessageId,
          rich_message: { markdown: renderComparePicker(cmp) },
          reply_markup: buildCompareKeyboard(cmp),
        } as any).catch((e: Error) => logger.warn(`[InlineResult] Compare regenerate edit failed: ${e}`));
        return;
      }

      await ctx.answerCallbackQuery({ text: '🔄 Regenerating answer, please wait...' }).catch(() => {});
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
          const streamMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${activeModelName}):**\n\n${accumulatedText}\n\n_✍️ Streaming live update..._`;
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
      logger.info(`[InlinePage] userId=${ctx.from?.id} resultId=${resultId} pageIdx=${pageIdx} pagesFound=${pages ? pages.length : 'null'} inlineMsgId=${inlineMessageId ?? 'null'}`);
      if (!pages || Number.isNaN(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) {
        logger.warn(`[InlinePage] EXPIRED or invalid: resultId=${resultId} pages=${pages ? pages.length : 'null'} pageIdx=${pageIdx}`);
        await ctx.answerCallbackQuery({ text: '❌ Pagination expired.', show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      const targetPage = pages[pageIdx];
      const richMessagePayload = targetPage.blocks && targetPage.blocks.length > 0
        ? { blocks: targetPage.blocks }
        : { markdown: targetPage.markdown || '' };
      logger.info(`[InlinePage] Editing to page ${pageIdx + 1}/${pages.length} for resultId=${resultId} payloadType=${targetPage.blocks ? 'blocks' : 'markdown'}`);
      await ctx.api.raw.editMessageText({
        inline_message_id: inlineMessageId,
        rich_message: richMessagePayload,
        reply_markup: {
          inline_keyboard: [
            [
              ...(pageIdx > 0 ? [{ text: '◀️ Prev', callback_data: `inline_page:${resultId}:${pageIdx - 1}` }] : []),
              { text: `${pageIdx + 1}/${pages.length}`, callback_data: 'inline_noop' },
              ...(pageIdx < pages.length - 1 ? [{ text: 'Next ▶️', callback_data: `inline_page:${resultId}:${pageIdx + 1}` }] : []),
            ],
            [{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }],
          ],
        },
      } as any).catch((e: Error) => logger.warn(`[InlinePage] Page edit failed: ${e}`));
      return;
    }

    if (data.startsWith('inline_cmp_pick:')) {
      const [resultId, idxStr] = data.slice('inline_cmp_pick:'.length).split(':');
      const idx = parseInt(idxStr, 10);
      const cmp = compareContexts.get(resultId);
      if (!cmp || Number.isNaN(idx) || idx < 0 || idx >= cmp.candidates.length) {
        await ctx.answerCallbackQuery({ text: '❌ Selection expired, please start a new /v query.', show_alert: true }).catch(() => {});
        return;
      }
      if (cmp.selectedIdx.includes(idx)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      if (cmp.selectedIdx.length >= MAX_COMPARE_MODELS) {
        await ctx.answerCallbackQuery({ text: `⚠️ Select up to ${MAX_COMPARE_MODELS} models, then tap "🚀 Start comparison".`, show_alert: true }).catch(() => {});
        return;
      }
      cmp.selectedIdx.push(idx);
      await ctx.answerCallbackQuery({ text: `✅ Selected ${cmp.candidates[idx]}`, show_alert: true }).catch(() => {});
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
        await ctx.answerCallbackQuery({ text: '❌ Session expired.', show_alert: true }).catch(() => {});
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
        await ctx.answerCallbackQuery({ text: '❌ Page out of range.', show_alert: true }).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: '🚀 Starting default top-tier comparison...' }).catch(() => {});
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
        await ctx.answerCallbackQuery({ text: '❌ Select at least 2 models to compare.', show_alert: true }).catch(() => {});
        return;
      }
      const models = cmp.selectedIdx.map((idx: number) => cmp.candidates[idx]);
      await ctx.answerCallbackQuery({ text: '⚖️ Starting multi-model comparison...' }).catch(() => {});
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
        title: '⚠️ Unauthorized access',
        description: 'Your Telegram ID is not in the allowed whitelist.',
        thumbnail_url: THUMBNAILS.warning,
        input_message_content: {
          message_text: `${ICONS.warning} <b>Unauthorized access</b>\n\nYour Telegram ID (<code>${fromId}</code>) is not authorized to use this AI Bot's Inline mode.`,
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
    const allProjects = sessionManager.getProjectsInConfigOrder();
    const { model: modelToUse, prompt, family, families, projectUsed, task } = parseInlineModelAndPrompt(rawQuery, activeModel, allProjects);

    // Default to active session project if no explicit /pN flag was provided
    const targetProjectPath = projectUsed?.path || activeSession?.currentProject?.path || defaultOptions.cwd;

    if (!prompt && task !== 'image') {
      const projectHelpList = allProjects.slice(0, 5).map((p, idx) => `• <code>/p${idx + 1} ask</code> — ${escapeHtmlText(p.name)}`).join('\n');
      const results = [
        {
          type: 'article' as const,
          id: 'help-main',
          title: `🤖 Ask AI — Gemini / DeepSeek / OpenCode`,
          description: `Type a question to ask AI (model: ${modelToUse})`,
          thumbnail_url: THUMBNAILS.bot,
          input_message_content: {
            message_text: `<b>🤖 AI Inline — @static32bot</b>\n\nType a question after @static32bot to get an AI answer using ${modelToUse}.\n\n<b>Model switches (@keyword):</b>\n• <code>@flash ask</code> — list all Flash models\n• <code>@pro ask</code> — list all Pro models\n• <code>@deep ask</code> — list all DeepSeek models\n• <code>@think ask</code> — list all Thinking models\n\n<b>Project switches (/pN):</b>\n${projectHelpList || "• inherits the bot's currently bound project"}`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-flash',
          title: '⚡ @static32bot @flash ask',
          description: 'List all Flash-family models',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `⚡ <b>Model search</b>\n\nUse any <code>@keyword</code> prefix to list matching models:\n<code>@static32bot @flash What is quantum computing?</code>\n<code>@static32bot @think Analyze this</code>\n\nPick any matching model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-pro',
          title: '🧠 @static32bot @pro ask',
          description: 'List all Pro-family models',
          thumbnail_url: THUMBNAILS.thinking,
          input_message_content: {
            message_text: `🧠 <b>Pro family</b>\n\nUse <code>@pro</code> prefix to list all Pro models:\n<code>@static32bot @pro Please explain in detail...</code>\n\nPick any Pro-family model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-deepseek',
          title: '🔍 @static32bot @deep ask',
          description: 'List all DeepSeek models',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🔍 <b>DeepSeek family</b>\n\nUse <code>@deep</code> or <code>@deepseek</code> prefix:\n<code>@static32bot @deep your question</code>\n\nPick any DeepSeek-family model from the floating cards.`,
            parse_mode: 'HTML' as const,
          },
        },
        {
          type: 'article' as const,
          id: 'help-task',
          title: '🎯 Task prefixes: translate / summarize / image / compare',
          description: '/translate /summarize /img /v one-tap',
          thumbnail_url: THUMBNAILS.sparkles,
          input_message_content: {
            message_text: `🎯 <b>Task prefixes</b>\n\nAdd a prefix before your question to instantly trigger a dedicated mode, and mix it with search prefixes (e.g. <code>@flash /summarize ...</code>):\n\n🌐 <code>/translate content</code> — translate between Chinese & English\n📋 <code>/summarize content</code> — summarize key points\n🖼️ <code>/img prompt</code> — generate image (embedded in place)\n⚖️ <code>/v question</code> — multi-model comparison (pick 2-3 models step by step)`,
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
          suggestionCandidates = getFallbackModelSuggestions().filter((m) => availableModels.includes(m));
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
        title: '⚖️ Click to select models to compare',
        description: `Compare the same question with 2-${MAX_COMPARE_MODELS} models in parallel`,
        thumbnail_url: THUMBNAILS.sparkles,
        input_message_content: {
          rich_message: {
            markdown: `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n_After clicking, select up to ${MAX_COMPARE_MODELS} models for parallel comparison._`,
          },
        } as any,
        reply_markup: {
          inline_keyboard: [[{ text: '⏹ Stop', callback_data: `inline_stop:${resultId}` }]],
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
        ? '🖼️ **Image generation mode**'
        : task === 'translate' ? '🌐 **Translate mode**'
        : task === 'summarize' ? '📋 **Summarize mode**'
        : task === 'compare' ? '⚖️ **Multi-model comparison mode**'
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
            description: `Answer with ${candidateModel}`,
            thumbnail_url: THUMBNAILS.sparkles,
            input_message_content: {
              rich_message: {
                markdown: `${taskLabel ? taskLabel + '\n\n' : ''}**🧠 Target model:** \`${candidateModel}\`\n\n**💬 Question:**\n> ${displayPrompt}\n\n*🚀 Deep reasoning in progress; the answer will be updated in place when complete.*`,
              },
            } as any,
            // An inline keyboard is REQUIRED for Telegram to return
            // inline_message_id on chosen_inline_result, which is the handle used
            // to stream/update the message in-place (BUGFIX: removed 1056263).
            reply_markup: {
              inline_keyboard: [[
                { text: '⏹ Stop', callback_data: `inline_stop:${candidateId}` }
              ]],
            },
          };
        });

        logger.info(`[InlineQuery] Family mode "${family}": sending ${results.length} model card(s) ids=${results.map((r) => r.id).join(',')}`);
        await ctx.answerInlineQuery(results, { cache_time: 0 });
        return;
      }

      const initTitle = task === 'image'
        ? `🖼️ Click to generate image [${modelToUse}]`
        : task === 'translate' ? `🌐 Click to translate [${modelToUse}]`
        : task === 'summarize' ? `📋 Click to summarize [${modelToUse}]`
        : task === 'compare' ? '⚖️ Click to select models to compare'
        : `🤔 Click to send and start thinking [${modelToUse}]`;
      let initMarkdown: string;
      if (task === 'image') {
        initMarkdown = `**🎨 Image generation mode**\n\n**💬 Prompt:**\n> ${displayPrompt}\n\n*🚀 Generating images; will update in place when complete.*`;
      } else {
        const modelLine = `**🧠 Target model:** \`${modelToUse}\`\n`;
        initMarkdown = `${taskLabel ? taskLabel + '\n\n' : ''}✨ **AI inference engine started**\n\n${modelLine}**💬 Question:**\n> ${displayPrompt}\n\n*🚀 Deep reasoning in progress; the answer will be updated in place when complete.*`;
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
            title: `🧠 Answer with ${candidateModel}`,
            description: `Switch to model ${candidateModel}`,
            thumbnail_url: THUMBNAILS.sparkles,
            input_message_content: {
              rich_message: {
                markdown: `**🧠 Model switch:** \`${candidateModel}\`\n\n**💬 Question:**\n> ${displayPrompt}\n\n*🚀 Deep reasoning in progress; the answer will be updated in place when complete.*`,
              },
            } as any,
            reply_markup: {
              inline_keyboard: [[
                { text: '⏹ Stop', callback_data: `inline_stop:${candidateId}` }
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
          description: `${task === 'image' ? 'Generate image' : `Click to send, ${prompt.slice(0, 40)}...`} — AI ${task === 'image' ? 'image' : 'answer'} will auto-update`,
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
              { text: '⏹ Stop', callback_data: `inline_stop:${resultId}` }
            ]],
          },
        },
        {
          type: 'article' as const,
          id: `prompt-${Date.now()}`,
          title: `💬 Send question card (default model)`,
          description: `Model: ${modelToUse} | "${prompt.slice(0, 40)}..."`,
          thumbnail_url: THUMBNAILS.chat,
          input_message_content: {
            rich_message: {
              markdown: `**💬 AI question card**\n\n**Model:** \`${modelToUse}\`\n**Question:** ${displayPrompt}\n\n*${ICONS.sparkles} Question card sent.*`,
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
        const streamMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${activeModelName}):**\n\n${accumulatedText}\n\n_✍️ Streaming live update..._`;
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

    const cleanOutput = stripWholeMessageCodeFence(result.output);
    const rawOutputLen = cleanOutput.length;

    let footerParts: string[] = [];
    footerParts.push(`⏱️ ${((result.durationMs || 1000) / 1000).toFixed(1)}s`);
    
    const inCount = result.usage?.input || estimateTokens(prompt);
    const outCount = result.usage?.output || estimateTokens(cleanOutput);
    const cachedCount = result.usage?.cached || 0;
    const thinkingCount = result.usage?.thinking || 0;
    const estLabel = !result.usage ? ' (estimated)' : '';

    if (inCount) footerParts.push(`📥 In: ${formatTokenCount(inCount)}${estLabel}`);
    if (outCount) footerParts.push(`📤 Out: ${formatTokenCount(outCount)}${estLabel}`);
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
    const footerText = footerParts.join(' · ');

    let fullMarkdown: string;
    let replyMarkup: unknown;
    let isCollapsible = false;
    let pageCount = 1;
    let finalBlocks: RichBlock[] | undefined = undefined;

    if (cleanOutput.trim().length > 250) {
      if (cleanOutput.length > PAGE_THRESHOLD) {
        // Long answer → paginate with collapsible fold
        const pages = splitIntoPages(cleanOutput);
        pageCount = pages.length;
        const header = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${modelUsed}):**`;
        const pageItems: InlinePage[] = pages.map((page) => {
          const summaryTitle = `💡 ${page.length}-char full answer`;
          const details = `> [details] ${summaryTitle}\n> \n` + page.split('\n').map(line => `> ${line}`).join('\n');
          const footer = footerText ? `\n\n_${footerText}${isFallback ? ' (auto-downgraded)' : ''}_` : '';
          const fullMd = `${header}\n\n${details}${footer}`;
          const blocks = markdownToRichBlocks(fullMd);
          return { markdown: fullMd, blocks: blocks.length > 0 ? blocks : undefined };
        });
        setInlinePages(resultId, pageItems);
        fullMarkdown = pageItems[0].markdown || '';
        finalBlocks = pageItems[0].blocks;
        const baseButtons: { text: string; callback_data: string }[] = [
          { text: '◀️ Prev', callback_data: 'inline_noop' },
          { text: `1/${pageCount}`, callback_data: 'inline_noop' },
          { text: 'Next ▶️', callback_data: `inline_page:${resultId}:1` },
        ];

        replyMarkup = {
          inline_keyboard: [
            baseButtons.filter((b) => !(b.text === '◀️ Prev')),
            [{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }],
          ],
        };
      } else {
        // Medium answer → single collapsible fold
        const summaryTitle = `💡 Click to expand full AI answer (${rawOutputLen} chars)`;
        const bodyMarkdown = `> [details] ${summaryTitle}\n> \n` + cleanOutput.split('\n').map(line => `> ${line}`).join('\n');
        isCollapsible = true;
        fullMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${modelUsed}):**\n\n${bodyMarkdown}${footerText ? `\n\n_${footerText}${isFallback ? ' (auto-downgraded)' : ''}_` : ''}`;
        const blocks = markdownToRichBlocks(fullMarkdown);
        finalBlocks = blocks.length > 0 ? blocks : undefined;
        replyMarkup = {
          inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
        };
      }
    } else {
      // Short answer → plain text
      fullMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${modelUsed}):**\n\n${cleanOutput}${footerText ? `\n\n_${footerText}${isFallback ? ' (auto-downgraded)' : ''}_` : ''}`;
      replyMarkup = {
        inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
      };
    }

    logger.info(`[InlineResult] Submitting final flush edit: userId=${fromId} rawOutputLen=${rawOutputLen} fullMarkdownLen=${fullMarkdown.length} isCollapsible=${isCollapsible}`);

    const success = await streamQueue.flushFinal(fullMarkdown, replyMarkup, finalBlocks);
    if (success) {
      logger.info(`[InlineResult] Successfully flushed final inline message: inline_message_id=${inlineMessageId} userId=${fromId}`);
    }
  } else {
    const wasStopped = ctrl.signal.aborted;
    const displayPrompt = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;
    const failText = wasStopped
      ? `<b>💬 Question:</b> ${escapeHtmlText(displayPrompt)}\n\n⏹ <b>Generation stopped</b>\nTask was manually stopped.`
      : `<b>💬 Question:</b> ${escapeHtmlText(displayPrompt)}\n\n⚠️ <b>Failed to generate answer</b>\nThe model returned no valid text output, please retry.`;
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

  const statuses: {
    model: string;
    done: boolean;
    output?: string;
    error?: string;
    usage?: TokenUsage;
  }[] = models.map((m) => ({ model: m, done: false }));
  let startedAt = Date.now();

  const renderStatus = (): string => {
    const lines = statuses.map((s, i) => {
      const num = ['1.', '2.', '3.'][i] ?? `${i + 1}.`;
      if (s.error) return `${num} \`${s.model}\`\n❌ Generation failed`;
      if (s.done) return `${num} \`${s.model}\`\n✅ Done`;
      return `${num} \`${s.model}\`\n⏳ Thinking...`;
    }).join('\n\n');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    return `**⚖️ Multi-model comparison in progress...**\n\n**💬 Question:**\n> ${displayPrompt}\n\n${lines}\n\n_⏱️ elapsed ${elapsed}s, will update in place when complete._`;
  };

  // Parallel execution, one runModelWithFallbackChain per model.
  const runs = models.map(async (model, i) => {
    let out = '';
    const onChunk = (chunk: string) => {
      out += chunk;
      touchPendingResult(resultId);
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
      statuses[i] = {
        model: `${modelUsed}${isFallback ? ' (downgraded)' : ''}`,
        done: true,
        output: result.output,
        usage: result.usage ?? undefined,
      };
    } else {
      statuses[i] = { model, done: true, error: ctrl.signal.aborted ? 'Stopped' : 'no output' };
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
      ? `**💬 Question:** ${displayPrompt}\n\n⏹ **Comparison stopped**\nTask was manually stopped.`
      : `**💬 Question:** ${displayPrompt}\n\n⚠️ **Comparison failed**\nAll models returned no valid output, please retry.`;
    await ctx.api.raw.editMessageText({
      inline_message_id: inlineMessageId,
      rich_message: { markdown: failText },
    } as any).catch(() => {});
    return;
  }

  // Build paginated comparison: one page per successfully answered model.
  const header = `**⚖️ Multi-model comparison**\n\n**💬 Question:**\n> ${displayPrompt}\n\n`;
  const pageItems: InlinePage[] = doneModels.map((s, i) => {
    const clean = stripWholeMessageCodeFence(s.output || '');
    const num = ['1.', '2.', '3.'][i] ?? `${i + 1}.`;
    const modelLine = `**${num} ${s.model}**\n\n`;
    const summaryTitle = `💡 Click to expand full answer of ${s.model.split(' ')[0] || s.model} (${s.model})`;
    const bodyMarkdown = `> [details] ${summaryTitle}\n> \n` + clean.split('\n').map(line => `> ${line}`).join('\n');
    const footer = `\n\n_⏱️ ${((Date.now() - startedAt) / 1000).toFixed(1)}s_`;
    const fullMd = `${header}${modelLine}${bodyMarkdown}${footer}`;
    const blocks = markdownToRichBlocks(fullMd);
    return { markdown: fullMd, blocks: blocks.length > 0 ? blocks : undefined };
  });

  setInlinePages(resultId, pageItems);
  const pageCount = pageItems.length;

  const allSucceeded = failedModels.length === 0;
  const doneStr = doneModels.map((s) => s.model).join(', ');
  const failNote = failedModels.length > 0 ? `\n\n_⚠️ Failed: ${failedModels.map((s) => s.model).join(', ')}_` : '';

  // First page + pagination keyboard + regenerate.
  const footerText = `${allSucceeded ? 'Comparison complete' : 'Partially complete'}: ${doneStr}${failNote}`;
  const firstPage = `${pageItems[0].markdown}\n\n_${footerText}_`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '◀️ Prev', callback_data: 'inline_noop' },
        { text: `1/${pageCount}`, callback_data: 'inline_noop' },
        { text: 'Next ▶️', callback_data: `inline_page:${resultId}:1` },
      ].filter((b) => b.text !== '◀️ Prev'),
      [{ text: '🔄 Re-compare', callback_data: `inline_regenerate:${resultId}` }],
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

  const success = await streamQueue.flushFinal(firstPage, replyMarkup, pageItems[0].blocks);
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
      text: `<b>🎨 Image generation failed</b>\nThe model returned no session info, please retry.`,
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
        markdown: `**🎨 Image generation result**\n\n**💬 Prompt:** ${displayPrompt}\n\n${output || 'The model did not generate image files.'}`,
      },
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
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
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=r${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n');
    const relayMedia = chunks.flatMap((chunk, ci) =>
      chunk.map((imgPath, i) => ({ id: `r${ci}_${i}`, media: { type: 'photo' as const, media: new InputFile(imgPath) } })),
    );
    const sentMsg = await ctx.api.sendRichMessage(fromId, {
      markdown: `${relayMarkdown}\n\n*uploading relay...*`,
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

  const caption = `**💬 Prompt:** ${displayPrompt}\n\n_Model: ${modelUsed} · ${images.length} image(s) total_`;
  const regenButton = {
    inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
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
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=med${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n')}\n\n${caption}\n\n_🖼️ Image generated, tap 🔄 to regenerate._`;
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
      const fallbackText = `**🖼️ Image generated**\n\n${caption}\n\n_⚠️ In-place rendering failed._`;
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
  const finalText = `**🖼️ Image generated**\n\n${caption}\n\n_⚠️ Could not render via upload (message the bot first to enable DM)_\n\n_Files: ${filesText}_`;
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
