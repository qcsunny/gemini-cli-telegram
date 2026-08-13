/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, execFile: vi.fn() };
});

vi.mock('../../../config/userConfig.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../config/userConfig.js')>();
  return {
    ...mod,
    loadUserConfig: vi.fn().mockReturnValue({
      projects: [{ name: '价值投资分析专家', path: '/fake/invest-project' }],
    }),
    getStockMarketApiKey: vi.fn().mockReturnValue('FAKE_FMP_KEY'),
  };
});

import { fetchInvestAnalysis, buildInvestPrompt, getInvestProjectPath } from './investDataFetcher.js';

describe('investDataFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getInvestProjectPath', () => {
    it('resolves the value-invest-analysis project from user config', () => {
      expect(getInvestProjectPath()).toBe('/fake/invest-project');
    });
  });

  describe('fetchInvestAnalysis', () => {
    it('resolves ok:true with parsed JSON data on success', async () => {
      const fakeJson = JSON.stringify({ symbol: '600519', grade: 'A-', totalScore: 68.4 });
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, fakeJson, '');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('600519', '/fake/invest-project');
      expect(result.ok).toBe(true);
      expect(result.symbol).toBe('600519');
      expect(result.data).toBe(fakeJson);
      // FMP key must be injected into the subprocess env
      const opts = vi.mocked(execFile).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env['FMP_API_KEY']).toBe('FAKE_FMP_KEY');
    });

    it('resolves ok:false with error message on script failure', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(new Error('spawn ENOENT'), '', 'DATA_ERROR: boom');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('BAD', '/fake/invest-project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('resolves ok:false on non-JSON output', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
        cb(null, 'not-json', '');
        return {} as any;
      });

      const result = await fetchInvestAnalysis('X', '/fake/invest-project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid JSON');
    });
  });

  describe('buildInvestPrompt', () => {
    it('injects the analysis data and keeps the user question', () => {
      const prompt = buildInvestPrompt('请对 600519 做深度价值投资分析。', '{"grade":"A-"}');
      expect(prompt).toContain('```json');
      expect(prompt).toContain('{"grade":"A-"}');
      expect(prompt).toContain('请对 600519 做深度价值投资分析。');
      expect(prompt).toContain('六维度');
    });
  });
});