/**
 * @file deepseek.ts
 * @description DeepSeek API proxy backend — an OpenAI-compatible SSE endpoint.
 *
 * Only the DeepSeek-specific parts live here; the streaming machinery is shared
 * with web2api in {@link runSseBackend}.
 */

import { getDefaultModels, loadUserConfig } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { deepseekHistories, makeDeepSeekConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

export async function runDeepSeek(opts: AgyRunOptions): Promise<AgyRunResult> {
  return runSseBackend(opts, {
    backend: 'deepseek',
    label: 'DeepSeek',
    histories: deepseekHistories,
    makeConvId: makeDeepSeekConvId,
    resolveModelId: (alias) => loadModelsConfig()?.routing[alias] ?? getDefaultModels()?.deepseekId,
    authHeaders: (): Record<string, string> => {
      const apiKey = loadUserConfig()?.deepseekApiKey || '';
      return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    },
    // BUG-03: TCP half-open connections must not hang the turn forever.
    timeoutMs: 60_000,
    // The duration is unknown while streaming, so the live tag carries 0.0 and
    // buildOutput stamps the measured value onto the stored copy.
    openThinking: '<thinking time="0.0">',
    closeThinking: '</thinking>',
    buildOutput: ({ thought, content, thinkingMs }) => {
      if (!thought) return content;
      const durationSec = (thinkingMs / 1000).toFixed(1);
      return `<thinking time="${durationSec}">${thought}</thinking>\n\n${content}`;
    },
  });
}
