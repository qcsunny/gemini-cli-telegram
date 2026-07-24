/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import * as fssync from 'node:fs';
import {
  getEffectiveModelOrder,
  getEffectiveTiers,
  getChannelModel,
  buildTierAwareChain,
  clearModelOrderCache,
} from './modelRegistry.js';
import * as userConfig from '../config/userConfig.js';

const MOCK_MODELS_JSON = {
  tiers: [
    { name: 'Tier A', priority: 0, models: ['model-a1', 'model-a2'] },
    { name: 'Tier B', priority: 1, models: ['model-b1', 'model-b2'] },
  ],
  defaultOrder: ['model-a1', 'model-a2', 'model-b1', 'model-b2'],
  routing: { 'model-a1': 'id-a1', 'model-b1': 'id-b1' },
};

describe('modelRegistry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearModelOrderCache();
    vi.mocked(fssync.readFileSync).mockReturnValue(JSON.stringify(MOCK_MODELS_JSON));
  });

  describe('getEffectiveModelOrder', () => {
    it('should use orderedModels from user config when present', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
        telegramBotToken: 'token',
        allowedUsers: [1],
        orderedModels: ['custom-1', 'custom-2', 'custom-3'],
      } as any);

      const result = getEffectiveModelOrder();
      expect(result).toEqual(['custom-1', 'custom-2', 'custom-3']);
    });

    it('should use modelsConfig.tiers from user config when orderedModels is absent', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
        telegramBotToken: 'token',
        allowedUsers: [1],
        modelsConfig: {
          tiers: [
            { name: 'Fast', priority: 1, models: ['fast-1', 'fast-2'] },
            { name: 'Strong', priority: 0, models: ['strong-1'] },
          ],
          routing: {},
        },
      } as any);

      const result = getEffectiveModelOrder();
      // Should be sorted by priority then flattened
      expect(result).toEqual(['strong-1', 'fast-1', 'fast-2']);
    });

    it('should fall back to models.json defaultOrder when no user config', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);

      const result = getEffectiveModelOrder();
      expect(result).toEqual(['model-a1', 'model-a2', 'model-b1', 'model-b2']);
    });

    it('should return empty array when nothing is configured', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);
      vi.mocked(fssync.readFileSync).mockImplementation(() => {
        throw new Error('file not found');
      });

      const result = getEffectiveModelOrder();
      expect(result).toEqual([]);
    });

    it('should cache result across calls', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
        telegramBotToken: 'token',
        allowedUsers: [1],
        orderedModels: ['cached-model'],
      } as any);

      const result1 = getEffectiveModelOrder();
      const result2 = getEffectiveModelOrder();
      expect(result1).toBe(result2); // Same reference (cached)
    });

    it('should invalidate cache on clearModelOrderCache()', () => {
      vi.spyOn(userConfig, 'loadUserConfig')
        .mockReturnValueOnce({
          telegramBotToken: 'token',
          allowedUsers: [1],
          orderedModels: ['first'],
        } as any)
        .mockReturnValueOnce({
          telegramBotToken: 'token',
          allowedUsers: [1],
          orderedModels: ['second'],
        } as any);

      const result1 = getEffectiveModelOrder();
      clearModelOrderCache();
      const result2 = getEffectiveModelOrder();
      expect(result1).toEqual(['first']);
      expect(result2).toEqual(['second']);
    });
  });

  describe('getEffectiveTiers', () => {
    it('should use modelsConfig.tiers from user config', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
        telegramBotToken: 'token',
        allowedUsers: [1],
        modelsConfig: {
          tiers: [
            { name: 'Fast', priority: 1, models: ['fast-1'] },
            { name: 'Strong', priority: 0, models: ['strong-1'] },
          ],
          routing: {},
        },
      } as any);

      const result = getEffectiveTiers();
      expect(result).toEqual([
        { name: 'Strong', priority: 0, models: ['strong-1'] },
        { name: 'Fast', priority: 1, models: ['fast-1'] },
      ]);
    });

    it('should fall back to models.json tiers', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);

      const result = getEffectiveTiers();
      expect(result).toEqual([
        { name: 'Tier A', priority: 0, models: ['model-a1', 'model-a2'] },
        { name: 'Tier B', priority: 1, models: ['model-b1', 'model-b2'] },
      ]);
    });

    it('should return null when no tiers are configured', () => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);
      vi.mocked(fssync.readFileSync).mockReturnValue(JSON.stringify({
        defaultOrder: ['m1'],
        routing: {},
      }));

      const result = getEffectiveTiers();
      expect(result).toBeNull();
    });

    it('should not return mutated original array', () => {
      const tiers = [
        { name: 'B', priority: 1, models: ['b'] },
        { name: 'A', priority: 0, models: ['a'] },
      ];
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
        telegramBotToken: 'token',
        allowedUsers: [1],
        modelsConfig: { tiers, routing: {} },
      } as any);

      const result = getEffectiveTiers()!;
      expect(result[0].name).toBe('A');
      // Original array should not be mutated
      expect(tiers[0].name).toBe('B');
    });
  });

  describe('getChannelModel', () => {
    it('should return web2api for Web2API: prefix', () => {
      expect(getChannelModel('Web2API: Gemini 3.5 Flash')).toBe('web2api');
    });

    it('should return deepseek for DeepSeek: prefix', () => {
      expect(getChannelModel('DeepSeek: Pro Thinking')).toBe('deepseek');
    });

    it('should return agy for models without prefix', () => {
      expect(getChannelModel('Gemini 3.6 Flash (High)')).toBe('agy');
    });

    it('should return agy for Claude models', () => {
      expect(getChannelModel('Claude Opus 4.6 (Thinking)')).toBe('agy');
    });
  });

  describe('buildTierAwareChain', () => {
    beforeEach(() => {
      vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue(null);
    });

    it('should build fallback chain starting from startModel down to lower tiers (monotonic)', () => {
      const chain = buildTierAwareChain('model-b1');
      // Starts at Tier B (model-b1), no lower tiers
      expect(chain).toEqual(['model-b1', 'model-b2']);
    });

    it('should start from the first model of highest tier and include all models', () => {
      const chain = buildTierAwareChain('model-a1');
      expect(chain).toEqual(['model-a1', 'model-a2', 'model-b1', 'model-b2']);
    });

    it('should start from the second model of highest tier and exclude the first (monotonic)', () => {
      const chain = buildTierAwareChain('model-a2');
      expect(chain).toEqual(['model-a2', 'model-b1', 'model-b2']);
    });

    it('should only include startModel when it is the last in the lowest tier', () => {
      const chain = buildTierAwareChain('model-b2');
      expect(chain).toEqual(['model-b2']);
    });

    it('should append unknown model and include all from effective order', () => {
      const chain = buildTierAwareChain('unknown-model');
      expect(chain).toEqual(['unknown-model', 'model-a1', 'model-a2', 'model-b1', 'model-b2']);
    });

    it('should filter out skipped models', () => {
      const skip = new Set(['model-a2', 'model-b1']);
      const chain = buildTierAwareChain('model-a1', skip);
      expect(chain).toEqual(['model-a1', 'model-b2']);
    });
  });
});
