/**
 * @file modelSyncOpenCode.ts
 * @description OpenCode model sync for `/model sync`: keeps config.json's
 * `OpenCode:` entries aligned with the local `opencode models opencode` list.
 *
 * Three operations (user-confirmed rules):
 *   1. Removal — routing id no longer exists locally → drop from tiers + routing
 *   2. Upgrade — same series has a newer version → replace display + routing id
 *   3. Addition — new locally-available `-free` models → add to the 轻量与免费 tier
 *
 * Display names are generated from the official verbose JSON `name` field
 * (`OpenCode: ${name}`), matching the existing config naming convention.
 *
 * Invariant: tiers and routing are always mutated atomically together —
 * `isOpenCodeModel` requires BOTH the `OpenCode:` prefix and a routing key,
 * and a half-state would silently route the model to the agy fallback.
 */
import type { UserConfig } from '../config/userConfig.js';
import type { OpenCodeModelEntry } from '../agy/opencodeModels.js';

export interface OpenCodeRemoval {
  display: string;
  routingId: string;
  tierName: string;
}

export interface OpenCodeUpgrade {
  display: string;
  routingId: string;
  newDisplay: string;
  newRoutingId: string;
}

export interface OpenCodeAddition {
  display: string;
  routingId: string;
  tierName: string;
}

export interface OpenCodeSyncPlan {
  removals: OpenCodeRemoval[];
  upgrades: OpenCodeUpgrade[];
  additions: OpenCodeAddition[];
  /** Additions skipped because the target tier is missing or the name collides. */
  skippedAdditions: number;
}

export type OpenCodeSyncStatus = 'updated' | 'up-to-date' | 'error';

export interface OpenCodeSyncResult {
  status: OpenCodeSyncStatus;
  removals: OpenCodeRemoval[];
  upgrades: OpenCodeUpgrade[];
  additions: OpenCodeAddition[];
  appliedLocations: string[];
  modelsJsonUpdated: boolean;
  modelsJsonError?: string;
  /** opencode CLI failure message (status === 'error'). */
  error?: string;
}

const LIGHTWEIGHT_TIER_NAME = '轻量与免费';
const OPENCODE_PREFIX = 'OpenCode: ';
const OPENCODE_ID_PREFIX = 'opencode/';

/** Display name for an opencode model — official name with the channel prefix. */
export function displayNameFor(entry: Pick<OpenCodeModelEntry, 'name'>): string {
  return `${OPENCODE_PREFIX}${entry.name}`;
}

const VERSION_SEGMENT_RE = /^v?\d+(?:\.\d+)*$/;

/**
 * Series skeleton: version-like segments in the routing id (after the
 * `opencode/` prefix) are replaced with 'X'.
 *   muse-spark-1.2-contributor-free → muse-spark-X-contributor-free
 *   muse-spark-1.2                  → muse-spark-X            (different — free tier never cross-matches)
 *   hy3-free                        → hy3-free                (no version segment)
 */
export function seriesKey(routingId: string): string {
  const bare = routingId.startsWith(OPENCODE_ID_PREFIX) ? routingId.slice(OPENCODE_ID_PREFIX.length) : routingId;
  return bare
    .split('-')
    .map((seg) => (VERSION_SEGMENT_RE.test(seg) ? 'X' : seg))
    .join('-');
}

/**
 * Version tuple parsed from the version segments; null when the id has no
 * version-like segment (e.g. hy3-free).
 */
export function seriesVersion(routingId: string): number[] | null {
  const bare = routingId.startsWith(OPENCODE_ID_PREFIX) ? routingId.slice(OPENCODE_ID_PREFIX.length) : routingId;
  const parts: number[] = [];
  for (const seg of bare.split('-')) {
    if (!VERSION_SEGMENT_RE.test(seg)) continue;
    for (const piece of seg.replace(/^v/, '').split('.')) parts.push(Number(piece));
  }
  return parts.length > 0 ? parts : null;
}

function versionGt(a: number[], b: number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/** Collect all config.json slots (arrays + single values) holding OpenCode display names. */
function collectOpenCodeSlots(config: UserConfig): { display: string; tierName: string }[] {
  const slots: { display: string; tierName: string }[] = [];
  for (const tier of config.modelsConfig?.tiers ?? []) {
    for (const m of tier.models) {
      if (m.startsWith(OPENCODE_PREFIX)) slots.push({ display: m, tierName: tier.name });
    }
  }
  return slots;
}

/**
 * Compute the sync plan for all config entries whose routing id starts with
 * `opencode/`. Entries routed to other namespaces (zhipuai/, openrouter/,
 * hetzner/) are skipped entirely — they are not in this sync's scope.
 *
 * Per-entry decisions (cur = the entry's routing id):
 *   1. best (highest-version live same-skeleton) exists and best > cur        → upgrade
 *   2. best <= cur and cur is gone                                            → replace with best (better than removal)
 *   3. best <= cur and cur is live                                            → keep (never downgrade)
 *   4. no best and cur is live                                                → keep
 *   5. no best and cur is gone                                                → remove
 */
export function computeOpenCodePlan(config: UserConfig, available: OpenCodeModelEntry[]): OpenCodeSyncPlan {
  const plan: OpenCodeSyncPlan = { removals: [], upgrades: [], additions: [], skippedAdditions: 0 };
  const routing = config.modelsConfig?.routing;
  if (!routing) return plan;

  const liveIds = new Set(available.filter((e) => e.active).map((e) => e.id));
  const availableByKey = new Map<string, OpenCodeModelEntry[]>();
  for (const entry of available) {
    if (!entry.active) continue;
    const key = seriesKey(entry.id);
    const list = availableByKey.get(key) ?? [];
    list.push(entry);
    availableByKey.set(key, list);
  }

  const tierNameByDisplay = new Map(collectOpenCodeSlots(config).map((s) => [s.display, s.tierName] as const));

  for (const [display, routingId] of Object.entries(routing)) {
    if (!routingId.startsWith(OPENCODE_ID_PREFIX)) continue;
    const tierName = tierNameByDisplay.get(display) ?? '(不在任何层级)';

    const sameSeries = availableByKey.get(seriesKey(routingId)) ?? [];
    const curVersion = seriesVersion(routingId);
    let best: OpenCodeModelEntry | undefined;
    for (const candidate of sameSeries) {
      const cv = seriesVersion(candidate.id);
      if (best === undefined) {
        best = candidate;
        continue;
      }
      const bv = seriesVersion(best.id);
      // Prefer versioned candidates; among equals keep the first.
      if ((cv ?? bv) !== null && (cv !== null && (bv === null || versionGt(cv, bv)))) best = candidate;
    }

    const curLive = liveIds.has(routingId);

    if (best === undefined) {
      if (!curLive) {
        plan.removals.push({ display, routingId, tierName });
      }
      continue;
    }

    const bestVersion = seriesVersion(best.id);
    const curIsBest = best.id === routingId;
    const bestIsNewer =
      curVersion !== null &&
      bestVersion !== null &&
      versionGt(bestVersion, curVersion);

    if (curIsBest) continue; // already the latest of its series
    if (bestIsNewer) {
      plan.upgrades.push({ display, routingId, newDisplay: displayNameFor(best), newRoutingId: best.id });
      continue;
    }
    if (!curLive) {
      // cur is dead but only an older sibling remains — replace rather than remove
      plan.upgrades.push({ display, routingId, newDisplay: displayNameFor(best), newRoutingId: best.id });
    }
    // best <= cur and cur is live → keep, never downgrade
  }

  // Additions: live `-free` models not referenced by any routing value.
  // Upgrade targets are excluded — the upgrade itself already introduces them.
  // Models whose series is already routed (an older sibling) are excluded too —
  // otherwise re-syncing after an upgrade would re-add the old version back.
  const referencedIds = new Set(Object.values(routing));
  const upgradeTargetIds = new Set(plan.upgrades.map((u) => u.newRoutingId));
  const routedSeries = new Set(
    Object.values(routing)
      .filter((id) => id.startsWith(OPENCODE_ID_PREFIX))
      .map((id) => seriesKey(id)),
  );
  const existingDisplays = new Set(Object.keys(routing));
  for (const tier of config.modelsConfig?.tiers ?? []) {
    for (const m of tier.models) existingDisplays.add(m);
  }
  const lightweightTier = config.modelsConfig?.tiers?.find((t) => t.name === LIGHTWEIGHT_TIER_NAME);

  for (const entry of available) {
    if (!entry.active) continue;
    const bare = entry.id.startsWith(OPENCODE_ID_PREFIX) ? entry.id.slice(OPENCODE_ID_PREFIX.length) : entry.id;
    if (!bare.endsWith('-free')) continue;
    if (referencedIds.has(entry.id) || upgradeTargetIds.has(entry.id)) continue;
    if (routedSeries.has(seriesKey(entry.id))) continue;
    const display = displayNameFor(entry);
    if (existingDisplays.has(display)) continue; // routing is keyed by display — a collision would clobber another route
    if (!lightweightTier) {
      plan.skippedAdditions++;
      continue;
    }
    plan.additions.push({ display, routingId: entry.id, tierName: LIGHTWEIGHT_TIER_NAME });
  }

  return plan;
}

export function isPlanEmpty(plan: OpenCodeSyncPlan): boolean {
  return plan.removals.length + plan.upgrades.length + plan.additions.length === 0;
}

/**
 * Apply the plan to a cloned UserConfig in place: tiers, routing, and every
 * other display-holding slot are mutated atomically (single clone, single
 * save afterwards). Returns human-readable location labels.
 */
export function applyOpenCodePlan(config: UserConfig, plan: OpenCodeSyncPlan): string[] {
  const touched: string[] = [];
  const note = (location: string) => {
    if (!touched.includes(location)) touched.push(location);
  };

  const removalsByDisplay = new Map(plan.removals.map((r) => [r.display, r.routingId] as const));
  const upgradeByOldDisplay = new Map(plan.upgrades.map((u) => [u.display, u] as const));
  const additionsByDisplay = new Map(plan.additions.map((a) => [a.display, a.routingId] as const));

  const mapSlot = (display: string, location: string): string => {
    if (removalsByDisplay.has(display)) {
      note(location);
      return '';
    }
    const upgrade = upgradeByOldDisplay.get(display);
    if (upgrade) {
      note(location);
      return upgrade.newDisplay;
    }
    return display;
  };

  const routing = config.modelsConfig?.routing;
  if (routing) {
    for (const removal of plan.removals) {
      if (routing[removal.display] !== undefined) {
        delete routing[removal.display];
        note('路由表 (routing)');
      }
    }
    for (const upgrade of plan.upgrades) {
      if (routing[upgrade.display] !== undefined) {
        delete routing[upgrade.display];
        routing[upgrade.newDisplay] = upgrade.newRoutingId;
        note('路由表 (routing)');
      }
    }
    for (const addition of plan.additions) {
      routing[addition.display] = addition.routingId;
      note('路由表 (routing)');
    }
  }

  const tiers = config.modelsConfig?.tiers;
  if (tiers) {
    for (const tier of tiers) {
      const mapped = tier.models
        .map((m) => mapSlot(m, `层级「${tier.name}」`))
        .filter((m) => m !== '');
      if (mapped.length !== tier.models.length || mapped.some((m, i) => m !== tier.models[i])) {
        tier.models = mapped;
      }
    }
    const lightweightTier = tiers.find((t) => t.name === LIGHTWEIGHT_TIER_NAME);
    if (lightweightTier && plan.additions.length > 0) {
      for (const addition of plan.additions) {
        if (!lightweightTier.models.includes(addition.display)) {
          lightweightTier.models.push(addition.display);
          note(`层级「${LIGHTWEIGHT_TIER_NAME}」`);
        }
      }
    }
  }

  // Remaining array slots
  if (config.orderedModels) {
    const ordered = config.orderedModels;
    const mapped = ordered.map((m) => mapSlot(m, '自定义排序 (orderedModels)')).filter((m) => m !== '');
    if (mapped.length !== ordered.length || mapped.some((m, i) => m !== ordered[i])) {
      config.orderedModels = mapped;
    }
  }
  if (config.modelsConfig?.compareDefaults) {
    const src = config.modelsConfig.compareDefaults;
    const mapped = src.map((m) => mapSlot(m, '对比默认 (compareDefaults)')).filter((m) => m !== '');
    if (mapped.length !== src.length || mapped.some((m, i) => m !== src[i])) {
      config.modelsConfig.compareDefaults = mapped;
    }
  }
  const dm = config.defaultModels;
  if (dm) {
    if (dm.inlineSuggestions) {
      const src = dm.inlineSuggestions;
      const mapped = src.map((m) => mapSlot(m, 'inline 建议 (inlineSuggestions)')).filter((m) => m !== '');
      if (mapped.length !== src.length || mapped.some((m, i) => m !== src[i])) {
        dm.inlineSuggestions = mapped;
      }
    }
    if (dm.compareGroup) {
      const src = dm.compareGroup;
      const mapped = src.map((m) => mapSlot(m, '对比组 (compareGroup)')).filter((m) => m !== '');
      if (mapped.length !== src.length || mapped.some((m, i) => m !== src[i])) {
        dm.compareGroup = mapped;
      }
    }
    // single-value slots
    if (dm.taskModel && removalsByDisplay.has(dm.taskModel)) {
      dm.taskModel = undefined;
      note('任务模型 (taskModel)');
    }
    const taskUpgrade = dm.taskModel ? upgradeByOldDisplay.get(dm.taskModel) : undefined;
    if (taskUpgrade) {
      dm.taskModel = taskUpgrade.newDisplay;
      note('任务模型 (taskModel)');
    }
  }
  if (config.model) {
    if (removalsByDisplay.has(config.model)) {
      config.model = undefined;
      note('默认模型 (model)');
    } else {
      const modelUpgrade = upgradeByOldDisplay.get(config.model);
      if (modelUpgrade) {
        config.model = modelUpgrade.newDisplay;
        note('默认模型 (model)');
      }
    }
  }
  if (config.summarization?.model) {
    if (removalsByDisplay.has(config.summarization.model)) {
      config.summarization.model = undefined;
      note('摘要模型 (summarization.model)');
    } else {
      const sumUpgrade = upgradeByOldDisplay.get(config.summarization.model);
      if (sumUpgrade) {
        config.summarization.model = sumUpgrade.newDisplay;
        note('摘要模型 (summarization.model)');
      }
    }
  }

  // Additions never touch non-tier slots beyond routing + the tier itself.
  void additionsByDisplay;
  return touched;
}

/** Shape of src/config/models.json (the built-in registry). */
export interface ModelsJsonShape {
  tiers?: { name: string; priority: number; models: string[] }[];
  defaultOrder?: string[];
  routing?: Record<string, string>;
  descriptions?: Record<string, string>;
}

const PLACEHOLDER_DESCRIPTION = 'OpenCode 免费模型（自动收录） · 适用：零成本日常问答与轻量编码任务';

/**
 * Apply the plan to the parsed src/config/models.json content in place.
 * Safety rule: OpenCode mutations only act on entries whose key exists in the
 * models.json's OWN routing (or, for additions, not at all) — a models.json
 * without the routing segment is left untouched.
 */
export function applyOpenCodePlanToJson(parsed: ModelsJsonShape, plan: OpenCodeSyncPlan): boolean {
  let changed = false;
  const ownRouting = parsed.routing;

  // Snapshot BEFORE any routing mutation — later tier/description checks must
  // still see the pre-mutation routing to know which entries are managed here.
  const managedDisplays = new Set(ownRouting ? Object.keys(ownRouting) : []);
  const isManaged = (display: string): boolean => managedDisplays.has(display);
  // When models.json has no routing segment at all, isManaged is false for every
  // key (conservative: skip all mutations) — mirrors the "no routing → no-op" safety rule.

  if (ownRouting) {
    for (const removal of plan.removals) {
      if (ownRouting[removal.display] !== undefined) {
        delete ownRouting[removal.display];
        changed = true;
      }
    }
    for (const upgrade of plan.upgrades) {
      if (ownRouting[upgrade.display] !== undefined) {
        delete ownRouting[upgrade.display];
        ownRouting[upgrade.newDisplay] = upgrade.newRoutingId;
        changed = true;
      }
    }
    for (const addition of plan.additions) {
      if (ownRouting[addition.display] === undefined) {
        ownRouting[addition.display] = addition.routingId;
        changed = true;
      }
    }
  }

  if (parsed.tiers) {
    for (const tier of parsed.tiers) {
      const filtered = tier.models
        .map((m) => {
          if (!m.startsWith(OPENCODE_PREFIX)) return m;
          const removal = plan.removals.find((r) => r.display === m);
          if (removal && isManaged(m)) return '';
          const upgrade = plan.upgrades.find((u) => u.display === m);
          if (upgrade && isManaged(m)) return upgrade.newDisplay;
          return m;
        })
        .filter((m) => m !== '');
      if (filtered.length !== tier.models.length || filtered.some((m, i) => m !== tier.models[i])) {
        tier.models = filtered;
        changed = true;
      }
    }
    const lightweightTier = parsed.tiers.find((t) => t.name === LIGHTWEIGHT_TIER_NAME);
    if (lightweightTier && ownRouting) {
      for (const addition of plan.additions) {
        if (!lightweightTier.models.includes(addition.display)) {
          lightweightTier.models.push(addition.display);
          changed = true;
        }
      }
    }
  }

  if (parsed.defaultOrder) {
    const filtered = parsed.defaultOrder
      .map((m) => {
        if (!m.startsWith(OPENCODE_PREFIX)) return m;
        const removal = plan.removals.find((r) => r.display === m);
        if (removal && isManaged(m)) return '';
        const upgrade = plan.upgrades.find((u) => u.display === m);
        if (upgrade && isManaged(m)) return upgrade.newDisplay;
        return m;
      })
      .filter((m) => m !== '');
    if (filtered.length !== parsed.defaultOrder.length || filtered.some((m, i) => m !== parsed.defaultOrder![i])) {
      parsed.defaultOrder = filtered;
      changed = true;
    }
  }

  if (parsed.descriptions) {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.descriptions)) {
      if (!key.startsWith(OPENCODE_PREFIX) || !isManaged(key)) {
        next[key] = value;
        continue;
      }
      const removal = plan.removals.find((r) => r.display === key);
      if (removal) {
        changed = true;
        continue; // drop the description
      }
      const upgrade = plan.upgrades.find((u) => u.display === key);
      if (upgrade) {
        next[upgrade.newDisplay] = value; // keep the old description text
        changed = true;
        continue;
      }
      next[key] = value;
    }
    for (const addition of plan.additions) {
      if (next[addition.display] === undefined && ownRouting) {
        next[addition.display] = PLACEHOLDER_DESCRIPTION;
        changed = true;
      }
    }
    parsed.descriptions = next;
  }

  return changed;
}
