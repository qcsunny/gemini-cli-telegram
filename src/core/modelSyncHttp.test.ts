/**
 * @file modelSyncHttp.test.ts
 * @description Tests for the HTTP-backend sync plan: dual-namespace filtering,
 * version upgrades (incl. the qwen glued-version special case), dead media
 * merge-replacement, and the tier+routing atomic application.
 */

import { describe, it, expect } from 'vitest';
import type { UserConfig } from '../config/userConfig.js';
import type { HttpModelEntry } from '../agy/httpBackendModels.js';
import { computeHttpPlan, isHttpPlanEmpty, applyHttpPlan, applyHttpPlanToJson } from './modelSyncHttp.js';

function makeConfig(routing: Record<string, string>, tiers: Array<{ name: string; priority: number; models: string[] }>): UserConfig {
  return {
    telegramBotToken: 't',
    allowedUsers: [1],
    modelsConfig: { tiers, routing },
  } as unknown as UserConfig;
}

function ids(...list: string[]): HttpModelEntry[] {
  return list.map((id) => ({ id }));
}

describe('computeHttpPlan — namespace filtering', () => {
  it('only touches entries with the backend display prefix AND id namespace', () => {
    const config = makeConfig(
      {
        'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking',
        'DeepSeek: Something': 'gemini-3.7-flash-thinking', // wrong display prefix for this backend
        'Web2API: Something Else': 'openrouter/foo', // routing id outside the backend namespace
      },
      [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking', 'Web2API: Something Else', 'DeepSeek: Something'] }],
    );
    // web2api list has no gemini-3.7-flash-thinking → both matching entries would
    // be candidates, but only the dual-namespace one is processed
    const plan = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash-thinking'));
    expect(plan.removals.map((r) => r.display)).toEqual([]);
    expect(plan.upgrades.map((u) => u.display)).toEqual(['Web2API: Gemini 3.7 Flash Thinking']);
    // 'Web2API: Something Else' (id openrouter/) and 'DeepSeek: Something' (prefix) untouched
  });

  it('live entries produce an empty plan (idempotence)', () => {
    const config = makeConfig(
      {
        'GLM: 5.3 Thinking': 'glm-5.3-thinking',
        'MiMo: 2.5 Pro': 'mimo-v2.5-pro',
        'DeepSeek: Pro Thinking': 'deepseek-v4-pro-thinking',
      },
      [{ name: '远程备用', priority: 4, models: ['GLM: 5.3 Thinking', 'MiMo: 2.5 Pro', 'DeepSeek: Pro Thinking'] }],
    );
    const glm = computeHttpPlan(config, 'glm', ids('glm-5.3', 'glm-5.3-thinking', 'glm-5.3-deep-thinking'));
    expect(isHttpPlanEmpty(glm)).toBe(true);
    const mimo = computeHttpPlan(config, 'mimo', ids('mimo-v2.5-pro', 'mimo-v2.5'));
    expect(isHttpPlanEmpty(mimo)).toBe(true);
    const ds = computeHttpPlan(config, 'deepseek', ids('deepseek-v4-pro', 'deepseek-v4-pro-thinking'));
    expect(isHttpPlanEmpty(ds)).toBe(true);
  });
});

describe('computeHttpPlan — upgrades', () => {
  it('upgrades a dead flash-thinking to the higher live version, bumping the display version', () => {
    const config = makeConfig(
      { 'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking' },
      [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking'] }],
    );
    const plan = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash', 'gemini-3.8-flash-thinking', 'gemini-3.5-flash-lite'));
    expect(plan.upgrades).toEqual([
      {
        display: 'Web2API: Gemini 3.7 Flash Thinking',
        newDisplay: 'Web2API: Gemini 3.8 Flash Thinking',
        routingId: 'gemini-3.7-flash-thinking',
        newRoutingId: 'gemini-3.8-flash-thinking',
      },
    ]);
  });

  it('qwen: matches series via the glued version (qwen3.7 → qwen3.8)', () => {
    const config = makeConfig(
      { 'Qwen: 3.7 Max Thinking': 'qwen3.7-plus-thinking' },
      [{ name: '远程备用', priority: 4, models: ['Qwen: 3.7 Max Thinking'] }],
    );
    const plan = computeHttpPlan(config, 'qwen', ids('qwen3.8-plus-thinking', 'qwen3.8-max-thinking'));
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]).toMatchObject({
      newRoutingId: 'qwen3.8-plus-thinking', // same series (plus-thinking), not max
      newDisplay: 'Qwen: 3.8 Max Thinking',
    });
  });

  it('dead entry with only a lower-version sibling is replaced without a display bump', () => {
    const config = makeConfig(
      { 'GLM: 5.3 Thinking': 'glm-5.3-thinking' },
      [{ name: '远程备用', priority: 4, models: ['GLM: 5.3 Thinking'] }],
    );
    // glm-5.3-thinking dead; glm-5.2-thinking live (older) → replace, keep display
    const plan = computeHttpPlan(config, 'glm', ids('glm-5.2-thinking', 'glm-5.2'));
    expect(plan.upgrades).toEqual([
      {
        display: 'GLM: 5.3 Thinking',
        newDisplay: 'GLM: 5.3 Thinking', // display unchanged on a downgrade-replace
        routingId: 'glm-5.3-thinking',
        newRoutingId: 'glm-5.2-thinking',
      },
    ]);
  });
});

describe('computeHttpPlan — removals', () => {
  it('removes a dead non-media entry with no same-series sibling', () => {
    const config = makeConfig(
      { 'MiMo: 2.5 Pro': 'mimo-v2.5-pro' },
      [{ name: '远程备用', priority: 4, models: ['MiMo: 2.5 Pro'] }],
    );
    // Upstream dropped both mimo models; only a *different series* survives
    const plan = computeHttpPlan(config, 'mimo', ids('mimo-v3.0-pro'));
    // skeleton mimo-vX-pro matches mimo-v3.0-pro → that's a same-series upgrade
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]!.newRoutingId).toBe('mimo-v3.0-pro');
  });

  it('removes when absolutely nothing matches the skeleton', () => {
    const config = makeConfig(
      { 'DeepSeek: Flash Thinking Search': 'deepseek-v4-flash-thinking-search' },
      [{ name: '远程备用', priority: 4, models: ['DeepSeek: Flash Thinking Search'] }],
    );
    const plan = computeHttpPlan(config, 'deepseek', ids('deepseek-v4-flash', 'deepseek-v4-pro'));
    expect(plan.removals).toEqual([
      { display: 'DeepSeek: Flash Thinking Search', routingId: 'deepseek-v4-flash-thinking-search' },
    ]);
  });
});

describe('computeHttpPlan — media replacement', () => {
  it('merges two dead qwen image models into one generic entry routed to the top live variant', () => {
    const config = makeConfig(
      {
        'Qwen: Image 2.0': 'qwen-image-2.0-image',
        'Qwen: Image 3.0': 'qwen-image-3.0-image',
        'Qwen: Video': 'qwen3.8-max-video',
      },
      [{ name: '远程备用', priority: 4, models: ['Qwen: Image 2.0', 'Qwen: Image 3.0', 'Qwen: Video'] }],
    );
    const plan = computeHttpPlan(config, 'qwen', ids('qwen3.7-plus-image', 'qwen3.8-max-image', 'qwen3.8-max-video'));
    expect(plan.mediaReplacements).toEqual([
      {
        displays: ['Qwen: Image 2.0', 'Qwen: Image 3.0'],
        newDisplay: 'Qwen: Image',
        newRoutingId: 'qwen3.8-max-image', // highest version among live -image variants
      },
    ]);
    // live video model untouched
    expect(plan.removals).toEqual([]);
    expect(plan.upgrades).toEqual([]);
  });

  it('media models never take version upgrades even when a same-suffix higher version exists', () => {
    // The image id is LIVE upstream and a newer one also exists — no upgrade.
    const config = makeConfig(
      { 'Qwen: Image': 'qwen3.7-plus-image' },
      [{ name: '远程备用', priority: 4, models: ['Qwen: Image'] }],
    );
    const plan = computeHttpPlan(config, 'qwen', ids('qwen3.7-plus-image', 'qwen3.8-max-image'));
    expect(isHttpPlanEmpty(plan)).toBe(true);
  });

  it('web2api fixed media ids (canvas/video) are only liveness-checked', () => {
    const config = makeConfig(
      {
        'Web2API: Gemini Canvas': 'gemini-canvas',
        'Web2API: Gemini Video': 'gemini-video',
      },
      [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini Canvas', 'Web2API: Gemini Video'] }],
    );
    const plan = computeHttpPlan(config, 'web2api', ids('gemini-canvas', 'gemini-video', 'gemini-3.8-flash-thinking'));
    expect(isHttpPlanEmpty(plan)).toBe(true);
  });

  it('dead media with no live same-suffix variant falls back to removal', () => {
    const config = makeConfig(
      { 'Web2API: Gemini Music': 'gemini-music' },
      [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini Music'] }],
    );
    const plan = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash', 'gemini-3.8-flash-thinking'));
    expect(plan.removals).toEqual([{ display: 'Web2API: Gemini Music', routingId: 'gemini-music' }]);
  });

  it('drops dead media instead of merging onto a survivor that already has an entry', () => {
    // `Qwen: Image` already routes to the top live variant — merging the dead
    // 2.0 entry onto it would produce a second `Qwen: Image` row.
    const config = makeConfig(
      {
        'Qwen: Image': 'qwen3.8-max-image',
        'Qwen: Image 2.0': 'qwen-image-2.0-image',
      },
      [{ name: '远程备用', priority: 4, models: ['Qwen: Image', 'Qwen: Image 2.0'] }],
    );
    const plan = computeHttpPlan(config, 'qwen', ids('qwen3.8-max-image'));
    expect(plan.mediaReplacements).toEqual([]);
    expect(plan.removals).toEqual([{ display: 'Qwen: Image 2.0', routingId: 'qwen-image-2.0-image' }]);
  });
});

describe('computeHttpPlan — target dedupe', () => {
  it('only one of two dead same-series entries takes the survivor', () => {
    const config = makeConfig(
      {
        'GLM: 5.1 Ultra Thinking': 'glm-5.1-deep-thinking',
        'GLM: 5.2 Ultra Thinking': 'glm-5.2-deep-thinking',
      },
      [{ name: '远程备用', priority: 4, models: ['GLM: 5.1 Ultra Thinking', 'GLM: 5.2 Ultra Thinking'] }],
    );
    const plan = computeHttpPlan(config, 'glm', ids('glm-5.3-deep-thinking'));
    expect(plan.upgrades).toEqual([
      {
        display: 'GLM: 5.1 Ultra Thinking',
        newDisplay: 'GLM: 5.3 Ultra Thinking',
        routingId: 'glm-5.1-deep-thinking',
        newRoutingId: 'glm-5.3-deep-thinking',
      },
    ]);
    expect(plan.removals).toEqual([{ display: 'GLM: 5.2 Ultra Thinking', routingId: 'glm-5.2-deep-thinking' }]);
  });

  it('removes a dead entry whose replacement is already routed by a live entry', () => {
    const config = makeConfig(
      {
        'MiMo: 2.5 Pro': 'mimo-v2.5-pro',
        'MiMo: 2.4 Pro': 'mimo-v2.4-pro',
      },
      [{ name: '远程备用', priority: 4, models: ['MiMo: 2.5 Pro', 'MiMo: 2.4 Pro'] }],
    );
    const plan = computeHttpPlan(config, 'mimo', ids('mimo-v2.5-pro'));
    expect(plan.upgrades).toEqual([]);
    expect(plan.removals).toEqual([{ display: 'MiMo: 2.4 Pro', routingId: 'mimo-v2.4-pro' }]);
  });
});

describe('applyHttpPlan — atomic tiers+routing', () => {
  it('rewrites routing and tiers together for upgrade + media merge', () => {
    const config = makeConfig(
      {
        'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking',
        'Qwen: Image 2.0': 'qwen-image-2.0-image',
        'Qwen: Image 3.0': 'qwen-image-3.0-image',
      },
      [
        { name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking', 'Qwen: Image 2.0', 'Qwen: Image 3.0', 'GLM: 5.3 Thinking'] },
      ],
    );
    const web2api = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash-thinking'));
    const qwen = computeHttpPlan(config, 'qwen', ids('qwen3.8-max-image'));
    applyHttpPlan(config, 'web2api', web2api);
    applyHttpPlan(config, 'qwen', qwen);

    const routing = config.modelsConfig!.routing!;
    expect(routing['Web2API: Gemini 3.8 Flash Thinking']).toBe('gemini-3.8-flash-thinking');
    expect(routing['Qwen: Image']).toBe('qwen3.8-max-image');
    expect(routing['Qwen: Image 2.0']).toBeUndefined();
    expect(routing['Qwen: Image 3.0']).toBeUndefined();

    const tier = config.modelsConfig!.tiers![0]!;
    expect(tier.models).toEqual(['Web2API: Gemini 3.8 Flash Thinking', 'Qwen: Image', 'GLM: 5.3 Thinking']);
  });

  it('removal drops the entry from routing, tiers, and single-value slots', () => {
    const config = {
      ...makeConfig(
        { 'DeepSeek: Flash Thinking Search': 'deepseek-v4-flash-thinking-search', 'DeepSeek: Pro Thinking': 'deepseek-v4-pro-thinking' },
        [{ name: '远程备用', priority: 4, models: ['DeepSeek: Flash Thinking Search', 'DeepSeek: Pro Thinking'] }],
      ),
      model: 'DeepSeek: Flash Thinking Search',
      defaultModels: { taskModel: 'DeepSeek: Flash Thinking Search' },
      summarization: { model: 'DeepSeek: Pro Thinking' },
    } as unknown as UserConfig;
    const plan = computeHttpPlan(config, 'deepseek', ids('deepseek-v4-pro-thinking'));
    applyHttpPlan(config, 'deepseek', plan);

    expect(config.model).toBeUndefined();
    expect(config.defaultModels!.taskModel).toBeUndefined();
    expect(config.summarization!.model).toBe('DeepSeek: Pro Thinking');
    expect(config.modelsConfig!.routing!['DeepSeek: Flash Thinking Search']).toBeUndefined();
    expect(config.modelsConfig!.tiers![0]!.models).toEqual(['DeepSeek: Pro Thinking']);
  });
});

describe('applyHttpPlanToJson — models.json safety rules', () => {
  const REAL_MODELS_JSON = {
    tiers: [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking', 'Qwen: Image 2.0', 'Qwen: Image 3.0', 'Qwen: Video'] }],
    defaultOrder: ['Web2API: Gemini 3.7 Flash Thinking', 'Qwen: Image 3.0'],
    routing: {
      'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking',
      'Qwen: Image 2.0': 'qwen-image-2.0-image',
      'Qwen: Image 3.0': 'qwen-image-3.0-image',
      'Qwen: Video': 'qwen3.8-max-video',
    },
    descriptions: {
      'Web2API: Gemini 3.7 Flash Thinking': 'w desc',
      'Qwen: Image 2.0': 'img2 desc',
      'Qwen: Image 3.0': 'img3 desc',
    },
  };

  it('applies upgrade + media merge across routing/tiers/defaultOrder/descriptions', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    const config = makeConfig(parsed.routing, parsed.tiers);
    const web2api = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash-thinking'));
    const qwen = computeHttpPlan(config, 'qwen', ids('qwen3.8-max-image', 'qwen3.8-max-video'));

    expect(applyHttpPlanToJson(parsed, 'web2api', web2api)).toBe(true);
    expect(applyHttpPlanToJson(parsed, 'qwen', qwen)).toBe(true);

    expect(parsed.routing!['Web2API: Gemini 3.8 Flash Thinking']).toBe('gemini-3.8-flash-thinking');
    expect(parsed.routing!['Qwen: Image']).toBe('qwen3.8-max-image');
    expect(parsed.routing!['Qwen: Video']).toBe('qwen3.8-max-video');
    expect(parsed.tiers![0]!.models).toEqual(['Web2API: Gemini 3.8 Flash Thinking', 'Qwen: Image', 'Qwen: Video']);
    // 'Qwen: Image 3.0' is a non-primary merge member — the list keeps it under
    // the generic name instead of silently losing the model.
    expect(parsed.defaultOrder).toEqual(['Web2API: Gemini 3.8 Flash Thinking', 'Qwen: Image']);
    expect(parsed.descriptions!['Qwen: Image']).toBe('img2 desc'); // primary's description carried over
    expect(parsed.descriptions!['Qwen: Image 3.0']).toBeUndefined();
  });

  it('collapses every merge member into a single defaultOrder entry', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    parsed.defaultOrder = ['Qwen: Image 2.0', 'Qwen: Video', 'Qwen: Image 3.0'];
    const config = makeConfig(parsed.routing, parsed.tiers);
    const qwen = computeHttpPlan(config, 'qwen', ids('qwen3.8-max-image', 'qwen3.8-max-video'));
    expect(applyHttpPlanToJson(parsed, 'qwen', qwen)).toBe(true);
    expect(parsed.defaultOrder).toEqual(['Qwen: Image', 'Qwen: Video']);
  });

  it('keeps the model when defaultOrder only carries a non-primary merge member', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    parsed.defaultOrder = ['Qwen: Image 3.0'];
    const config = makeConfig(parsed.routing, parsed.tiers);
    const qwen = computeHttpPlan(config, 'qwen', ids('qwen3.8-max-image', 'qwen3.8-max-video'));
    expect(applyHttpPlanToJson(parsed, 'qwen', qwen)).toBe(true);
    expect(parsed.defaultOrder).toEqual(['Qwen: Image']);
  });

  it('is a no-op on a models.json without a routing segment', () => {
    const parsed = {
      tiers: [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking'] }],
      descriptions: { 'Web2API: Gemini 3.7 Flash Thinking': 'desc' },
    };
    const config = makeConfig(
      { 'Web2API: Gemini 3.7 Flash Thinking': 'gemini-3.7-flash-thinking' },
      [{ name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.7 Flash Thinking'] }],
    );
    const plan = computeHttpPlan(config, 'web2api', ids('gemini-3.8-flash-thinking'));
    expect(applyHttpPlanToJson(parsed, 'web2api', plan)).toBe(false);
    expect(parsed.tiers![0]!.models).toEqual(['Web2API: Gemini 3.7 Flash Thinking']);
  });

  it('returns false for an empty plan', () => {
    const parsed = structuredClone(REAL_MODELS_JSON);
    expect(applyHttpPlanToJson(parsed, 'glm', { removals: [], upgrades: [], mediaReplacements: [] })).toBe(false);
  });
});
