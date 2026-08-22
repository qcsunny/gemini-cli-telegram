/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineContext.ts
 * @description Shared in-memory state for the inline pipeline (extracted from
 * inlineHandler.ts): pending results, abort controllers, regenerate/compare
 * contexts, the disk-backed paginated answer store, and the 60s cleanup timer
 * that evicts expired entries (unref'd so it never holds the process open).
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { getAgyDataDir } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';
import type { RichBlock } from '../richMessage.js';
import type { InlineTask } from './inlineModelMatch.js';

/** Registration options for the inline handler. */
export interface InlineHandlerOptions {
  allowedUsers?: number[];
}

export const RESULTS_TTL = 120_000;

export interface PendingResult {
  ownerId: number;
  prompt: string;
  model: string;
  projectPath?: string;
  task?: InlineTask;
  createdAt: number;
  /** Refreshed on every stream chunk to prevent premature TTL expiry on long active streams. */
  lastActiveTime: number;
  /** /invest <symbol>: prefetch deterministic analysis data after the user clicks. */
  isInvest?: boolean;
  investSymbol?: string;
  /** /invest 对比 a,b,c: multi-symbol comparison. */
  investSymbols?: string[];
}

export const pendingResults = new Map<string, PendingResult>();
export const userControllers = new Map<string, AbortController>();
export const pendingStockRequests = new Map<string, { queryStr: string; webAppUrl: string; createdAt: number }>();
export const fullInlineOutputs = new Map<string, { prompt: string; output: string; model: string; createdAt: number }>();
/**
 * Last inline query payload per result id, kept longer than RESULTS_TTL so a
 * user who lingers on the result list past the pending TTL can still start the
 * generation by clicking (the card would otherwise be stuck forever).
 */
export const recentInlineQueries = new Map<string, { prompt: string; model: string; task?: InlineTask; isInvest?: boolean; investSymbol?: string; investSymbols?: string[]; createdAt: number }>();

export function inlineOwnerMatches(resultId: string, userId: number | undefined): boolean {
  // Real Telegram callback queries always include `from`; tolerate missing
  // values in synthetic contexts and older adapters.
  if (!userId) return true;
  const pending = pendingResults.get(resultId);
  if (pending) return pending.ownerId === userId;
  const regen = regenerateContexts.get(resultId);
  if (regen) return regen.fromId === userId;
  const compare = compareContexts.get(resultId);
  if (compare) return compare.fromId === userId;
  return false;
}

export interface RegenerateContext {
  prompt: string;
  model: string;
  projectPath?: string;
  fromId: number;
  inlineMessageId: string;
  task?: InlineTask;
  createdAt: number;
}

export const regenerateContexts = new Map<string, RegenerateContext>();

/** In-progress /v multi-model comparison state, keyed by resultId. */
export const compareContexts = new Map<string, CompareContext>();


export interface InlinePage {
  markdown?: string;
  blocks?: RichBlock[];
}

// ---------------------------------------------------------------------------
// Persistent inline-pages store (survives bot restarts)
// ---------------------------------------------------------------------------
export const INLINE_PAGES_TTL = 7 * 24 * 60 * 60_000; // 7 days

export interface InlinePagesStore {
  [resultId: string]: { pages: InlinePage[]; createdAt: number };
}

export function getInlinePagesFile(): string {
  return path.join(getAgyDataDir(), 'inline_pages.json');
}

export function loadInlinePagesFromDisk(): Map<string, InlinePage[]> {
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

export async function saveInlinePagesToDisk(map: Map<string, InlinePage[]>): Promise<void> {
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
    const file = getInlinePagesFile();
    const tmp = `${file}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(store), 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    logger.warn(`[inlinePages] Failed to persist to disk: ${e}`);
  }
}

export let _inlinePagesOnDisk: InlinePagesStore = {};
export let inlinePagesWriteQueue: Promise<void> = Promise.resolve();

export function persistInlinePages(): void {
  inlinePagesWriteQueue = inlinePagesWriteQueue
    .then(() => saveInlinePagesToDisk(inlinePages))
    .catch((e) => logger.warn(`[inlinePages] Persistence queue failed: ${e}`));
}

/** Paginated pages of a finished answer, keyed by resultId. Disk-backed. */
export const inlinePages = loadInlinePagesFromDisk();

export function setInlinePages(resultId: string, pages: InlinePage[]): void {
  inlinePages.set(resultId, pages);
  _inlinePagesOnDisk[resultId] = { pages, createdAt: Date.now() };
  persistInlinePages();
}

export function deleteInlinePages(resultId: string): void {
  inlinePages.delete(resultId);
  delete _inlinePagesOnDisk[resultId];
  persistInlinePages();
}

/** Max models user can pick for a /v multi-model comparison. */
export const MAX_COMPARE_MODELS = 4;
/** Max candidate models offered per page in the picker. */
export const COMPARE_MODELS_PER_PAGE = 4;

export interface CompareContext {
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

export const ACTION_TTL = 30 * 60_000;

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
    // (i.e. truly inactive/expired), never abort an active stream. Compare and
    // regenerate runs never enter pendingResults (compare returns early in
    // inline_query; regenerate only re-arms userControllers), so guard on their
    // context maps too — otherwise the timer would kill a long-running
    // comparison or regeneration after one RESULTS_TTL tick.
    if (!pendingResults.has(resultId) && !compareContexts.has(resultId) && !regenerateContexts.has(resultId)) {
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
  for (const [key, val] of pendingStockRequests) {
    if (val.createdAt < actionCutoff) {
      pendingStockRequests.delete(key);
    }
  }
  for (const [key, val] of recentInlineQueries) {
    if (val.createdAt < actionCutoff) {
      recentInlineQueries.delete(key);
    }
  }
  const inlinePagesCutoff = Date.now() - INLINE_PAGES_TTL;
  let inlinePagesDirty = false;
  for (const [key, val] of Object.entries(_inlinePagesOnDisk)) {
    if (val.createdAt < inlinePagesCutoff) {
      delete _inlinePagesOnDisk[key];
      inlinePages.delete(key);
      inlinePagesDirty = true;
    }
  }
  if (inlinePagesDirty) {
    persistInlinePages();
  }
}, 60_000);
cleanupTimer.unref();
