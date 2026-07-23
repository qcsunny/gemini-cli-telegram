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
  defaultOrder: string[];
  routing: Record<string, string>;
  tiers?: Array<{ name: string; priority: number; models: string[] }>;
}

let _parsedModels: ModelsConfig | null | undefined;

function loadModelsConfig(): ModelsConfig | null {
  if (_parsedModels !== undefined) return _parsedModels;

  // 优先从用户配置 modelsConfig 读取
  const userCfg = loadUserConfig();
  if (userCfg?.modelsConfig) {
    _parsedModels = {
      defaultOrder: userCfg.modelsConfig.tiers.flatMap(t => t.models),
      routing: userCfg.modelsConfig.routing,
      tiers: userCfg.modelsConfig.tiers,
    };
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
 * Returns the effective model order list.
 * Priority: config.json orderedModels → config.json modelsConfig.tiers → models.json defaultOrder.
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

  // 2. config.json modelsConfig.tiers (扁平化)
  if (cfg?.modelsConfig?.tiers && cfg.modelsConfig.tiers.length > 0) {
    _cachedModelOrder = cfg.modelsConfig.tiers
      .sort((a, b) => a.priority - b.priority)
      .flatMap(t => t.models);
    logger.info(`[modelRegistry] Using modelsConfig.tiers from config (${_cachedModelOrder.length} models, ${cfg.modelsConfig.tiers.length} tiers)`);
    return _cachedModelOrder;
  }

  // 3. models.json defaultOrder
  const modelsCfg = loadModelsConfig();
  if (modelsCfg?.defaultOrder && modelsCfg.defaultOrder.length > 0) {
    _cachedModelOrder = modelsCfg.defaultOrder;
    return _cachedModelOrder;
  }

  // 4. 空列表 (不应到达)
  logger.warn('[modelRegistry] No model order found in any config source');
  _cachedModelOrder = [];
  return _cachedModelOrder;
}

// ── Tier Resolution ──────────────────────────────────────────────────────────

export interface ModelTier {
  name: string;
  priority: number;
  models: string[];
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
 * Returns 'agy' | 'deepseek' | 'web2api', or null if the prefix is unrecognized.
 */
export function getChannelModel(model: string): string | null {
  if (model.startsWith('Web2API:')) return 'web2api';
  if (model.startsWith('DeepSeek:')) return 'deepseek';
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
