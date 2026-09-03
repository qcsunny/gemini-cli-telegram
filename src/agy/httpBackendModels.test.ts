/**
 * @file httpBackendModels.test.ts
 * @description Tests for the /v1/models fetch over the OpenAI-compatible
 * HTTP backends (web2api/glm/qwen/mimo/deepseek).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithTimeoutMock = vi.fn();
vi.mock('../utils/fetchWithTimeout.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

const loadUserConfigSpy = vi.fn();
vi.mock('../config/userConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/userConfig.js')>();
  return {
    ...actual,
    loadUserConfig: (...args: unknown[]) => loadUserConfigSpy(...args),
    getBackendUrl: (service: string) => (service === 'deepseek' ? 'http://127.0.0.1:5002/v1' : `http://127.0.0.1:809${service === 'glm' ? 3 : service === 'qwen' ? 2 : 0}/v1`),
    getWeb2ApiKey: () => 'sk-gemini-local',
  };
});
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listHttpBackendModels } from './httpBackendModels.js';

function makeResp(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const SAMPLE = {
  data: [
    { id: 'glm-5.3', description: 'GLM 5.3 base' },
    { id: 'glm-5.3-thinking' },
    { id: 123 }, // malformed entry skipped
    { description: 'no id, skipped' },
  ],
};

describe('listHttpBackendModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadUserConfigSpy.mockReturnValue({
      backends: { glmKey: 'sk-glm', qwenKey: 'sk-qwen', mimoKey: 'sk-mimo' },
      deepseekApiKey: 'sk-ds',
    });
  });

  it('fetches {base}/models with the per-backend key and parses entries', async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeResp(true, 200, SAMPLE));

    const entries = await listHttpBackendModels('glm');

    expect(entries).toEqual([
      { id: 'glm-5.3', description: 'GLM 5.3 base' },
      { id: 'glm-5.3-thinking', description: undefined },
    ]);
    const [url, init] = fetchWithTimeoutMock.mock.calls[0] as [string, { headers: Record<string, string> }, number];
    expect(url).toBe('http://127.0.0.1:8093/v1/models');
    expect(init.headers['Authorization']).toBe('Bearer sk-glm');
  });

  it('uses the top-level deepseekApiKey (not backends.deepseekKey)', async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeResp(true, 200, { data: [{ id: 'deepseek-v4-pro' }] }));

    await listHttpBackendModels('deepseek');

    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [string, { headers: Record<string, string> }, number];
    expect(init.headers['Authorization']).toBe('Bearer sk-ds');
  });

  it('omits the auth header when no key is configured', async () => {
    loadUserConfigSpy.mockReturnValue({});
    fetchWithTimeoutMock.mockResolvedValue(makeResp(true, 200, { data: [{ id: 'glm-5.3' }] }));

    await listHttpBackendModels('glm');

    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [string, { headers: Record<string, string> }, number];
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('rejects on non-200 responses', async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeResp(false, 502, {}));

    await expect(listHttpBackendModels('glm')).rejects.toThrow('HTTP 502');
  });

  it('rejects (safety gate) when the list is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeResp(true, 200, { data: [] }));

    await expect(listHttpBackendModels('glm')).rejects.toThrow('0 个模型');
  });

  it('rejects on invalid JSON bodies', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    });

    await expect(listHttpBackendModels('glm')).rejects.toThrow('有效 JSON');
  });

  it('propagates transport failures (timeout / connection refused)', async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error('fetch failed'));

    await expect(listHttpBackendModels('glm')).rejects.toThrow('fetch failed');
  });
});
