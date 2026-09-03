/**
 * @file modelSyncOpenCode.test.ts
 * @description Tests for the OpenCode sync plan: series matching, the
 * five-branch per-entry decision, tier+routing atomic application, and the
 * models.json transform's safety rules.
 */

import { describe, it, expect } from 'vitest';
import type { UserConfig } from '../config/userConfig.js';
import type { OpenCodeModelEntry } from '../agy/opencodeModels.js';
import {
  seriesKey,
  seriesVersion,
  displayNameFor,
  computeOpenCodePlan,
  isPlanEmpty,
  applyOpenCodePlan,
  applyOpenCodePlanToJson,
} from './modelSyncOpenCode.js';

function oc(...specs: Array<[id: string, name: string, active?: boolean]>): OpenCodeModelEntry[] {
  return specs.map(([id, name, active = true]) => ({
    id,
    name,
    active,
    free: id.split('/').pop()!.endsWith('-free') || id === 'opencode/big-pickle',
  }));
}

function makeConfig(entries: {
  routing?: Record<string, string>;
  tiers?: Array<{ name: string; priority: number; models: string[] }>;
  [key: string]: unknown;
}): UserConfig {
  return {
    telegramBotToken: 't',
    allowedUsers: [1],
    modelsConfig: {
      tiers: entries.tiers ?? [],
      routing: entries.routing ?? {},
    },
    ...entries,
  } as unknown as UserConfig;
}

// Local list snapshot mirroring the real opencode output (relevant subset).
const LOCAL = oc(
  ['opencode/big-pickle', 'Big Pickle'],
  ['opencode/muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Free'],
  ['opencode/muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Free'],
  ['opencode/mimo-v2.5-free', 'MiMo V2.5 Free'],
  ['opencode/ling-3.0-flash-fin-free', 'Ling 3.0 Flash Fin Free'],
  ['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free'],
);

const REAL_CONFIG = makeConfig({
  routing: {
    'OpenCode: Muse Spark 1.2 Free': 'opencode/muse-spark-1.2-contributor-free',
    'OpenCode: Hunyuan 3.0 Free': 'opencode/hy3-free',
    'OpenCode: MiMo V2.5 Free': 'opencode/mimo-v2.5-free',
    'OpenCode: Big Pickle': 'opencode/big-pickle',
    'OpenCode: OpenRouter Free': 'openrouter/openrouter/free',
    'OpenCode: GLM 4.7 Flash': 'zhipuai/glm-4.7-flash',
    'OpenCode: Qwen 3.6 35B A3B': 'hetzner/Qwen/Qwen3.6-35B-A3B-FP8',
  },
  tiers: [
    { name: '轻量与免费', priority: 3, models: ['OpenCode: Muse Spark 1.2 Free', 'OpenCode: Hunyuan 3.0 Free', 'OpenCode: MiMo V2.5 Free'] },
    { name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle', 'OpenCode: GLM 4.7 Flash', 'OpenCode: Qwen 3.6 35B A3B', 'OpenCode: OpenRouter Free'] },
  ],
});

describe('seriesKey / seriesVersion', () => {
  it('replaces version segments with X and extracts the version tuple', () => {
    expect(seriesKey('opencode/muse-spark-1.2-contributor-free')).toBe('muse-spark-X-contributor-free');
    expect(seriesVersion('opencode/muse-spark-1.2-contributor-free')).toEqual([1, 2]);
    expect(seriesKey('opencode/muse-spark-1.3-contributor-free')).toBe('muse-spark-X-contributor-free');
  });

  it('never cross-matches free and non-free siblings', () => {
    expect(seriesKey('opencode/muse-spark-1.2')).toBe('muse-spark-X');
    expect(seriesKey('opencode/muse-spark-1.2-contributor-free')).not.toBe(seriesKey('opencode/muse-spark-1.2'));
  });

  it('returns null version for ids without a version segment', () => {
    expect(seriesKey('opencode/hy3-free')).toBe('hy3-free');
    expect(seriesVersion('opencode/hy3-free')).toBeNull();
    expect(seriesKey('opencode/big-pickle')).toBe('big-pickle');
    expect(seriesVersion('opencode/big-pickle')).toBeNull();
  });

  it('handles multi-segment provider ids (only the opencode/ prefix is stripped)', () => {
    // openrouter/ ids are never processed by the sync, but seriesKey must not
    // blow up on them — the slash simply survives as part of the key
    expect(seriesKey('openrouter/openrouter/free')).toBe('openrouter/openrouter/free');
    expect(seriesVersion('openrouter/openrouter/free')).toBeNull();
  });

  it('accepts v-prefixed versions', () => {
    expect(seriesKey('opencode/mimo-v2.5-free')).toBe('mimo-X-free');
    expect(seriesVersion('opencode/mimo-v2.5-free')).toEqual([2, 5]);
  });
});

describe('computeOpenCodePlan — five branches', () => {
  it('real-world snapshot: remove hy3, upgrade muse 1.2→1.3, add 2 new free models', () => {
    const plan = computeOpenCodePlan(REAL_CONFIG, LOCAL);
    expect(plan.removals).toEqual([
      { display: 'OpenCode: Hunyuan 3.0 Free', routingId: 'opencode/hy3-free', tierName: '轻量与免费' },
    ]);
    expect(plan.upgrades).toEqual([
      {
        display: 'OpenCode: Muse Spark 1.2 Free',
        routingId: 'opencode/muse-spark-1.2-contributor-free',
        newDisplay: 'OpenCode: Muse Spark 1.3 Free',
        newRoutingId: 'opencode/muse-spark-1.3-contributor-free',
      },
    ]);
    // ling + nemotron are new; the upgrade target (muse 1.3) must NOT be double-counted
    expect(plan.additions.map((a) => a.routingId).sort()).toEqual([
      'opencode/ling-3.0-flash-fin-free',
      'opencode/nemotron-3-ultra-free',
    ]);
    expect(plan.additions.every((a) => a.tierName === '轻量与免费')).toBe(true);
  });

  it('keeps current entries untouched (never downgrade)', () => {
    const config = makeConfig({
      routing: { 'OpenCode: Big Pickle': 'opencode/big-pickle' },
      tiers: [{ name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle'] }],
    });
    const plan = computeOpenCodePlan(config, LOCAL);
    expect(isPlanEmpty(plan)).toBe(true);
  });

  it('replaces a dead entry with an older live sibling instead of removing it', () => {
    // Only 1.2 remains live; config references the (dead) 1.3 → replace down to 1.2
    const local = oc(
      ['opencode/muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Free'],
      ['opencode/muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Free', false],
    );
    const config = makeConfig({
      routing: { 'OpenCode: Muse Spark 1.3 Free': 'opencode/muse-spark-1.3-contributor-free' },
      tiers: [{ name: '轻量与免费', priority: 3, models: ['OpenCode: Muse Spark 1.3 Free'] }],
    });
    const plan = computeOpenCodePlan(config, local);
    expect(plan.removals).toEqual([]);
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]).toMatchObject({
      routingId: 'opencode/muse-spark-1.3-contributor-free',
      newRoutingId: 'opencode/muse-spark-1.2-contributor-free',
      newDisplay: 'OpenCode: Muse Spark 1.2 Free',
    });
  });

  it('picks the highest version among multiple live siblings', () => {
    const local = oc(
      ['opencode/muse-spark-1.1-contributor-free', 'Muse Spark 1.1 Free'],
      ['opencode/muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Free'],
      ['opencode/muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Free'],
    );
    const config = makeConfig({
      routing: { 'OpenCode: Muse Spark 1.1 Free': 'opencode/muse-spark-1.1-contributor-free' },
      tiers: [{ name: '轻量与免费', priority: 3, models: ['OpenCode: Muse Spark 1.1 Free'] }],
    });
    const plan = computeOpenCodePlan(config, local);
    expect(plan.upgrades[0]?.newRoutingId).toBe('opencode/muse-spark-1.3-contributor-free');
  });

  it('skips non-opencode/ routing ids entirely', () => {
    const plan = computeOpenCodePlan(REAL_CONFIG, LOCAL);
    const all = [...plan.removals, ...plan.upgrades];
    expect(all.every((x) => x.routingId.startsWith('opencode/'))).toBe(true);
    // OpenRouter / GLM / Qwen entries appear in neither removals nor upgrades
    expect(all.map((x) => x.display)).not.toContain('OpenCode: GLM 4.7 Flash');
  });

  it('skips additions that collide with an existing routing display name', () => {
    // A new free model whose generated display collides with a routed non-opencode entry
    const config = structuredClone(REAL_CONFIG) as UserConfig;
    config.modelsConfig!.routing!['OpenCode: Ling 3.0 Flash Fin Free'] = 'zhipuai/ling-3.0-flash-fin';
    const plan = computeOpenCodePlan(config, LOCAL);
    // ling collides → dropped; nemotron still collected
    expect(plan.additions.map((a) => a.routingId)).toEqual(['opencode/nemotron-3-ultra-free']);
    expect(plan.skippedAdditions).toBe(0); // collision is dropped silently, not counted as skipped
  });

  it('counts skippedAdditions when the lightweight tier is missing', () => {
    const config = structuredClone(REAL_CONFIG) as UserConfig;
    config.modelsConfig!.tiers = config.modelsConfig!.tiers!.map((t) =>
      t.name === '轻量与免费' ? { ...t, name: '改名了' } : t,
    );
    const plan = computeOpenCodePlan(config, LOCAL);
    expect(plan.additions).toHaveLength(0);
    expect(plan.skippedAdditions).toBe(2); // ling + nemotron have nowhere to go
  });

  it('ignores inactive models for additions', () => {
    const local = oc(['opencode/ling-3.0-flash-fin-free', 'Ling 3.0 Flash Fin Free', false]);
    const plan = computeOpenCodePlan(REAL_CONFIG, local);
    expect(plan.additions.map((a) => a.routingId)).not.toContain('opencode/ling-3.0-flash-fin-free');
  });
});

describe('applyOpenCodePlan — atomic tiers+routing', () => {
  it('mutates routing and tiers together for removals, upgrades, and additions', () => {
    const config = structuredClone(REAL_CONFIG) as UserConfig;
    const plan = computeOpenCodePlan(config, LOCAL);
    const touched = applyOpenCodePlan(config, plan);

    const routing = config.modelsConfig!.routing!;
    // removal: key gone
    expect(routing['OpenCode: Hunyuan 3.0 Free']).toBeUndefined();
    // upgrade: key renamed with new routing id
    expect(routing['OpenCode: Muse Spark 1.2 Free']).toBeUndefined();
    expect(routing['OpenCode: Muse Spark 1.3 Free']).toBe('opencode/muse-spark-1.3-contributor-free');
    // additions: key present
    expect(routing['OpenCode: Ling 3.0 Flash Fin Free']).toBe('opencode/ling-3.0-flash-fin-free');
    expect(routing['OpenCode: Nemotron 3 Ultra Free']).toBe('opencode/nemotron-3-ultra-free');
    // non-opencode routes untouched
    expect(routing['OpenCode: GLM 4.7 Flash']).toBe('zhipuai/glm-4.7-flash');

    const light = config.modelsConfig!.tiers![0]!;
    expect(light.models).toEqual([
      'OpenCode: Muse Spark 1.3 Free', // upgraded in place
      // Hunyuan removed
      'OpenCode: MiMo V2.5 Free',
      'OpenCode: Ling 3.0 Flash Fin Free', // appended
      'OpenCode: Nemotron 3 Ultra Free',
    ]);
    const pickleTier = config.modelsConfig!.tiers![1]!;
    expect(pickleTier.models).toContain('OpenCode: Big Pickle'); // untouched

    expect(touched).toContain('路由表 (routing)');
    expect(touched).toContain('层级「轻量与免费」');
    expect(touched).not.toContain('层级「全栈编程」');
  });

  it('never leaves a tier entry without a routing key (isOpenCodeModel invariant)', () => {
    const config = structuredClone(REAL_CONFIG) as UserConfig;
    const plan = computeOpenCodePlan(config, LOCAL);
    applyOpenCodePlan(config, plan);
    const routing = config.modelsConfig!.routing!;
    for (const tier of config.modelsConfig!.tiers!) {
      for (const m of tier.models) {
        if (m.startsWith('OpenCode: ')) {
          expect(routing[m], `tier entry ${m} must have a routing key`).toBeDefined();
        }
      }
    }
  });

  it('removes a dead model from single-value slots (model / taskModel / summarization.model)', () => {
    const config = makeConfig({
      model: 'OpenCode: Hunyuan 3.0 Free',
      defaultModels: {
        taskModel: 'OpenCode: Muse Spark 1.2 Free',
        inlineSuggestions: ['OpenCode: Hunyuan 3.0 Free'],
        compareGroup: ['OpenCode: Big Pickle'],
      },
      summarization: { model: 'OpenCode: Hunyuan 3.0 Free' },
      routing: structuredClone(REAL_CONFIG.modelsConfig!.routing!),
      tiers: structuredClone(REAL_CONFIG.modelsConfig!.tiers!),
      orderedModels: ['OpenCode: Hunyuan 3.0 Free', 'OpenCode: Big Pickle'],
    });
    const plan = computeOpenCodePlan(config, LOCAL);
    const touched = applyOpenCodePlan(config, plan);

    expect(config.model).toBeUndefined();
    expect(config.defaultModels!.taskModel).toBe('OpenCode: Muse Spark 1.3 Free'); // upgraded
    expect(config.summarization!.model).toBeUndefined();
    expect(config.orderedModels).toEqual(['OpenCode: Big Pickle']);
    expect(config.defaultModels!.inlineSuggestions).toEqual([]);
    expect(touched).toContain('默认模型 (model)');
    expect(touched).toContain('任务模型 (taskModel)');
    expect(touched).toContain('摘要模型 (summarization.model)');
    expect(touched).toContain('自定义排序 (orderedModels)');
    expect(touched).toContain('inline 建议 (inlineSuggestions)');
  });
});

describe('applyOpenCodePlanToJson — models.json safety rules', () => {
  const REAL_MODELS_JSON = {
    tiers: [
      { name: '轻量与免费', priority: 3, models: ['OpenCode: Muse Spark 1.2 Free', 'OpenCode: Hunyuan 3.0 Free', 'OpenCode: MiMo V2.5 Free'] },
      { name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle', 'OpenCode: GLM 4.7 Flash', 'OpenCode: Qwen 3.6 35B A3B', 'OpenCode: OpenRouter Free'] },
    ],
    defaultOrder: ['OpenCode: Muse Spark 1.2 Free', 'OpenCode: Big Pickle', 'OpenCode: Hunyuan 3.0 Free'],
    routing: {
      'OpenCode: Muse Spark 1.2 Free': 'opencode/muse-spark-1.2-contributor-free',
      'OpenCode: Hunyuan 3.0 Free': 'opencode/hy3-free',
      'OpenCode: MiMo V2.5 Free': 'opencode/mimo-v2.5-free',
      'OpenCode: Big Pickle': 'opencode/big-pickle',
      'OpenCode: OpenRouter Free': 'openrouter/openrouter/free',
    },
    descriptions: {
      'OpenCode: Muse Spark 1.2 Free': 'muse desc',
      'OpenCode: Hunyuan 3.0 Free': 'hunyuan desc',
      'OpenCode: Big Pickle': 'pickle desc',
      'OpenCode: OpenRouter Free': 'or desc',
    },
  };

  function planFrom(routingJson: Record<string, string>): ReturnType<typeof computeOpenCodePlan> {
    const config = makeConfig({ routing: routingJson, tiers: REAL_CONFIG.modelsConfig!.tiers! });
    return computeOpenCodePlan(config, LOCAL);
  }

  it('applies the full plan: routing + tiers + defaultOrder + descriptions', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    const plan = planFrom(REAL_MODELS_JSON.routing);
    const changed = applyOpenCodePlanToJson(parsed, plan);

    expect(changed).toBe(true);
    expect(parsed.routing!['OpenCode: Hunyuan 3.0 Free']).toBeUndefined();
    expect(parsed.routing!['OpenCode: Muse Spark 1.2 Free']).toBeUndefined();
    expect(parsed.routing!['OpenCode: Muse Spark 1.3 Free']).toBe('opencode/muse-spark-1.3-contributor-free');
    expect(parsed.routing!['OpenCode: Ling 3.0 Flash Fin Free']).toBe('opencode/ling-3.0-flash-fin-free');
    expect(parsed.routing!['OpenCode: OpenRouter Free']).toBe('openrouter/openrouter/free'); // untouched

    expect(parsed.tiers![0]!.models).toEqual([
      'OpenCode: Muse Spark 1.3 Free',
      'OpenCode: MiMo V2.5 Free',
      'OpenCode: Ling 3.0 Flash Fin Free',
      'OpenCode: Nemotron 3 Ultra Free',
    ]);
    expect(parsed.tiers![1]!.models).toContain('OpenCode: Big Pickle');
    expect(parsed.defaultOrder).toEqual(['OpenCode: Muse Spark 1.3 Free', 'OpenCode: Big Pickle']);

    expect(parsed.descriptions!['OpenCode: Muse Spark 1.2 Free']).toBeUndefined();
    expect(parsed.descriptions!['OpenCode: Muse Spark 1.3 Free']).toBe('muse desc'); // description carried over
    expect(parsed.descriptions!['OpenCode: Hunyuan 3.0 Free']).toBeUndefined(); // dropped
    expect(parsed.descriptions!['OpenCode: Ling 3.0 Flash Fin Free']).toContain('自动收录'); // placeholder
    expect(parsed.descriptions!['OpenCode: Big Pickle']).toBe('pickle desc');
  });

  it('is a no-op on a models.json without a routing segment', () => {
    const parsed = {
      tiers: [{ name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle', 'OpenCode: Hunyuan 3.0 Free'] }],
      descriptions: { 'OpenCode: Big Pickle': 'pickle desc' },
    };
    const plan = planFrom(REAL_MODELS_JSON.routing);
    const changed = applyOpenCodePlanToJson(parsed, plan);
    expect(changed).toBe(false);
    expect(parsed.tiers![0]!.models).toEqual(['OpenCode: Big Pickle', 'OpenCode: Hunyuan 3.0 Free']);
  });

  it('leaves entries not present in its own routing untouched', () => {
    // models.json routes Big Pickle but NOT muse/hunyuan/mimo — only additions apply
    const parsed = {
      tiers: [{ name: '全栈编程', priority: 1, models: ['OpenCode: Big Pickle', 'OpenCode: Muse Spark 1.2 Free'] }],
      routing: { 'OpenCode: Big Pickle': 'opencode/big-pickle' },
    };
    const plan = planFrom(REAL_MODELS_JSON.routing);
    const changed = applyOpenCodePlanToJson(parsed, plan);

    expect(changed).toBe(true); // additions to routing + lightweight tier
    expect(parsed.tiers![0]!.models).toEqual(['OpenCode: Big Pickle', 'OpenCode: Muse Spark 1.2 Free']); // unmanaged → untouched
    expect(parsed.routing!['OpenCode: Big Pickle']).toBe('opencode/big-pickle');
    expect(parsed.routing!['OpenCode: Ling 3.0 Flash Fin Free']).toBe('opencode/ling-3.0-flash-fin-free');
  });

  it('returns false for an empty plan', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    const changed = applyOpenCodePlanToJson(parsed, { removals: [], upgrades: [], additions: [], skippedAdditions: 0 });
    expect(changed).toBe(false);
  });
});

describe('displayNameFor', () => {
  it('prefixes the official name with the channel label', () => {
    expect(displayNameFor({ name: 'Big Pickle' })).toBe('OpenCode: Big Pickle');
    expect(displayNameFor({ name: 'Muse Spark 1.3 Free' })).toBe('OpenCode: Muse Spark 1.3 Free');
  });
});
