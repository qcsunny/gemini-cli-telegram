/**
 * @file inlineHandler.ts
 * @description Telegram inline query handler (thin registration layer).
 * Wires bot.on() callbacks to the extracted handlers; the heavy lifting lives
 * in sibling modules: inlineContext (shared state), inlineShared (edit
 * helpers + fallback-chain runner), inlineCompare (/v multi-model comparison),
 * inlineGeneration (answer/image engine), inlineCallbackActions,
 * inlineQueryResults and inlineChosenResult (the three event handlers).
 */

import type { Bot } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type { InlineHandlerOptions } from './inlineContext.js';
import { handleInlineCallbackQuery } from './inlineCallbackActions.js';
import { handleInlineQuery } from './inlineQueryResults.js';
import { handleChosenInlineResult } from './inlineChosenResult.js';

// Re-exports for external consumers (privateTaskHandler, privateImageHandler,
// sessionHandlers, commands.test.ts, inlineHandler.test.ts).
export { parseInlineModelAndPrompt, fuzzyMatchModels, IMAGE_TASK_INSTRUCTION, MAX_COLLAGE_IMAGES } from './inlineModelMatch.js';
export type { InlineTask } from './inlineModelMatch.js';
export { stripInlineImages, truncateInlineMarkdown } from './inlineStreamQueue.js';
export { runModelWithFallbackChain, buildInlineStreamingBlocks, findNewImageArtifacts } from './inlineShared.js';
export { compareModelName } from './inlineCompare.js';
export { fullInlineOutputs, pendingResults, touchPendingResult } from './inlineContext.js';

export function registerInlineHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions = {},
  options: InlineHandlerOptions = {},
): void {
  bot.on('callback_query:data', (ctx, next) =>
    handleInlineCallbackQuery(ctx, sessionManager, defaultOptions, next),
  );
  bot.on('inline_query', (ctx) =>
    handleInlineQuery(ctx, sessionManager, defaultOptions, options),
  );
  bot.on('chosen_inline_result', (ctx) =>
    handleChosenInlineResult(ctx, sessionManager, defaultOptions),
  );
}