/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineShared.ts
 * @description Shared inline plumbing (extracted from inlineHandler.ts):
 * Telegram edit helpers, rich-message builders, the model fallback-chain
 * runner with inactivity/hard timeouts, and image-artifact scanning. Used by
 * the inline generation/compare engines and private-task handlers.
 */

import type { Context } from 'grammy';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InlineQueryResult } from '@grammyjs/types/inline.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types/markup.js';
import type { InputRichMessage } from '@grammyjs/types/rich.js';
import { InputFile } from 'grammy';
import type { SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { getAgyDataDir, getTuningConfig, loadUserConfig } from '../../../config/userConfig.js';
import { markdownToRichBlocks } from '../formatter/blocks.js';
import type { RichBlock } from '../richMessage.js';
import { buildTierAwareChain, displayModelName } from '../../../core/modelRegistry.js';
import { logger } from '../../../utils/logger.js';

export type InlineArticle = Extract<InlineQueryResult<never>, { type: 'article' }>;
export type InlineRawEditPayload = {
  inline_message_id: string;
  rich_message?: InputRichMessage<never> | InputRichMessage<InputFile>;
  text?: string;
  parse_mode?: 'HTML';
  reply_markup?: InlineKeyboardMarkup;
};
export type InlineReplyMarkupPayload = {
  inline_message_id: string;
  reply_markup: InlineKeyboardMarkup;
};

// rich_message has been a first-class editMessageText parameter since Bot API
// 10.2 (and @grammyjs/types 4.0.0 carries it), so these call the raw methods
// directly — no more casting around a type that no longer needs it.
export function editInlineMessage(api: Context['api'], payload: InlineRawEditPayload): Promise<unknown> {
  return api.raw.editMessageText(payload);
}

export function editInlineReplyMarkup(api: Context['api'], payload: InlineReplyMarkupPayload): Promise<unknown> {
  return api.raw.editMessageReplyMarkup(payload);
}

/** Inactivity timeout — aborts when no stream activity for 3 minutes (allows agy context loading & deep thinking). */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 180_000;
/** Hard ceiling — aborts regardless of activity to prevent infinite agent loops. */
export const DEFAULT_HARD_TIMEOUT_MS = 600_000;

export function buildInputRichMessage(markdown: string): InputRichMessage<never> {
  const blocks = markdownToRichBlocks(markdown);
  return blocks.length > 0 ? { blocks } : { markdown };
}

/**
 * Build an editable inline frame using only persistent Bot API 10.2 blocks.
 * Inline streaming deliberately uses ordinary paragraphs only. Telegram does
 * not reliably allow a persistent inline edit to open a details block while
 * the model is still producing it; the final edit adds the native details.
 */
export function buildInlineStreamingBlocks(input: {
  prompt: string;
  model: string;
  thought?: string;
  content?: string;
}): RichBlock[] {
  const prompt = input.prompt.length > 300 ? input.prompt.slice(0, 300) + '...' : input.prompt;
  const thought = (input.thought ?? '').trim();
  const content = (input.content ?? '').trim();
  const blocks = markdownToRichBlocks(`**💬 Question:** ${prompt}`);

  if (thought) {
    blocks.push(...markdownToRichBlocks(`**🧠 Thinking:**\n\n${thought}`));
  } else if (!content) {
    blocks.push(...markdownToRichBlocks('**🧠 Thinking...**'));
  }

  if (content) {
    blocks.push(...markdownToRichBlocks(`**🤖 Answer (${displayModelName(input.model)}):**`));
    blocks.push(...markdownToRichBlocks(content));
  }
  return blocks;
}

export const THUMBNAIL_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72';
export const THUMBNAILS = {
  bot: `${THUMBNAIL_BASE}/1f916.png`,
  sparkles: `${THUMBNAIL_BASE}/2728.png`,
  thinking: `${THUMBNAIL_BASE}/1f914.png`,
  warning: `${THUMBNAIL_BASE}/26a0.png`,
};


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
  allowTools?: boolean,
  onEvent?: (event: { type: 'thought' | 'text' | 'done'; content?: string }) => void,
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
        const tuning = getTuningConfig();
        inactivityTimer = setTimeout(() => timeoutCtrl.abort(), tuning.modelRunInactivityMs || DEFAULT_INACTIVITY_TIMEOUT_MS);
      };
      armTimer();
      const hardTimeout = getTuningConfig().modelRunHardTimeoutMs || DEFAULT_HARD_TIMEOUT_MS;
      hardTimer = setTimeout(() => timeoutCtrl.abort(), hardTimeout);
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
      let combined: ReturnType<typeof anySignal> | undefined;
      try {
        logger.info(`[InlineQuery] Attempting model="${modelToUse}" (${attempt}/2) for initial="${initialModel}"`);
        if (onModelStart) onModelStart(modelToUse);
        combined = signal ? anySignal(signal, timeoutCtrl.signal) : undefined;
        const result = await runAgyPrint({
          prompt,
          cwd: customCwd || defaultOptions.cwd || process.cwd(),
          model: modelToUse,
          proxy: defaultOptions.proxy || loadUserConfig()?.proxy || process.env['HTTP_PROXY'] || process.env['http_proxy'],
          onChunk: wrappedChunk,
          onEvent,
          // Any backend stream activity (text, reasoning, tool calls) resets the
          // inactivity timer. Without this, long opencode runs — which stream
          // events but never call onChunk — get killed by the 180s inactivity
          // timeout even while actively generating.
          onActivity: armTimer,
          signal: combined ? combined.signal : timeoutCtrl.signal,
          allowTools,
        });
        clearTimers();
        // A user-initiated stop must terminate the whole chain immediately —
        // never auto-retry an aborted attempt. SSE backends resolve (not reject)
        // with partial output on abort, so check the signal even on success.
        if (signal?.aborted) {
          return { result: null, modelUsed: initialModel, isFallback: false };
        }
        // A timed-out run may carry partial stdout; treat it as a failure rather
        // than returning a truncated "successful" answer. Same for a user stop:
        // web2api/deepseek/opencode backends resolve with partial output (isTimeout
        // stays undefined) when their request is aborted, so guard on the signal too.
        // Remote media backends (Qwen t2i/t2v) legitimately return an empty body
        // with the artifacts on result.mediaFiles — that is a success, not a retry.
        if ((result?.output || result?.mediaFiles?.length) && !result.isTimeout && !signal?.aborted) {
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
      } finally {
        combined?.cleanup();
      }
    }
  }

  return { result: null, modelUsed: initialModel, isFallback: false };
}

export function anySignal(...signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const listeners: Array<{ sig: AbortSignal; fn: () => void }> = [];
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    const fn = () => ctrl.abort(s.reason);
    s.addEventListener('abort', fn, { once: true });
    listeners.push({ sig: s, fn });
  }
  const cleanup = () => {
    for (const { sig, fn } of listeners) {
      sig.removeEventListener('abort', fn);
    }
  };
  return { signal: ctrl.signal, cleanup };
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
