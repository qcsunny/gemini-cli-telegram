/**
 * @file web2api.ts
 * @description Web2API proxy backend — an OpenAI-compatible SSE endpoint.
 *
 * Only the Web2API-specific parts live here; the streaming machinery is shared
 * with deepseek in {@link runSseBackend}.
 */

import { getWeb2ApiKey } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { web2apiHistories, makeWeb2ApiConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

/** Used when the model alias has no routing entry. */
const FALLBACK_MODEL_ID = 'gemini-3.1-pro';

export async function runWeb2Api(opts: AgyRunOptions): Promise<AgyRunResult> {
  return runSseBackend(opts, {
    backend: 'web2api',
    label: 'Web2API',
    histories: web2apiHistories,
    makeConvId: makeWeb2ApiConvId,
    resolveModelId: (alias) => loadModelsConfig()?.routing[alias] ?? FALLBACK_MODEL_ID,
    authHeaders: () => ({ 'Authorization': `Bearer ${getWeb2ApiKey()}` }),
    // The Gemini web bridge is slower than a raw API, so it gets a longer leash.
    timeoutMs: 120_000,
    openThinking: '<thought>',
    closeThinking: '</thought>',
    // Web2API keeps the interleaved stream verbatim: reasoning and answer can
    // alternate more than once and thoughtParser renders every block.
    buildOutput: ({ stream }) => stream,
    emptyOutputError:
      '⚠️ The upstream returned empty, possibly rate-limited by the Gemini web interface. Please try again later.',
    logFirstChunks: true,
  });
}
