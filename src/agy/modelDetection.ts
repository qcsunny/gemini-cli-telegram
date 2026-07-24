/**
 * @file modelDetection.ts
 * @description Model routing configuration and detection utilities.
 */

import { loadUserConfig } from '../config/userConfig.js';
import { loadModelsConfig, clearModelOrderCache } from '../core/modelRegistry.js';

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
  clearModelOrderCache();
}

export async function getAvailableModels(): Promise<string[]> {
  const cfg = loadUserConfig();
  if (cfg?.orderedModels && cfg.orderedModels.length > 0) {
    return cfg.orderedModels;
  }
  return getDefaultModels();
}
