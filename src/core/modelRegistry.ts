/**
 * @file modelRegistry.ts
 * @description Model order resolution, channel detection, and tiered fallback chain builder.
 * Config priority: config.json orderedModels → config.json modelsConfig.tiers → models.json defaultOrder.
 */

import * as fssync from 'node:fs';
import { loadUserConfig } from '../config/userConfig.js';
import { logger } from '../utils/logger.js';

// ── ModelsConfig (mirrors the structure in agyCli.ts) ────────────────────────

export interface ModelsConfig {
  channelOrder?: string[];
  defaultOrder?: string[];
  routing: Record<string, string>;
  tiers?: Array<{ name: string; priority: number; models: string[] }>;
}

let _parsedModels: ModelsConfig | null | undefined;

export function loadModelsConfig(): ModelsConfig | null {
  if (_parsedModels !== undefined) return _parsedModels;

  // 优先从用户配置 modelsConfig 读取
  const userCfg = loadUserConfig();
  if (userCfg?.modelsConfig) {
    _parsedModels = {
      channelOrder: userCfg.modelsConfig.channelOrder,
      defaultOrder: userCfg.modelsConfig.tiers?.flatMap(t => t.models) ?? [],
      routing: userCfg.modelsConfig.routing,
      tiers: userCfg.modelsConfig.tiers,
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
 * Derives display order from tiers + channelOrder.
 * Groups models by channel (agy/deepseek/opencode/web2api) within each tier,
 * respecting the channelOrder for grouping priority.
 */
function deriveDisplayOrder(tiers: ModelsConfig['tiers'], channelOrder: string[]): string[] {
  if (!tiers || tiers.length === 0) return [];

  // Build channel → models map across all tiers (preserving tier priority)
  const channelModels = new Map<string, string[]>();
  for (const ch of channelOrder) channelModels.set(ch, []);

  for (const tier of [...tiers].sort((a, b) => a.priority - b.priority)) {
    for (const model of tier.models) {
      const ch = getChannelModel(model) ?? 'agy';
      const list = channelModels.get(ch);
      if (list) list.push(model);
    }
  }

  // Flatten in channelOrder
  const result: string[] = [];
  for (const ch of channelOrder) {
    result.push(...(channelModels.get(ch) ?? []));
  }
  return result;
}

/**
 * Returns the effective model order list.
 * Priority: config.json orderedModels → derived from tiers+channelOrder → models.json defaultOrder.
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

  // 2. config.json modelsConfig.tiers + channelOrder
  if (cfg?.modelsConfig?.tiers && cfg.modelsConfig.tiers.length > 0) {
    const channelOrder = cfg.modelsConfig.channelOrder ?? ['agy', 'deepseek', 'opencode', 'web2api'];
    _cachedModelOrder = deriveDisplayOrder(cfg.modelsConfig.tiers, channelOrder);
    logger.info(`[modelRegistry] Derived display order from tiers+channelOrder (${_cachedModelOrder.length} models)`);
    return _cachedModelOrder;
  }

  // 3. models.json: derive from tiers + channelOrder
  const modelsCfg = loadModelsConfig();
  if (modelsCfg?.tiers && modelsCfg.tiers.length > 0) {
    const channelOrder = modelsCfg.channelOrder ?? ['agy', 'deepseek', 'opencode', 'web2api'];
    _cachedModelOrder = deriveDisplayOrder(modelsCfg.tiers, channelOrder);
    logger.info(`[modelRegistry] Derived display order from tiers+channelOrder (${_cachedModelOrder.length} models)`);
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

export interface ModelTier {
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
  return 'agy';
}

// ── Circular Fallback Chain ──────────────────────────────────────────────────

/**
 * Builds a circular fallback chain starting at `startModel`.
 *
 * Algorithm:
 *   1. Locate startModel in the effective model list.
 *   2. Push all models from startModel to the end (weaker models).
 *   3. Wrap around and push all models from the beginning up to startModel
 *      (stronger models) — handles the case where even the weakest model fails.
 *
 * If startModel is not found, prepend it and return the full list.
 */
export function buildChannelAwareChain(startModel: string): string[] {
  const models = getEffectiveModelOrder();
  const idx = models.indexOf(startModel);
  if (idx === -1) {
    return [startModel, ...models];
  }
  const chain: string[] = [];
  for (let i = idx; i < models.length; i++) {
    chain.push(models[i]);
  }
  for (let i = 0; i < idx; i++) {
    chain.push(models[i]);
  }
  return chain;
}

/**
 * Returns channel order derived from tier priority.
 * Channels appear in the same order as their corresponding tiers.
 */
export function getChannelOrder(): string[] {
  const tiers = getEffectiveTiers();
  if (!tiers) return ['agy', 'web2api', 'deepseek', 'opencode'];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const t of tiers) {
    const ch = t.channel || 'agy';
    if (!seen.has(ch)) {
      seen.add(ch);
      order.push(ch);
    }
  }
  return order.length > 0 ? order : ['agy', 'web2api', 'deepseek', 'opencode'];
}

/**
 * Builds a capability-tier-aware fallback chain from configured tiers.
 *
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
