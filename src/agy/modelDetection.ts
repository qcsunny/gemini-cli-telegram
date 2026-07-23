/**
 * @file modelDetection.ts
 * @description Model routing configuration and detection utilities.
 * Loads models from user config (modelsConfig) or falls back to models.json.
 */

import { loadUserConfig } from '../config/userConfig.js';
import * as fssync from 'node:fs';
import { logger } from '../utils/logger.js';

export interface ModelsConfig {
  defaultOrder: string[];
  routing: Record<string, string>;
  tiers?: Array<{ name: string; priority: number; models: string[] }>;
}

let _parsedModels: ModelsConfig | null | undefined; // undefined = need reload, null = failed, object = cached

export function loadModelsConfig(): ModelsConfig | null {
  if (_parsedModels !== undefined) return _parsedModels;

  // 1. 优先从用户配置 modelsConfig 读取
  const userCfg = loadUserConfig();
  if (userCfg?.modelsConfig) {
    _parsedModels = {
      defaultOrder: userCfg.modelsConfig.tiers.flatMap(t => t.models),
      routing: userCfg.modelsConfig.routing,
      tiers: userCfg.modelsConfig.tiers,
    };
    logger.info(`[agyCli] Using modelsConfig from user config (${_parsedModels.defaultOrder.length} models, ${_parsedModels.tiers?.length ?? 0} tiers)`);
    return _parsedModels;
  }

  // 2. Fallback 到硬编码 models.json
  try {
    const url = new URL('../config/models.json', import.meta.url);
    const content = fssync.readFileSync(url, 'utf-8');
    _parsedModels = JSON.parse(content) as ModelsConfig;
  } catch (e) {
    _parsedModels = null;
  }
  return _parsedModels;
}

/** Returns true if the model name has a routing entry pointing to web2api */
export function isWeb2ApiModel(model: string): boolean {
  const cfg = loadModelsConfig();
  if (!cfg) return false;
  return model in cfg.routing && model.startsWith('Web2API:');
}

/** Returns true if the model name has a routing entry pointing to deepseek */
export function isDeepSeekModel(model: string): boolean {
  const cfg = loadModelsConfig();
  if (!cfg) return false;
  return model in cfg.routing && model.startsWith('DeepSeek:');
}

let _defaultModels: string[] | undefined;

function getDefaultModels(): string[] {
  if (_defaultModels) return _defaultModels;
  const cfg = loadModelsConfig();
  if (cfg?.defaultOrder) {
    _defaultModels = cfg.defaultOrder;
  } else {
    _defaultModels = [];
  }
  return _defaultModels;
}

/** Clears cached model order, forcing re-read from disk on next call. */
export function clearDefaultModelsCache(): void {
  _defaultModels = undefined;
  _parsedModels = undefined; // also force reload of models.json
}

export async function getAvailableModels(): Promise<string[]> {
  const cfg = loadUserConfig();
  if (cfg?.orderedModels && cfg.orderedModels.length > 0) {
    return cfg.orderedModels;
  }
  return getDefaultModels();
}
