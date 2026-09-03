/**
 * @file modelSync.test.ts
 * @description Tests for Gemini Flash/Pro version sync: pure parsing/selection
 * functions, config rewrite orchestration, and src/config/models.json update.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const loadUserConfigSpy = vi.fn();
const saveUserConfigSpy = vi.fn();
const clearConfigCacheSpy = vi.fn();
const listAgyModelsMock = vi.fn();

vi.mock('../config/userConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/userConfig.js')>();
  return {
    ...actual,
    loadUserConfig: (...args: unknown[]) => loadUserConfigSpy(...args),
    saveUserConfig: (...args: unknown[]) => saveUserConfigSpy(...args),
    clearConfigCache: (...args: unknown[]) => clearConfigCacheSpy(...args),
  };
});
vi.mock('../agy/agyModels.js', () => ({
  listAgyModels: (...args: unknown[]) => listAgyModelsMock(...args),
}));
const listOpenCodeModelsMock = vi.fn();
vi.mock('../agy/opencodeModels.js', () => ({
  listOpenCodeModels: (...args: unknown[]) => listOpenCodeModelsMock(...args),
}));
vi.mock('../agy/modelDetection.js', () => ({
  clearDefaultModelsCache: vi.fn(),
}));
vi.mock('./modelRegistry.js', () => ({
  clearModelOrderCache: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  parseGeminiModelDisplay,
  pickLatestGemini,
  computeModelSyncPlan,
  updateModelsJsonFile,
  runModelSync,
} from './modelSync.js';
import { clearDefaultModelsCache } from '../agy/modelDetection.js';
import { clearModelOrderCache } from './modelRegistry.js';
import type { AgyModelEntry } from '../agy/agyModels.js';

function entries(...displays: string[]): AgyModelEntry[] {
  return displays.map((display) => ({ id: display.toLowerCase().replace(/[^a-z0-9]+/g, '-'), display }));
}

const AGY_3_6_TO_3_8 = entries(
  'Gemini 3.8 Flash (High)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (Low)',
  'Gemini 3.7 Flash (High)',
  'Gemini 3.7 Flash (Medium)',
  'Gemini 3.7 Flash (Low)',
  'Gemini 3.6 Flash (High)',
  'Gemini 3.6 Flash (Medium)',
  'Gemini 3.6 Flash (Low)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
);

const BASE_CONFIG = {
  telegramBotToken: 'test-token',
  allowedUsers: [123],
  model: 'Gemini 3.7 Flash (High)',
  modelsConfig: {
    tiers: [
      { name: '旗舰推理', priority: 0, models: ['Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)'] },
      { name: '高级推理', priority: 1, models: ['Gemini 3.7 Flash (High)', 'Gemini 3.1 Pro (Low)'] },
      { name: '通用能力', priority: 2, models: ['Gemini 3.7 Flash (Medium)'] },
      { name: '轻量与免费', priority: 3, models: ['Gemini 3.7 Flash (Low)'] },
      { name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking'] },
    ],
    routing: { 'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking' },
  },
  defaultModels: {
    taskModel: 'Gemini 3.7 Flash (High)',
    inlineSuggestions: ['Gemini 3.7 Flash (High)', 'Claude CLI: Claude Opus 5'],
    compareGroup: ['Claude CLI: Claude Opus 5'],
  },
  summarization: { defaultCount: 100, maxCount: 500 },
};

describe('parseGeminiModelDisplay', () => {
  it('accepts Flash and Pro forms with all efforts', () => {
    expect(parseGeminiModelDisplay('Gemini 3.7 Flash (High)')).toEqual({
      family: 'Flash', major: 3, minor: 7, effort: 'High', display: 'Gemini 3.7 Flash (High)',
    });
    expect(parseGeminiModelDisplay('Gemini 3.1 Pro (Low)')?.family).toBe('Pro');
    expect(parseGeminiModelDisplay('Gemini 3.7 Flash (Medium)')?.effort).toBe('Medium');
  });

  it('rejects prefixed channel models and other backends', () => {
    expect(parseGeminiModelDisplay('Web2API: Gemini 3.7 Flash Thinking')).toBeNull();
    expect(parseGeminiModelDisplay('Claude Opus 4.6 (Thinking)')).toBeNull();
    expect(parseGeminiModelDisplay('GPT-OSS 120B (Medium)')).toBeNull();
    expect(parseGeminiModelDisplay('Gemini 3.7 Flash')).toBeNull();
    expect(parseGeminiModelDisplay('gemini 3.7 flash (high)')).toBeNull();
  });
});

describe('pickLatestGemini', () => {
  it('picks the highest flash version across 3.6/3.7/3.8', () => {
    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    expect(latest['Flash']?.major).toBe(3);
    expect(latest['Flash']?.minor).toBe(8);
    expect(latest['Flash']?.displays['High']).toBe('Gemini 3.8 Flash (High)');
    expect(latest['Flash']?.displays['Low']).toBe('Gemini 3.8 Flash (Low)');
    expect(latest['Flash']?.displays['Medium']).toBe('Gemini 3.8 Flash (Medium)');
  });

  it('keeps families independent (Pro stays at 3.1)', () => {
    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    expect(latest['Pro']?.minor).toBe(1);
    expect(latest['Pro']?.displays['High']).toBe('Gemini 3.1 Pro (High)');
  });

  it('compares versions numerically (3.10 > 3.9)', () => {
    const latest = pickLatestGemini(entries('Gemini 3.9 Flash (High)', 'Gemini 3.10 Flash (High)'));
    expect(latest['Flash']?.minor).toBe(10);
  });

  it('returns empty when agy has no gemini flash/pro models', () => {
    expect(pickLatestGemini(entries('Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'))).toEqual({});
  });
});

describe('computeModelSyncPlan', () => {
  it('plans same-effort upgrades only, leaving other families/prefixes alone', () => {
    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    const plan = computeModelSyncPlan(
      [
        'Gemini 3.7 Flash (High)',
        'Gemini 3.7 Flash (Medium)',
        'Gemini 3.7 Flash (Low)',
        'Gemini 3.1 Pro (High)',
        'Web2API: Gemini 3.7 Flash Thinking',
        'Claude Opus 4.6 (Thinking)',
      ],
      latest,
    );
    expect(plan).toEqual([
      { family: 'Flash', effort: 'High', from: 'Gemini 3.7 Flash (High)', to: 'Gemini 3.8 Flash (High)' },
      { family: 'Flash', effort: 'Medium', from: 'Gemini 3.7 Flash (Medium)', to: 'Gemini 3.8 Flash (Medium)' },
      { family: 'Flash', effort: 'Low', from: 'Gemini 3.7 Flash (Low)', to: 'Gemini 3.8 Flash (Low)' },
    ]);
  });

  it('plans pro upgrades when a newer pro exists', () => {
    const latest = pickLatestGemini(entries('Gemini 3.1 Pro (High)', 'Gemini 4.0 Pro (High)', 'Gemini 4.0 Pro (Low)'));
    const plan = computeModelSyncPlan(['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)'], latest);
    expect(plan).toEqual([
      { family: 'Pro', effort: 'High', from: 'Gemini 3.1 Pro (High)', to: 'Gemini 4.0 Pro (High)' },
      { family: 'Pro', effort: 'Low', from: 'Gemini 3.1 Pro (Low)', to: 'Gemini 4.0 Pro (Low)' },
    ]);
  });

  it('never downgrades when local version is older than config', () => {
    const latest = pickLatestGemini(entries('Gemini 3.6 Flash (High)'));
    expect(computeModelSyncPlan(['Gemini 3.7 Flash (High)'], latest)).toEqual([]);
  });

  it('is idempotent when already at the latest version', () => {
    const latest = pickLatestGemini(entries('Gemini 3.8 Flash (High)'));
    expect(computeModelSyncPlan(['Gemini 3.8 Flash (High)'], latest)).toEqual([]);
  });

  it('skips efforts the latest version does not provide', () => {
    const latest = pickLatestGemini(entries('Gemini 4.0 Flash (High)'));
    const plan = computeModelSyncPlan(['Gemini 3.7 Flash (High)', 'Gemini 3.7 Flash (Low)'], latest);
    expect(plan).toEqual([
      { family: 'Flash', effort: 'High', from: 'Gemini 3.7 Flash (High)', to: 'Gemini 4.0 Flash (High)' },
    ]);
  });
});

describe('updateModelsJsonFile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rewrites outdated gemini names in tiers and defaultOrder, preserving other entries', () => {
    const modelsJson = {
      tiers: [{ name: '高级推理', priority: 1, models: ['Gemini 3.7 Flash (High)', 'OpenCode: Big Pickle'] }],
      defaultOrder: ['Gemini 3.1 Pro (High)', 'Gemini 3.7 Flash (Low)'],
      descriptions: { 'Gemini 3.7 Flash (High)': 'desc', 'OpenCode: Big Pickle': 'pickle' },
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(modelsJson));

    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    const result = updateModelsJsonFile('/mock/models.json', latest);

    expect(result.updated).toBe(true);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.tiers[0].models).toEqual(['Gemini 3.8 Flash (High)', 'OpenCode: Big Pickle']);
    expect(written.defaultOrder).toEqual(['Gemini 3.1 Pro (High)', 'Gemini 3.8 Flash (Low)']);
    expect(written.descriptions).toEqual({
      'Gemini 3.8 Flash (High)': 'desc',
      'OpenCode: Big Pickle': 'pickle',
    });
  });

  it('reports updated=false without writing when nothing changes', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tiers: [{ name: 't', priority: 0, models: ['Gemini 3.1 Pro (High)'] }],
    }));
    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    const result = updateModelsJsonFile('/mock/models.json', latest);
    expect(result.updated).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns error instead of throwing on read failure', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const latest = pickLatestGemini(AGY_3_6_TO_3_8);
    const result = updateModelsJsonFile('/mock/models.json', latest);
    expect(result.updated).toBe(false);
    expect(result.error).toContain('ENOENT');
  });
});

describe('runModelSync', () => {
  // Default OpenCode mock: a single live big-pickle (no -free suffix, not routed
  // anywhere in BASE_CONFIG) → OpenCode plan is empty, avoiding the safety-gate reject.
  const OC_NOOP: Array<{ id: string; name: string; active: boolean; free: boolean }> = [
    { id: 'opencode/big-pickle', name: 'Big Pickle', active: true, free: true },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    loadUserConfigSpy.mockReturnValue(structuredClone(BASE_CONFIG));
    listOpenCodeModelsMock.mockResolvedValue(OC_NOOP);
  });

  it('upgrades all config slots, saves, clears caches, and updates models.json', async () => {
    listAgyModelsMock.mockResolvedValue(AGY_3_6_TO_3_8);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tiers: [{ name: 't', priority: 0, models: ['Gemini 3.7 Flash (High)'] }],
    }));

    const result = await runModelSync();

    expect(result.status).toBe('updated');
    expect(result.upgrades).toHaveLength(3); // High / Medium / Low flash
    expect(result.modelsJsonUpdated).toBe(true);

    const saved = saveUserConfigSpy.mock.calls[0][0] as typeof BASE_CONFIG;
    expect(saved.model).toBe('Gemini 3.8 Flash (High)');
    expect(saved.modelsConfig.tiers[1].models).toEqual(['Gemini 3.8 Flash (High)', 'Gemini 3.1 Pro (Low)']);
    expect(saved.modelsConfig.tiers[2].models).toEqual(['Gemini 3.8 Flash (Medium)']);
    expect(saved.modelsConfig.tiers[3].models).toEqual(['Gemini 3.8 Flash (Low)']);
    expect(saved.modelsConfig.tiers[4].models).toEqual(['Web2API: Gemini 3.7 Flash Thinking']); // untouched
    expect(saved.modelsConfig.routing).toEqual(BASE_CONFIG.modelsConfig.routing); // untouched
    expect(saved.defaultModels.taskModel).toBe('Gemini 3.8 Flash (High)');
    expect(saved.defaultModels.inlineSuggestions).toEqual(['Gemini 3.8 Flash (High)', 'Claude CLI: Claude Opus 5']);

    // backup written before save
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.stringMatching(/config\.json\.bak-/),
    );
    // hot-reload cache trio
    expect(clearConfigCacheSpy).toHaveBeenCalled();
    expect(clearDefaultModelsCache).toHaveBeenCalled();
    expect(clearModelOrderCache).toHaveBeenCalled();
  });

  it('writes nothing when already up to date', async () => {
    listAgyModelsMock.mockResolvedValue(entries('Gemini 3.7 Flash (High)', 'Gemini 3.7 Flash (Medium)', 'Gemini 3.7 Flash (Low)'));
    const result = await runModelSync();
    expect(result.status).toBe('up-to-date');
    expect(saveUserConfigSpy).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('writes nothing when agy has no gemini flash/pro models', async () => {
    listAgyModelsMock.mockResolvedValue(entries('Claude Sonnet 4.6 (Thinking)'));
    const result = await runModelSync();
    expect(result.status).toBe('no-gemini');
    expect(saveUserConfigSpy).not.toHaveBeenCalled();
  });

  it('propagates agy models failures', async () => {
    listAgyModelsMock.mockRejectedValue(new Error('agy models exited with code 1'));
    await expect(runModelSync()).rejects.toThrow('agy models exited with code 1');
    expect(saveUserConfigSpy).not.toHaveBeenCalled();
  });

  it('still reports success when models.json sync fails', async () => {
    listAgyModelsMock.mockResolvedValue(AGY_3_6_TO_3_8);
    // loadUserConfig is spied, so the first readFileSync call is models.json's
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    const result = await runModelSync();
    expect(result.status).toBe('updated');
    expect(result.modelsJsonUpdated).toBe(false);
    expect(result.modelsJsonError).toContain('ENOENT');
  });
});

describe('runModelSync — OpenCode sub-sync', () => {
  // Local opencode list mirroring the real snapshot: hy3 gone, muse 1.2→1.3,
  // ling/nemotron new free models.
  const OC_LOCAL = [
    { id: 'opencode/big-pickle', name: 'Big Pickle', active: true, free: true },
    { id: 'opencode/muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Free', active: true, free: true },
    { id: 'opencode/muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', active: true, free: true },
    { id: 'opencode/mimo-v2.5-free', name: 'MiMo V2.5 Free', active: true, free: true },
    { id: 'opencode/ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', active: true, free: true },
    { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', active: true, free: true },
  ];

  const OC_CONFIG = {
    ...structuredClone(BASE_CONFIG),
    modelsConfig: {
      tiers: [
        { name: '旗舰推理', priority: 0, models: ['Gemini 3.1 Pro (High)'] },
        { name: '高级推理', priority: 1, models: ['Gemini 3.7 Flash (High)'] },
        { name: '通用能力', priority: 2, models: ['Gemini 3.7 Flash (Medium)'] },
        { name: '轻量与免费', priority: 3, models: ['Gemini 3.7 Flash (Low)', 'OpenCode: Muse Spark 1.2 Free', 'OpenCode: Hunyuan 3.0 Free', 'OpenCode: MiMo V2.5 Free'] },
        { name: '全栈编程', priority: 4, models: ['OpenCode: Big Pickle', 'OpenCode: GLM 4.7 Flash'] },
      ],
      routing: {
        'OpenCode: Muse Spark 1.2 Free': 'opencode/muse-spark-1.2-contributor-free',
        'OpenCode: Hunyuan 3.0 Free': 'opencode/hy3-free',
        'OpenCode: MiMo V2.5 Free': 'opencode/mimo-v2.5-free',
        'OpenCode: Big Pickle': 'opencode/big-pickle',
        'OpenCode: GLM 4.7 Flash': 'zhipuai/glm-4.7-flash',
      },
    },
  };

  const AGY_CURRENT = entries('Gemini 3.7 Flash (High)', 'Gemini 3.7 Flash (Medium)', 'Gemini 3.7 Flash (Low)');

  beforeEach(() => {
    vi.resetAllMocks();
    loadUserConfigSpy.mockReturnValue(structuredClone(OC_CONFIG));
    listOpenCodeModelsMock.mockResolvedValue(OC_LOCAL);
    listAgyModelsMock.mockResolvedValue(AGY_CURRENT);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tiers: [{ name: '轻量与免费', priority: 3, models: ['OpenCode: Muse Spark 1.2 Free', 'OpenCode: Hunyuan 3.0 Free'] }],
      routing: {
        'OpenCode: Muse Spark 1.2 Free': 'opencode/muse-spark-1.2-contributor-free',
        'OpenCode: Hunyuan 3.0 Free': 'opencode/hy3-free',
      },
    }));
  });

  it('applies OpenCode removal + upgrade + addition in the same save as Gemini', async () => {
    listAgyModelsMock.mockResolvedValue(AGY_3_6_TO_3_8); // Gemini also upgrades

    const result = await runModelSync();

    expect(result.status).toBe('updated');
    expect(result.upgrades).toHaveLength(3); // Gemini flash High/Medium/Low
    expect(result.opCode.status).toBe('updated');
    expect(result.opCode.removals.map((r) => r.routingId)).toEqual(['opencode/hy3-free']);
    expect(result.opCode.upgrades.map((u) => u.newRoutingId)).toEqual(['opencode/muse-spark-1.3-contributor-free']);
    expect(result.opCode.additions.map((a) => a.routingId).sort()).toEqual([
      'opencode/ling-3.0-flash-fin-free',
      'opencode/nemotron-3-ultra-free',
    ]);

    const saved = saveUserConfigSpy.mock.calls[0][0] as typeof OC_CONFIG;
    const routing = saved.modelsConfig.routing;
    expect(routing['OpenCode: Hunyuan 3.0 Free']).toBeUndefined();
    expect(routing['OpenCode: Muse Spark 1.3 Free']).toBe('opencode/muse-spark-1.3-contributor-free');
    expect(routing['OpenCode: Ling 3.0 Flash Fin Free']).toBe('opencode/ling-3.0-flash-fin-free');
    expect(routing['OpenCode: GLM 4.7 Flash']).toBe('zhipuai/glm-4.7-flash'); // non-opencode/ untouched
    const light = saved.modelsConfig.tiers.find((t) => t.name === '轻量与免费')!;
    expect(light.models).toContain('OpenCode: Muse Spark 1.3 Free');
    expect(light.models).not.toContain('OpenCode: Hunyuan 3.0 Free');
    expect(light.models).toContain('OpenCode: Ling 3.0 Flash Fin Free');
    // one backup + one save for both sub-syncs
    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(saveUserConfigSpy).toHaveBeenCalledTimes(1);
    expect(result.opCode.modelsJsonUpdated).toBe(true);
  });

  it('OpenCode failure never blocks the Gemini part', async () => {
    listAgyModelsMock.mockResolvedValue(AGY_3_6_TO_3_8);
    listOpenCodeModelsMock.mockRejectedValue(new Error('opencode models timed out'));

    const result = await runModelSync();

    expect(result.status).toBe('updated');
    expect(result.upgrades).toHaveLength(3);
    expect(result.opCode.status).toBe('error');
    expect(result.opCode.error).toContain('timed out');
    expect(saveUserConfigSpy).toHaveBeenCalledTimes(1); // Gemini result still saved
  });

  it('Gemini up-to-date + OpenCode has changes still goes through the full save path', async () => {
    // AGY_CURRENT matches every Gemini slot in OC_CONFIG → no Gemini upgrades

    const result = await runModelSync();

    expect(result.status).toBe('updated');
    expect(result.upgrades).toEqual([]);
    expect(result.opCode.status).toBe('updated');
    expect(saveUserConfigSpy).toHaveBeenCalledTimes(1);
    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(clearConfigCacheSpy).toHaveBeenCalled();
    expect(clearDefaultModelsCache).toHaveBeenCalled();
    expect(clearModelOrderCache).toHaveBeenCalled();
  });

  it('double up-to-date writes nothing to disk', async () => {
    const config = structuredClone(OC_CONFIG);
    // Align every slot with the local state: muse at 1.3, hy3 removed, both new models added
    config.modelsConfig.tiers.find((t) => t.name === '轻量与免费')!.models = ['Gemini 3.7 Flash (Low)', 'OpenCode: Muse Spark 1.3 Free', 'OpenCode: MiMo V2.5 Free', 'OpenCode: Ling 3.0 Flash Fin Free', 'OpenCode: Nemotron 3 Ultra Free'];
    config.modelsConfig.routing = {
      'OpenCode: Muse Spark 1.3 Free': 'opencode/muse-spark-1.3-contributor-free',
      'OpenCode: MiMo V2.5 Free': 'opencode/mimo-v2.5-free',
      'OpenCode: Ling 3.0 Flash Fin Free': 'opencode/ling-3.0-flash-fin-free',
      'OpenCode: Nemotron 3 Ultra Free': 'opencode/nemotron-3-ultra-free',
      'OpenCode: Big Pickle': 'opencode/big-pickle',
      'OpenCode: GLM 4.7 Flash': 'zhipuai/glm-4.7-flash',
    };
    loadUserConfigSpy.mockReturnValue(config);

    const result = await runModelSync();

    expect(result.status).toBe('up-to-date');
    expect(result.opCode.status).toBe('up-to-date');
    expect(result.opCode.removals).toEqual([]);
    expect(result.opCode.upgrades).toEqual([]);
    expect(result.opCode.additions).toEqual([]);
    expect(saveUserConfigSpy).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('models.json without a routing segment keeps unmanaged OpenCode entries intact', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      tiers: [{ name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle', 'OpenCode: Muse Spark 1.2 Free'] }],
      descriptions: { 'OpenCode: Big Pickle': 'Big Pickle 全栈编程强模型' },
    }));

    const result = await runModelSync();

    expect(result.status).toBe('updated');
    // No routing segment → the OpenCode models.json transform is a conservative no-op
    expect(result.opCode.modelsJsonUpdated).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('src/config/models.json invariants (real file)', () => {
  it('flash/pro display names are consistent between tiers and defaultOrder', async () => {
    const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const raw = fsActual.readFileSync(new URL('../config/models.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as {
      tiers: { name: string; models: string[] }[];
      defaultOrder: string[];
    };
    const tierGemini = parsed.tiers.flatMap((t) => t.models).filter((m) => /^Gemini \d+\.\d+ (Flash|Pro)/.test(m));
    const orderGemini = parsed.defaultOrder.filter((m) => /^Gemini \d+\.\d+ (Flash|Pro)/.test(m));
    expect(new Set(tierGemini)).toEqual(new Set(orderGemini));
    // All Flash entries share one version; all Pro entries share one version
    const flashVersions = new Set(tierGemini.filter((m) => m.includes('Flash')).map((m) => m.match(/\d+\.\d+/)![0]));
    const proVersions = new Set(tierGemini.filter((m) => m.startsWith('Gemini') && m.includes('Pro')).map((m) => m.match(/\d+\.\d+/)![0]));
    expect(flashVersions.size).toBe(1);
    expect(proVersions.size).toBe(1);
  });
});
