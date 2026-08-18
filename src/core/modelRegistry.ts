/**
 * @file modelRegistry.ts
 * @description Model order resolution, channel detection, and tiered fallback chain builder.
 * Config priority: config.json orderedModels → config.json modelsConfig.tiers → models.json defaultOrder.
 */

import * as fssync from 'node:fs';
import { loadUserConfig } from '../config/userConfig.js';
import { logger } from '../utils/logger.js';

// ── ModelsConfig (mirrors the structure in agyCli.ts) ────────────────────────

interface ModelsConfig {
  defaultOrder?: string[];
  routing: Record<string, string>;
  tiers?: Array<{ name: string; priority: number; models: string[] }>;
  compareDefaults?: string[];
}

let _parsedModels: ModelsConfig | null | undefined;

export function loadModelsConfig(): ModelsConfig | null {
  if (_parsedModels !== undefined) return _parsedModels;

  // 优先从用户配置 modelsConfig 读取
  const userCfg = loadUserConfig();
  if (userCfg?.modelsConfig) {
    _parsedModels = {
      defaultOrder: userCfg.modelsConfig.tiers?.flatMap(t => t.models) ?? [],
      routing: userCfg.modelsConfig.routing,
      tiers: userCfg.modelsConfig.tiers,
      compareDefaults: userCfg.modelsConfig.compareDefaults,
    };
    logger.info(`[modelRegistry] Using modelsConfig from user config (${_parsedModels.defaultOrder?.length ?? 0} models, ${_parsedModels.tiers?.length ?? 0} tiers)`);
    return _parsedModels;
  }

  // Fallback 到硬编码 models.json
  try {
    const url = new URL('../config/models.json', import.meta.url);
    const content = fssync.readFileSync(url, 'utf-8');
    _parsedModels = JSON.parse(content) as ModelsConfig;
  } catch {
    _parsedModels = null;
  }
  return _parsedModels;
}

// ── Model Order ──────────────────────────────────────────────────────────────

let _cachedModelOrder: string[] | undefined;

/** Clears the cached model order list. Called on SIGHUP to force re-read from config. */
export function clearModelOrderCache(): void {
  _cachedModelOrder = undefined;
  _parsedModels = undefined;
}

/**
 * Derives display order from tiers, preserving each tier's internal model order.
 * Models are listed tier by tier (sorted by priority), in the exact order
 * they appear within each tier.
 */
function deriveDisplayOrder(tiers: ModelsConfig['tiers']): string[] {
  if (!tiers || tiers.length === 0) return [];

  const result: string[] = [];
  for (const tier of [...tiers].sort((a, b) => a.priority - b.priority)) {
    for (const model of tier.models) {
      result.push(model);
    }
  }
  return result;
}

/**
 * Returns the effective model order list.
 * Priority: config.json orderedModels → derived from tiers → models.json defaultOrder.
 */
export function getEffectiveModelOrder(): string[] {
  if (_cachedModelOrder !== undefined) return _cachedModelOrder;

  const cfg = loadUserConfig();

  // 1. config.json orderedModels (最高优先级，向后兼容)
  if (cfg?.orderedModels && cfg.orderedModels.length > 0) {
    _cachedModelOrder = cfg.orderedModels;
    logger.info(`[modelRegistry] Using orderedModels from config (${_cachedModelOrder.length} models)`);
    return _cachedModelOrder;
  }

  // 2. config.json modelsConfig.tiers
  if (cfg?.modelsConfig?.tiers && cfg.modelsConfig.tiers.length > 0) {
    _cachedModelOrder = deriveDisplayOrder(cfg.modelsConfig.tiers);
    logger.info(`[modelRegistry] Derived display order from tiers (${_cachedModelOrder.length} models)`);
    return _cachedModelOrder;
  }

  // 3. models.json: derive from tiers
  const modelsCfg = loadModelsConfig();
  if (modelsCfg?.tiers && modelsCfg.tiers.length > 0) {
    _cachedModelOrder = deriveDisplayOrder(modelsCfg.tiers);
    logger.info(`[modelRegistry] Derived display order from tiers (${_cachedModelOrder.length} models)`);
    return _cachedModelOrder;
  }

  // 4. models.json defaultOrder (fallback)
  if (modelsCfg?.defaultOrder && modelsCfg.defaultOrder.length > 0) {
    _cachedModelOrder = modelsCfg.defaultOrder;
    return _cachedModelOrder;
  }

  // 5. 空列表 (不应到达)
  logger.warn('[modelRegistry] No model order found in any config source');
  _cachedModelOrder = [];
  return _cachedModelOrder;
}

// ── Tier Resolution ──────────────────────────────────────────────────────────

interface ModelTier {
  name: string;
  priority: number;
  models: string[];
  channel?: string;
}

/**
 * Returns the effective tier list, sorted by priority.
 * Priority: config.json modelsConfig.tiers → models.json tiers → null.
 */
export function getEffectiveTiers(): ModelTier[] | null {
  const cfg = loadUserConfig();

  if (cfg?.modelsConfig?.tiers && cfg.modelsConfig.tiers.length > 0) {
    return [...cfg.modelsConfig.tiers].sort((a, b) => a.priority - b.priority);
  }

  const modelsCfg = loadModelsConfig();
  if (modelsCfg?.tiers && modelsCfg.tiers.length > 0) {
    return [...modelsCfg.tiers].sort((a, b) => a.priority - b.priority);
  }

  return null;
}

// ── Channel Detection ────────────────────────────────────────────────────────

/**
 * Determines which backend channel a model belongs to, based on its display name prefix.
 * Returns 'agy' | 'deepseek' | 'web2api' | 'opencode', or null if the prefix is unrecognized.
 */
export function getChannelModel(model: string): string | null {
  if (model.startsWith('Web2API:')) return 'web2api';
  if (model.startsWith('DeepSeek:')) return 'deepseek';
  if (model.startsWith('OpenCode:')) return 'opencode';
  if (model.startsWith('Claude CLI:')) return 'claude';
  if (model.startsWith('Codex:')) return 'codex';
  return 'agy';
}

// ── Tier-Aware Fallback Chain ────────────────────────────────────────────────

/**
 * Algorithm:
 *   1. Reads configured tiers (sorted by priority).
 *   2. Finds which tier `startModel` belongs to (T_k).
 *   3. Starts from `startModel` in T_k, then appends all remaining models in T_k.
 *   4. Appends all models in subsequent lower tiers (T_k+1, T_k+2, ...).
 *   5. Guarantees monotonic downgrade (只降不升: never upgrades to a higher tier).
 *   6. Excludes any models in `skipModels`.
 */
export function buildTierAwareChain(startModel: string, skipModels?: Set<string>): string[] {
  const tiers = getEffectiveTiers();

  if (!tiers || tiers.length === 0) {
    const models = getEffectiveModelOrder();
    const startIdx = Math.max(0, models.indexOf(startModel));
    return models.slice(startIdx).filter(m => !skipModels?.has(m));
  }

  let startTierIdx = -1;
  let modelInTierIdx = -1;

  for (let i = 0; i < tiers.length; i++) {
    const idx = tiers[i].models.indexOf(startModel);
    if (idx !== -1) {
      startTierIdx = i;
      modelInTierIdx = idx;
      break;
    }
  }

  if (startTierIdx === -1) {
    const models = getEffectiveModelOrder();
    const startIdx = models.indexOf(startModel);
    const ordered = startIdx >= 0 ? models.slice(startIdx) : [startModel, ...models];
    return ordered.filter(m => !skipModels?.has(m));
  }

  const chain: string[] = [];

  // Models in startModel's tier starting from startModel
  const startTier = tiers[startTierIdx];
  for (let j = modelInTierIdx; j < startTier.models.length; j++) {
    const m = startTier.models[j];
    if (!skipModels?.has(m)) chain.push(m);
  }

  // Models in all subsequent lower tiers (strictly monotonic downgrade)
  for (let i = startTierIdx + 1; i < tiers.length; i++) {
    for (const m of tiers[i].models) {
      if (!skipModels?.has(m)) chain.push(m);
    }
  }

  return chain;
}

/**
 * Display model name: strip the version number from Claude Opus / Sonnet,
 * everything else stays as configured.
 */
export function displayModelName(model: string): string {
  return model.replace(/^(Claude (?:Opus|Sonnet)) \d+(?:\.\d+)*/, '$1');
}
