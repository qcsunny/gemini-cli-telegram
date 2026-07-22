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

import { loadUserConfig, saveUserConfig, configExists } from './userConfig.js';

describe('userConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it('should throw ZodError when invalid config is loaded', () => {
    const invalidConfig = {
      allowedUsers: 'not-an-array',
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(() => loadUserConfig()).toThrow();
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
});
