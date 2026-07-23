/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');
vi.mock('node:os', () => ({
  homedir: () => '/mock/home',
}));

import { loadUserConfig, saveUserConfig, configExists, getTuningConfig, getBackendUrl, clearConfigCache, TUNING_DEFAULTS, BACKEND_URL_DEFAULTS } from './userConfig.js';

describe('userConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearConfigCache();
  });

  it('should return null if config does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(configExists()).toBe(false);
    expect(loadUserConfig()).toBeNull();
  });

  it('should load config if it exists and matches schema', () => {
    const mockConfig = {
      telegramBotToken: 'test-token',
      allowedUsers: [123],
      model: 'gemini-2.5-flash',
      projects: [
        {
          id: 'proj-1',
          name: 'Project 1',
          path: '/path/to/proj',
        },
      ],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

    expect(configExists()).toBe(true);
    expect(loadUserConfig()).toEqual(mockConfig);
  });

  it('should return null when invalid config is loaded instead of throwing', () => {
    const invalidConfig = {
      allowedUsers: 'not-an-array',
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(loadUserConfig()).toBeNull();
  });

  it('should save config', () => {
    const mockConfig = {
      telegramBotToken: 'new-token',
      allowedUsers: [456],
    };

    saveUserConfig(mockConfig);

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.stringContaining('new-token'),
      expect.objectContaining({ mode: 0o600 })
    );
  });

  describe('getTuningConfig', () => {
    it('should return defaults when no config exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const tuning = getTuningConfig();
      expect(tuning).toEqual(TUNING_DEFAULTS);
    });

    it('should merge config overrides with defaults', () => {
      const mockConfig = {
        telegramBotToken: 'token',
        allowedUsers: [1],
        tuning: {
          retriesPerModel: 5,
          debounceIntervalMs: 500,
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const tuning = getTuningConfig();
      expect(tuning.retriesPerModel).toBe(5);
      expect(tuning.debounceIntervalMs).toBe(500);
      // Other values should be defaults
      expect(tuning.modelRunHardTimeoutMs).toBe(TUNING_DEFAULTS.modelRunHardTimeoutMs);
      expect(tuning.maxHistoryMessages).toBe(TUNING_DEFAULTS.maxHistoryMessages);
    });
  });

  describe('getBackendUrl', () => {
    it('should return default web2api URL when no config', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getBackendUrl('web2api')).toBe(BACKEND_URL_DEFAULTS.web2api);
    });

    it('should return default deepseek URL when no config', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getBackendUrl('deepseek')).toBe(BACKEND_URL_DEFAULTS.deepseek);
    });

    it('should use config override when provided', () => {
      const mockConfig = {
        telegramBotToken: 'token',
        allowedUsers: [1],
        backends: {
          web2api: 'http://custom:9090/v1',
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      expect(getBackendUrl('web2api')).toBe('http://custom:9090/v1');
    });
  });

  describe('modelsConfig schema', () => {
    it('should accept valid modelsConfig', () => {
      const mockConfig = {
        telegramBotToken: 'token',
        allowedUsers: [1],
        modelsConfig: {
          tiers: [
            { name: 'Fast', priority: 0, models: ['m1'] },
          ],
          routing: { 'm1': 'model-id-1' },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const cfg = loadUserConfig();
      expect(cfg?.modelsConfig).toBeDefined();
      expect(cfg?.modelsConfig?.tiers).toHaveLength(1);
      expect(cfg?.modelsConfig?.routing).toEqual({ 'm1': 'model-id-1' });
    });

    it('should reject modelsConfig with missing tiers', () => {
      const mockConfig = {
        telegramBotToken: 'token',
        allowedUsers: [1],
        modelsConfig: {
          routing: { 'm1': 'model-id-1' },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      expect(loadUserConfig()).toBeNull();
    });

    it('should accept config without modelsConfig (optional)', () => {
      const mockConfig = {
        telegramBotToken: 'token',
        allowedUsers: [1],
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const cfg = loadUserConfig();
      expect(cfg?.modelsConfig).toBeUndefined();
    });
  });
});
