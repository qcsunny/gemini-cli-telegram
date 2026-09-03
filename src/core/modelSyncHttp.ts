/**
 * @file modelSyncHttp.ts
 * @description Model sync for the OpenAI-compatible HTTP backends
 * (web2api / glm / qwen / mimo / deepseek) — the third `/model sync` segment.
 *
 * Rules (user-confirmed):
 *   1. Removal — routing id no longer upstream → drop from tiers + routing
 *   2. Upgrade — same series has a higher live version → swap routing id and
 *      the version number inside the display name (the display text is
 *      hand-crafted, e.g. glm "Ultra Thinking", so only the number changes)
 *   3. Media replacement — dead media ids (image/video) get replaced by the
 *      highest live same-suffix variant; multiple stale media entries merge
 *      into one generic display name (e.g. "Qwen: Image 2.0" + "Qwen: Image
 *      3.0" → "Qwen: Image"). Media models NEVER take version upgrades.
 *   4. No additions — brand-new upstream series are not auto-collected.
 *   5. Dedupe — a replacement target already owned by another entry turns the
 *      dead entry into a plain removal instead of a second route to that id.
 *
 * Namespace invariant: an entry is owned by a backend iff its display name
 * carries the backend prefix AND its routing id falls in the backend's id
 * namespace — mirroring the isOpenCodeModel double condition.
 */
import type { UserConfig } from '../config/userConfig.js';
import type { HttpBackendName, HttpModelEntry } from '../agy/httpBackendModels.js';
import { seriesKey, seriesVersion, versionGt } from './modelSyncOpenCode.js';

export type { HttpBackendName } from '../agy/httpBackendModels.js';

export interface HttpRemoval {
  display: string;
  routingId: string;
}

export interface HttpUpgrade {
  display: string;
  newDisplay: string;
  routingId: string;
  newRoutingId: string;
}

export interface HttpMediaReplacement {
  /** Old displays (>=1) that merge into the generic one. */
  displays: string[];
  newDisplay: string;
  newRoutingId: string;
}

export interface HttpSyncPlan {
  removals: HttpRemoval[];
  upgrades: HttpUpgrade[];
  mediaReplacements: HttpMediaReplacement[];
}

export type HttpSyncStatus = 'updated' | 'up-to-date' | 'error';

export interface HttpSyncResult {
  status: HttpSyncStatus;
  removals: HttpRemoval[];
  upgrades: HttpUpgrade[];
  mediaReplacements: HttpMediaReplacement[];
  /** Human-readable labels of the config slots that were rewritten. */
  appliedLocations: string[];
  /** Transport error message (status === 'error'). */
  error?: string;
  /** Set when the first model list looked partial and a confirmation fetch overruled it. */
  note?: string;
}

export function isHttpPlanEmpty(plan: HttpSyncPlan): boolean {
  return plan.removals.length + plan.upgrades.length + plan.mediaReplacements.length === 0;
}

/** Per-backend metadata: display prefix, id namespace, and version parsing. */
interface BackendSpec {
  displayPrefix: string;
  /** routing values starting with any of these belong to this backend. */
  idPrefixes: string[];
  /**
   * Version tuple embedded in the id. qwen glues the version onto the name
   * (qwen3.8-max-…), the others use dash-separated numeric segments.
   */
  versionOf: (id: string) => number[] | null;
  /** Skeleton for same-series matching. */
  skeletonOf: (id: string) => string;
  /** Media suffix detection (qwen: -image/-video; web2api: fixed id set). */
  mediaSuffixOf: (id: string) => 'image' | 'video' | null;
}

const WEB2API_MEDIA_IDS = new Set(['gemini-image', 'gemini-music', 'gemini-canvas', 'gemini-video']);

const DASH_SKELETON = (id: string): string => seriesKey(id);
const DASH_VERSION = (id: string): number[] | null => seriesVersion(id);

const QWEN_VERSION_RE = /^qwen(\d+(?:\.\d+)*)/;
const qwenVersion = (id: string): number[] | null => {
  const m = QWEN_VERSION_RE.exec(id);
  if (!m) return null;
  return m[1]!.split('.').map(Number);
};
const qwenSkeleton = (id: string): string => id.replace(QWEN_VERSION_RE, 'qwen');

const BACKEND_SPECS: Record<HttpBackendName, BackendSpec> = {
  web2api: {
    displayPrefix: 'Web2API: ',
    idPrefixes: ['gemini-'],
    versionOf: DASH_VERSION,
    skeletonOf: DASH_SKELETON,
    mediaSuffixOf: (id) => (WEB2API_MEDIA_IDS.has(id) ? (id.endsWith('-video') || id === 'gemini-video' ? 'video' : 'image') : null),
  },
  glm: {
    displayPrefix: 'GLM: ',
    idPrefixes: ['glm-'],
    versionOf: DASH_VERSION,
    skeletonOf: DASH_SKELETON,
    mediaSuffixOf: () => null,
  },
  qwen: {
    displayPrefix: 'Qwen: ',
    idPrefixes: ['qwen'],
    versionOf: qwenVersion,
    skeletonOf: qwenSkeleton,
    mediaSuffixOf: (id) => (id.endsWith('-image') ? 'image' : id.endsWith('-video') ? 'video' : null),
  },
  mimo: {
    displayPrefix: 'MiMo: ',
    idPrefixes: ['mimo-'],
    versionOf: DASH_VERSION,
    skeletonOf: DASH_SKELETON,
    mediaSuffixOf: () => null,
  },
  deepseek: {
    displayPrefix: 'DeepSeek: ',
    idPrefixes: ['deepseek-'],
    versionOf: DASH_VERSION,
    skeletonOf: DASH_SKELETON,
    mediaSuffixOf: () => null,
  },
};

/** Does this routing id belong to the backend's id namespace? */
function ownsRoutingId(spec: BackendSpec, routingId: string): boolean {
  return spec.idPrefixes.some((p) => routingId.startsWith(p));
}

/** Replace the first version-looking number in a display name. */
function bumpDisplayVersion(display: string, from: number[], to: number[]): string {
  const fromStr = from.join('.');
  const toStr = to.join('.');
  const replaced = display.replace(fromStr, toStr);
  return replaced === display ? display.replace(/(\d+(?:\.\d+)?)/, toStr) : replaced;
}

/** Strip a trailing version token from a media display name → generic name. */
function genericMediaDisplay(display: string): string {
  return display.replace(/\s*[\d.]+\s*$/, '').trim();
}

/**
 * Compute the sync plan for one backend. Only entries whose display name
 * carries the backend prefix AND whose routing id is in the backend's id
 * namespace are considered; everything else is untouched.
 */
export function computeHttpPlan(config: UserConfig, service: HttpBackendName, available: HttpModelEntry[]): HttpSyncPlan {
  const spec = BACKEND_SPECS[service];
  const plan: HttpSyncPlan = { removals: [], upgrades: [], mediaReplacements: [] };
  const routing = config.modelsConfig?.routing;
  if (!routing) return plan;

  const liveIds = new Set(available.map((e) => e.id));
  // Replacement targets already owned by another entry, plus the ones this plan
  // claims: routing onto an owned target would give two displays one id (and,
  // after the version bump, often the very same display name).
  const routedIds = new Set(Object.values(routing));
  const claimedTargets = new Set<string>();
  const liveBySkeleton = new Map<string, HttpModelEntry[]>();
  for (const entry of available) {
    const key = spec.skeletonOf(entry.id);
    const list = liveBySkeleton.get(key) ?? [];
    list.push(entry);
    liveBySkeleton.set(key, list);
  }

  // Group dead media entries by (media suffix) for merge-replacement.
  const deadMedia: Array<{ display: string; routingId: string; suffix: 'image' | 'video' }> = [];

  for (const [display, routingId] of Object.entries(routing)) {
    if (!display.startsWith(spec.displayPrefix)) continue;
    if (!ownsRoutingId(spec, routingId)) continue;

    const curLive = liveIds.has(routingId);
    if (curLive) continue; // live and correct — never touched by this sync

    // Dead entry. Media ones get merge-replacement, not removal.
    const suffix = spec.mediaSuffixOf(routingId);
    if (suffix) {
      deadMedia.push({ display, routingId, suffix });
      continue;
    }

    // Dead non-media: same-skeleton live sibling with a lower-or-equal version
    // acts as a replacement (better than removal); a higher version is an
    // upgrade. No sibling at all → removal.
    const siblings = (liveBySkeleton.get(spec.skeletonOf(routingId)) ?? []).filter((s) => !spec.mediaSuffixOf(s.id));
    const curVersion = spec.versionOf(routingId);
    let best: HttpModelEntry | undefined;
    for (const candidate of siblings) {
      const cv = spec.versionOf(candidate.id);
      if (best === undefined || (cv !== null && (spec.versionOf(best.id) === null || versionGt(cv, spec.versionOf(best.id)!)))) {
        best = candidate;
      }
    }
    if (!best) {
      plan.removals.push({ display, routingId });
      continue;
    }
    const bestVersion = spec.versionOf(best.id);
    const isUpgrade = curVersion !== null && bestVersion !== null && versionGt(bestVersion, curVersion);
    const newDisplay = isUpgrade && curVersion && bestVersion ? bumpDisplayVersion(display, curVersion, bestVersion) : display;
    if (routedIds.has(best.id) || claimedTargets.has(best.id) || (newDisplay !== display && routing[newDisplay] !== undefined)) {
      plan.removals.push({ display, routingId });
      continue;
    }
    claimedTargets.add(best.id);
    plan.upgrades.push({
      display,
      newDisplay,
      routingId,
      newRoutingId: best.id,
    });
  }

  // Merge dead media of the same suffix into one generic entry routed to the
  // highest-version live variant of that suffix.
  if (deadMedia.length > 0) {
    const bySuffix = new Map<'image' | 'video', typeof deadMedia>();
    for (const entry of deadMedia) {
      const list = bySuffix.get(entry.suffix) ?? [];
      list.push(entry);
      bySuffix.set(entry.suffix, list);
    }
    for (const [suffix, entries] of bySuffix) {
      const candidates = available.filter((e) => spec.mediaSuffixOf(e.id) === suffix);
      if (candidates.length === 0) {
        // No live variant upstream → plain removal
        plan.removals.push(...entries.map(({ display, routingId }) => ({ display, routingId })));
        continue;
      }
      let best = candidates[0]!;
      for (const c of candidates) {
        const cv = spec.versionOf(c.id);
        if (cv !== null && (spec.versionOf(best.id) === null || versionGt(cv, spec.versionOf(best.id)!))) best = c;
      }
      const primary = entries[0]!;
      const newDisplay = genericMediaDisplay(primary.display);
      // A live entry may already hold the generic name / top variant (e.g.
      // `Qwen: Image` → qwen3.8-max-image survives while `Qwen: Image 2.0`
      // dies). Merging onto it would duplicate that entry, so just drop the
      // dead ones.
      if (routedIds.has(best.id) || claimedTargets.has(best.id) || (newDisplay !== primary.display && routing[newDisplay] !== undefined)) {
        plan.removals.push(...entries.map(({ display, routingId }) => ({ display, routingId })));
        continue;
      }
      claimedTargets.add(best.id);
      plan.mediaReplacements.push({
        displays: entries.map((e) => e.display),
        newDisplay,
        newRoutingId: best.id,
      });
    }
  }

  return plan;
}

/**
 * Apply the plan to a cloned UserConfig in place: routing and every
 * display-holding slot mutate atomically (single clone, single save).
 * Returns human-readable location labels.
 */
export function applyHttpPlan(config: UserConfig, service: HttpBackendName, plan: HttpSyncPlan): string[] {
  const spec = BACKEND_SPECS[service];
  const touched: string[] = [];
  const note = (location: string) => {
    if (!touched.includes(location)) touched.push(location);
  };

  // Display transforms: removals → drop; upgrades → rename. A media merge is
  // many-to-one — EVERY member maps to the generic name, so a list carrying
  // only a non-primary member still keeps the model (mapList dedupes).
  const dropDisplays = new Set(plan.removals.map((r) => r.display));
  const displayMap = new Map<string, string>();
  for (const u of plan.upgrades) displayMap.set(u.display, u.newDisplay);
  for (const m of plan.mediaReplacements) {
    for (const d of m.displays) displayMap.set(d, m.newDisplay);
  }

  const mapSlot = (display: string, location: string): string => {
    if (dropDisplays.has(display)) {
      note(location);
      return '';
    }
    const mapped = displayMap.get(display);
    if (mapped !== undefined) {
      note(location);
      return mapped;
    }
    return display;
  };

  // Routing first
  const routing = config.modelsConfig?.routing;
  if (routing) {
    for (const display of [...dropDisplays, ...displayMap.keys()]) {
      if (routing[display] === undefined) continue;
      delete routing[display];
      note('路由表 (routing)');
    }
    for (const [oldDisplay, newDisplay] of displayMap) {
      const upgrade = plan.upgrades.find((u) => u.display === oldDisplay);
      const media = plan.mediaReplacements.find((m) => m.displays.includes(oldDisplay));
      const newId = upgrade?.newRoutingId ?? media?.newRoutingId;
      if (newId === undefined) continue; // display renamed without a routing target — keep as-is
      routing[newDisplay] = newId;
      note('路由表 (routing)');
    }
  }

  /** Map a display list, collapsing a merge target that is already present. */
  const mapList = (list: string[], location: string): string[] => {
    const out: string[] = [];
    for (const m of list) {
      const mapped = mapSlot(m, location);
      if (mapped === '') continue;
      if (mapped !== m && out.includes(mapped)) continue; // merged onto a member already kept
      out.push(mapped);
    }
    return out;
  };

  // Tiers and every other slot
  const tiers = config.modelsConfig?.tiers;
  if (tiers) {
    for (const tier of tiers) {
      const mapped = mapList(tier.models, `层级「${tier.name}」`);
      if (mapped.length !== tier.models.length || mapped.some((m, i) => m !== tier.models[i])) {
        tier.models = mapped;
      }
    }
  }

  const swapAll = (list: string[] | undefined, location: string): string[] | undefined => {
    if (!list) return undefined;
    const mapped = mapList(list, location);
    if (mapped.length !== list.length || mapped.some((m, i) => m !== list[i])) return mapped;
    return list;
  };

  if (config.orderedModels) config.orderedModels = swapAll(config.orderedModels, '自定义排序 (orderedModels)');
  if (config.modelsConfig?.compareDefaults) {
    config.modelsConfig.compareDefaults = swapAll(config.modelsConfig.compareDefaults, '对比默认 (compareDefaults)');
  }
  const dm = config.defaultModels;
  if (dm) {
    dm.inlineSuggestions = swapAll(dm.inlineSuggestions, 'inline 建议 (inlineSuggestions)');
    dm.compareGroup = swapAll(dm.compareGroup, '对比组 (compareGroup)');
    if (dm.taskModel) {
      const mapped = mapSlot(dm.taskModel, '任务模型 (taskModel)');
      dm.taskModel = mapped || undefined;
    }
  }
  if (config.model) {
    const mapped = mapSlot(config.model, '默认模型 (model)');
    config.model = mapped || undefined;
  }
  if (config.summarization?.model) {
    const mapped = mapSlot(config.summarization.model, '摘要模型 (summarization.model)');
    config.summarization.model = mapped || undefined;
  }

  void spec;
  return touched;
}

/** Shape of src/config/models.json (mirrors modelSyncOpenCode.ts). */
export interface HttpModelsJsonShape {
  tiers?: { name: string; priority: number; models: string[] }[];
  defaultOrder?: string[];
  routing?: Record<string, string>;
  descriptions?: Record<string, string>;
}

/**
 * Apply the plan to the parsed models.json content in place. Same safety rule
 * as OpenCode: mutations only act on keys present in models.json's OWN routing
 * (or absent, for removals, in which case the tier entry is unmanaged and
 * left untouched).
 */
export function applyHttpPlanToJson(parsed: HttpModelsJsonShape, service: HttpBackendName, plan: HttpSyncPlan): boolean {
  const spec = BACKEND_SPECS[service];
  let changed = false;
  const ownRouting = parsed.routing;
  const managed = new Set(ownRouting ? Object.keys(ownRouting) : []);

  const dropDisplays = new Set(plan.removals.map((r) => r.display));
  const displayMap = new Map<string, string>();
  for (const u of plan.upgrades) displayMap.set(u.display, u.newDisplay);
  // Media merges are many-to-one: every member resolves to the generic name so
  // a list holding only a non-primary member keeps the model (mapList dedupes).
  const mergeOf = new Map<string, string>();
  for (const m of plan.mediaReplacements) {
    for (const d of m.displays) mergeOf.set(d, m.newDisplay);
  }

  if (ownRouting) {
    // New keys are claimed only when at least one source display was managed
    // here — models.json must never gain an entry it did not already own.
    const claimed = new Map<string, string>();
    for (const u of plan.upgrades) {
      if (ownRouting[u.display] === undefined) continue;
      delete ownRouting[u.display];
      changed = true;
      claimed.set(u.newDisplay, u.newRoutingId);
    }
    for (const m of plan.mediaReplacements) {
      let anyManaged = false;
      for (const d of m.displays) {
        if (ownRouting[d] === undefined) continue;
        delete ownRouting[d];
        changed = true;
        anyManaged = true;
      }
      if (anyManaged) claimed.set(m.newDisplay, m.newRoutingId);
    }
    for (const r of plan.removals) {
      if (ownRouting[r.display] === undefined) continue;
      delete ownRouting[r.display];
      changed = true;
    }
    for (const [newDisplay, newId] of claimed) {
      ownRouting[newDisplay] = newId;
      changed = true;
    }
  }

  const isManaged = (display: string): boolean => managed.has(display);
  /** Map a display list; merge members collapse onto the first one present. */
  const mapList = (list: string[]): string[] => {
    const out: string[] = [];
    for (const m of list) {
      if (!m.startsWith(spec.displayPrefix) || !isManaged(m)) {
        out.push(m); // unmanaged here → untouched
        continue;
      }
      const merged = mergeOf.get(m);
      if (merged !== undefined) {
        if (!out.includes(merged)) out.push(merged);
        continue;
      }
      if (dropDisplays.has(m)) continue;
      out.push(displayMap.get(m) ?? m);
    }
    return out;
  };

  if (parsed.tiers) {
    for (const tier of parsed.tiers) {
      const next = mapList(tier.models);
      if (next.length !== tier.models.length || next.some((m, i) => m !== tier.models[i])) {
        tier.models = next;
        changed = true;
      }
    }
  }
  if (parsed.defaultOrder) {
    const next = mapList(parsed.defaultOrder);
    if (next.length !== parsed.defaultOrder.length || next.some((m, i) => m !== parsed.defaultOrder![i])) {
      parsed.defaultOrder = next;
      changed = true;
    }
  }
  if (parsed.descriptions) {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.descriptions)) {
      if (!key.startsWith(spec.displayPrefix) || !isManaged(key)) {
        next[key] = value;
        continue;
      }
      const merged = mergeOf.get(key);
      if (merged !== undefined) {
        if (next[merged] === undefined) next[merged] = value; // first member's text wins
        changed = true;
        continue;
      }
      if (dropDisplays.has(key)) {
        changed = true;
        continue; // drop the description
      }
      const mapped = displayMap.get(key) ?? key;
      if (mapped !== key) changed = true;
      next[mapped] = value;
    }
    parsed.descriptions = next;
  }

  return changed;
}
