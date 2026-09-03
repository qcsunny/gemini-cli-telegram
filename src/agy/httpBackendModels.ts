/**
 * @file httpBackendModels.ts
 * @description Fetches the model list of the OpenAI-compatible HTTP backends
 * (web2api / glm / qwen / mimo / deepseek) via `GET {base}/v1/models`.
 *
 * All five are local proxies speaking the OpenAI protocol, so one module
 * covers them all; only the URL / key source differs per backend:
 *   - web2api: getBackendUrl('web2api') + getWeb2ApiKey()
 *   - glm/qwen/mimo: backends.{service} + backends.{service}Key
 *   - deepseek: backends.deepseek + TOP-LEVEL deepseekApiKey
 */
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';
import { getBackendUrl, getWeb2ApiKey, loadUserConfig } from '../config/userConfig.js';
import { logger } from '../utils/logger.js';

export type HttpBackendName = 'web2api' | 'glm' | 'qwen' | 'mimo' | 'deepseek';

export const HTTP_BACKEND_NAMES: readonly HttpBackendName[] = ['web2api', 'glm', 'qwen', 'mimo', 'deepseek'];

/** One upstream model: routing id plus the endpoint's optional description. */
export interface HttpModelEntry {
  id: string;
  /** Free-text description from the /v1/models payload (models.json desc source). */
  description?: string;
}

/** Resolve the API key for a backend; empty string means "send no auth header". */
function apiKeyFor(service: HttpBackendName): string {
  const cfg = loadUserConfig();
  switch (service) {
    case 'web2api':
      return getWeb2ApiKey();
    case 'glm':
      return cfg?.backends?.glmKey ?? '';
    case 'qwen':
      return cfg?.backends?.qwenKey ?? '';
    case 'mimo':
      return cfg?.backends?.mimoKey ?? '';
    case 'deepseek':
      // deepseekApiKey lives at the TOP LEVEL of config, not under backends
      return cfg?.deepseekApiKey ?? '';
  }
}

interface ModelsPayload {
  data?: Array<{ id?: unknown; description?: unknown }>;
}

/**
 * List a backend's models. Rejects on non-200 / transport failure / timeout /
 * empty list (the empty gate is a safety net: never let a flaky upstream wipe
 * config entries in the sync pass).
 */
export async function listHttpBackendModels(service: HttpBackendName, timeoutMs = 15_000): Promise<HttpModelEntry[]> {
  const base = getBackendUrl(service);
  if (!base) {
    throw new Error(`${service} 后端未配置 (config.backends.${service})`);
  }
  const url = `${base.replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = {};
  const key = apiKeyFor(service);
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const resp = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!resp.ok) {
    throw new Error(`${service} /models 返回 HTTP ${resp.status}`);
  }

  let payload: ModelsPayload;
  try {
    payload = (await resp.json()) as ModelsPayload;
  } catch (e) {
    throw new Error(`${service} /models 响应不是有效 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const entries: HttpModelEntry[] = [];
  for (const m of payload.data ?? []) {
    if (typeof m?.id !== 'string' || !m.id) continue;
    entries.push({ id: m.id, description: typeof m.description === 'string' ? m.description : undefined });
  }

  if (entries.length === 0) {
    logger.warn(`[httpBackendModels] ${service} /models returned no entries`);
    throw new Error(`${service} /models 返回 0 个模型（安全起见未做任何修改）`);
  }
  return entries;
}
