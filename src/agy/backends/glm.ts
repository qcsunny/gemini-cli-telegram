/**
 * @file glm.ts
 * @description GLM (chatglm.cn) web2api proxy backend — an OpenAI-compatible
 * SSE endpoint served by the local HelloGML instance.
 *
 * Only the GLM-specific parts live here; the streaming machinery is shared with
 * deepseek and web2api in {@link runSseBackend}.
 *
 * Model ids come from the upstream account's own model list (HelloGML syncs
 * `available_models` every 12h), so `routing` in models.json maps display names
 * like `GLM: 5.3 Ultra Thinking` onto ids like `glm-5.3-deep-thinking`. Two
 * upstream models × three reasoning depths + deep research = eight ids.
 *
 * The display names deliberately say `Ultra Thinking` / `Research` rather than
 * `Deep ...`: inline queries use `@deep` as the DeepSeek family shortcut, and
 * fuzzyMatchModels would otherwise hand those results to GLM.
 */

import { loadUserConfig } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { glmHistories, makeGlmConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

/** Upstream id used when a display name carries no routing entry. */
const GLM_FALLBACK_MODEL_ID = 'glm-5.3-flash';

export async function runGlm(opts: AgyRunOptions): Promise<AgyRunResult> {
  return runSseBackend(opts, {
    backend: 'glm',
    label: 'GLM',
    histories: glmHistories,
    makeConvId: makeGlmConvId,
    resolveModelId: (alias) => loadModelsConfig()?.routing[alias] ?? GLM_FALLBACK_MODEL_ID,
    authHeaders: (): Record<string, string> => {
      const apiKey = loadUserConfig()?.backends?.glmKey || '';
      return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    },
    // Deep research runs multi-step web retrieval; upstream can stay quiet for
    // a while between reasoning frames, so the read timeout is well above the
    // 60s the plain chat models need.
    timeoutMs: 300_000,
    // No X-Conversation-Id: HelloGML threads multi-turn by fingerprinting the
    // replayed history against its conversations.json map and then forwarding
    // only the newest user message upstream. Replaying the full history — which
    // runSseBackend already does — is exactly what that lookup expects.
    // The duration is unknown while streaming, so the live tag carries 0.0 and
    // buildOutput stamps the measured value onto the stored copy.
    openThinking: '<thinking time="0.0">',
    closeThinking: '</thinking>',
    buildOutput: ({ thought, content, thinkingMs }) => {
      if (!thought) return content;
      const durationSec = (thinkingMs / 1000).toFixed(1);
      return `<thinking time="${durationSec}">${thought}</thinking>\n\n${content}`;
    },
    // chatglm answers an over-quota or rejected turn with HTTP 200 and an empty
    // body, so an empty reply has to fail loudly instead of sending a blank
    // Telegram message.
    emptyOutputError: 'GLM 上游返回空内容（可能触发限流或会话失效），请重试或换模型',
    logFirstChunks: true,
  });
}
