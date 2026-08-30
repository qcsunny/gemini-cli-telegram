/**
 * @file mimo.ts
 * @description MiMo (aistudio.xiaomimimo.com) proxy backend — an OpenAI-compatible
 * SSE endpoint served by the local mimo-2api instance.
 *
 * Only the MiMo-specific parts live here; the streaming machinery is shared with
 * deepseek / web2api / glm / qwen in {@link runSseBackend}.
 *
 * mimo-2api streams the upstream `<think>` span as `reasoning_content` deltas,
 * so the thinking chain survives — but only when streaming (its non-streaming
 * path drops the span entirely). The proxy has no server-side session cache and
 * no X-Conversation-Id support, so history is replayed in full from the client.
 */

import { loadUserConfig } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { mimoHistories, makeMimoConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

/** Upstream id used when a display name carries no routing entry. */
const MIMO_FALLBACK_MODEL_ID = 'mimo-v2.5-pro';

export async function runMiMo(opts: AgyRunOptions): Promise<AgyRunResult> {
  return runSseBackend(opts, {
    backend: 'mimo',
    label: 'MiMo',
    histories: mimoHistories,
    makeConvId: makeMimoConvId,
    resolveModelId: (alias) => loadModelsConfig()?.routing[alias] ?? MIMO_FALLBACK_MODEL_ID,
    authHeaders: (): Record<string, string> => {
      const apiKey = loadUserConfig()?.backends?.mimoKey || '';
      return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    },
    // Same TCP half-open protection as deepseek (BUG-03).
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
