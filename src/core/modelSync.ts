/**
 * @file modelSync.ts
 * @description Keeps model references in config.json in sync with the local
 * CLI backends. Triggered by the Telegram `/model sync` command.
 *
 * Two independent sub-syncs share one backup / clone / save / cache-clear:
 *   - Gemini: `agy models` → upgrade Flash/Pro references to the highest local
 *     version per family (same effort tier). Strict less-than comparison
 *     guarantees no downgrades and idempotence.
 *   - OpenCode: `opencode models opencode` → remove dead entries, upgrade
 *     same-series versions, and auto-add new `-free` models (see
 *     modelSyncOpenCode.ts). OpenCode CLI failures degrade to a report-only
 *     error and never block the Gemini part.
 *   - HTTP backends (web2api/glm/qwen/mimo/deepseek): `GET /v1/models` →
 *     removals / same-series upgrades / media replacements (see
 *     modelSyncHttp.ts). Per-backend fetch failures degrade to report-only
 *     errors.
 *
 * Anti-flap safety: any destructive OpenCode/HTTP change (a removal or a
 * replacement of an id the first fetch reported dead) is confirmed by a
 * second, independent fetch — an id seen alive in either observation stays.
 * A failing confirmation skips the destructive part entirely.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgyModelEntry } from '../agy/agyModels.js';
import { listAgyModels } from '../agy/agyModels.js';
import { listOpenCodeModels, type OpenCodeModelEntry } from '../agy/opencodeModels.js';
import { HTTP_BACKEND_NAMES, listHttpBackendModels, type HttpBackendName } from '../agy/httpBackendModels.js';
import { clearDefaultModelsCache } from '../agy/modelDetection.js';
import {
  CONFIG_DIR,
  CONFIG_PATH,
  clearConfigCache,
  loadUserConfig,
  saveUserConfig,
  type UserConfig,
} from '../config/userConfig.js';
import { clearModelOrderCache } from './modelRegistry.js';
import {
  applyOpenCodePlan,
  applyOpenCodePlanToJson,
  computeOpenCodePlan,
  isPlanEmpty,
  type ModelsJsonShape,
  type OpenCodeSyncPlan,
  type OpenCodeSyncResult,
} from './modelSyncOpenCode.js';
import {
  applyHttpPlan,
  applyHttpPlanToJson,
  computeHttpPlan,
  isHttpPlanEmpty,
  type HttpSyncPlan,
  type HttpSyncResult,
} from './modelSyncHttp.js';
import { logger } from '../utils/logger.js';

export type GeminiFamily = 'Flash' | 'Pro';
export type GeminiEffort = 'High' | 'Medium' | 'Low';

const FAMILIES: readonly GeminiFamily[] = ['Flash', 'Pro'];

/** A parsed `Gemini <maj>.<min> <Family> (<Effort>)` reference. */
export interface GeminiModelRef {
  family: GeminiFamily;
  major: number;
  minor: number;
  effort: GeminiEffort;
  display: string;
}

/** Latest available version for one family, with the display name per effort. */
export interface FamilyLatest {
  major: number;
  minor: number;
  displays: Partial<Record<GeminiEffort, string>>;
}

/** One planned replacement: `from` → `to` (same family, same effort). */
export interface GeminiUpgrade {
  family: GeminiFamily;
  effort: GeminiEffort;
  from: string;
  to: string;
}

export type ModelSyncStatus = 'updated' | 'up-to-date' | 'no-gemini';

export interface ModelSyncResult {
  status: ModelSyncStatus;
  /** Planned and applied replacements (empty unless status === 'updated'). */
  upgrades: GeminiUpgrade[];
  /** Human-readable labels of the config slots that were rewritten. */
  appliedLocations: string[];
  /** Best-effort sync of src/config/models.json (source registry for future builds). */
  modelsJsonUpdated: boolean;
  modelsJsonError?: string;
  /** OpenCode sub-sync outcome (report-only errors never block the Gemini part). */
  opCode: OpenCodeSyncResult;
  /** HTTP-backend sub-sync outcomes, one entry per backend (web2api/glm/qwen/mimo/deepseek). */
  http: Record<HttpBackendName, HttpSyncResult>;
}

function ocError(error: string): OpenCodeSyncResult {
  return {
    status: 'error',
    removals: [],
    upgrades: [],
    additions: [],
    appliedLocations: [],
    modelsJsonUpdated: false,
    error,
  };
}

function httpError(error: string): HttpSyncResult {
  return {
    status: 'error',
    removals: [],
    upgrades: [],
    mediaReplacements: [],
    appliedLocations: [],
    error,
  };
}

function httpNoop(): HttpSyncResult {
  return { status: 'up-to-date', removals: [], upgrades: [], mediaReplacements: [], appliedLocations: [] };
}

function httpAllNoop(): Record<HttpBackendName, HttpSyncResult> {
  return Object.fromEntries(HTTP_BACKEND_NAMES.map((n) => [n, httpNoop()])) as Record<HttpBackendName, HttpSyncResult>;
}

function ocNoop(status: 'up-to-date' = 'up-to-date'): OpenCodeSyncResult {
  return { status, removals: [], upgrades: [], additions: [], appliedLocations: [], modelsJsonUpdated: false };
}

/**
 * A truncated/partial model list is indistinguishable from real upstream
 * removals — a single observation must never drive destructive changes.
 * Destructive = removals, media replacements, or upgrades whose current id
 * was observed dead (additions and upgrades of a live id are constructive).
 */
function ocPlanDestructive(plan: OpenCodeSyncPlan, liveIds: Set<string>): boolean {
  return plan.removals.length > 0 || plan.upgrades.some((u) => !liveIds.has(u.routingId));
}

/** Union two model lists by id — an id seen alive in either observation is alive. */
function unionById<T extends { id: string; active?: boolean }>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  for (const e of [...a, ...b]) {
    const prev = map.get(e.id);
    if (!prev || (prev.active === false && e.active === true)) map.set(e.id, e);
  }
  return [...map.values()];
}

/**
 * Parse a model display name of the form `Gemini <maj>.<min> Flash|Pro (High|Medium|Low)`.
 * Anchored, so prefixed channel models (`Web2API: Gemini 3.7 Flash Thinking`)
 * and other backends (`GPT-OSS 120B (Medium)`) never match.
 */
export function parseGeminiModelDisplay(display: string): GeminiModelRef | null {
  const m = /^Gemini (\d+)\.(\d+) (Flash|Pro) \((High|Medium|Low)\)$/.exec(display);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    family: m[3] as GeminiFamily,
    effort: m[4] as GeminiEffort,
    display,
  };
}

function versionLt(a: GeminiModelRef, b: FamilyLatest): boolean {
  return a.major < b.major || (a.major === b.major && a.minor < b.minor);
}

/**
 * For each family, pick the numerically highest version from the agy model
 * list and collect its display names per effort. Numeric comparison keeps
 * 3.10 > 3.9 correct.
 */
export function pickLatestGemini(entries: AgyModelEntry[]): Partial<Record<GeminiFamily, FamilyLatest>> {
  const latest: Partial<Record<GeminiFamily, FamilyLatest>> = {};
  for (const entry of entries) {
    const ref = parseGeminiModelDisplay(entry.display);
    if (!ref) continue;
    const current = latest[ref.family];
    if (!current || current.major < ref.major || (current.major === ref.major && current.minor < ref.minor)) {
      // newer version found — restart the display map for this family
      latest[ref.family] = { major: ref.major, minor: ref.minor, displays: { [ref.effort]: ref.display } };
    } else if (current.major === ref.major && current.minor === ref.minor) {
      current.displays[ref.effort] = ref.display;
    }
  }
  return latest;
}

/**
 * Compute all upgrades needed to bring a config's Gemini references up to the
 * latest local versions. A reference qualifies when its family has a newer
 * local version AND the same effort exists locally. Strict `<` — never
 * downgrade, and no-op when already current.
 */
export function computeModelSyncPlan(
  displays: string[],
  latest: Partial<Record<GeminiFamily, FamilyLatest>>,
): GeminiUpgrade[] {
  const seen = new Set<string>();
  const upgrades: GeminiUpgrade[] = [];
  for (const display of displays) {
    const ref = parseGeminiModelDisplay(display);
    if (!ref) continue;
    const familyLatest = latest[ref.family];
    if (!familyLatest) continue;
    if (!versionLt(ref, familyLatest)) continue;
    const to = familyLatest.displays[ref.effort];
    if (!to || to === display) continue;
    if (seen.has(display)) continue; // config slots repeat the same reference
    seen.add(display);
    upgrades.push({ family: ref.family, effort: ref.effort, from: display, to });
  }
  return upgrades;
}

/**
 * Collect every string slot in a UserConfig that may hold a Gemini display
 * name, with a human-readable location label. Order of the walk determines
 * the order locations are reported.
 */
function collectGeminiSlots(config: UserConfig): { display: string; location: string }[] {
  const slots: { display: string; location: string }[] = [];
  const push = (display: string | undefined, location: string) => {
    if (display) slots.push({ display, location });
  };

  push(config.model, '默认模型 (model)');
  for (const m of config.orderedModels ?? []) push(m, '自定义排序 (orderedModels)');
  for (const tier of config.modelsConfig?.tiers ?? []) {
    for (const m of tier.models) push(m, `层级「${tier.name}」`);
  }
  for (const m of config.modelsConfig?.compareDefaults ?? []) push(m, '对比默认 (compareDefaults)');
  push(config.defaultModels?.taskModel, '任务模型 (taskModel)');
  for (const m of config.defaultModels?.inlineSuggestions ?? []) push(m, 'inline 建议 (inlineSuggestions)');
  for (const m of config.defaultModels?.compareGroup ?? []) push(m, '对比组 (compareGroup)');
  push(config.summarization?.model, '摘要模型 (summarization.model)');
  return slots;
}
/** Apply `from → to` replacements to a cloned config in place; returns labels of touched slots. */
function applyUpgradesToConfig(config: UserConfig, upgrades: GeminiUpgrade[]): string[] {
  const mapping = new Map(upgrades.map((u) => [u.from, u.to] as const));
  const touched: string[] = [];
  const swap = (display: string, location: string): string => {
    const to = mapping.get(display);
    if (to === undefined) return display;
    if (!touched.includes(location)) touched.push(location);
    return to;
  };

  if (config.model) config.model = swap(config.model, '默认模型 (model)');
  if (config.orderedModels) config.orderedModels = config.orderedModels.map((m) => swap(m, '自定义排序 (orderedModels)'));
  for (const tier of config.modelsConfig?.tiers ?? []) {
    tier.models = tier.models.map((m) => swap(m, `层级「${tier.name}」`));
  }
  if (config.modelsConfig?.compareDefaults) {
    config.modelsConfig.compareDefaults = config.modelsConfig.compareDefaults.map((m) => swap(m, '对比默认 (compareDefaults)'));
  }
  const dm = config.defaultModels;
  if (dm) {
    if (dm.taskModel) dm.taskModel = swap(dm.taskModel, '任务模型 (taskModel)');
    if (dm.inlineSuggestions) dm.inlineSuggestions = dm.inlineSuggestions.map((m) => swap(m, 'inline 建议 (inlineSuggestions)'));
    if (dm.compareGroup) dm.compareGroup = dm.compareGroup.map((m) => swap(m, '对比组 (compareGroup)'));
  }
  if (config.summarization?.model) {
    config.summarization.model = swap(config.summarization.model, '摘要模型 (summarization.model)');
  }
  return touched;
}

const MODELS_JSON_PATH = path.join(CONFIG_DIR, 'src', 'config', 'models.json');

/**
 * Best-effort update of the built-in registry `src/config/models.json`: replace
 * every outdated Gemini Flash/Pro display in tiers / defaultOrder / descriptions
 * keys. This file only matters for fresh installs (config.json's modelsConfig
 * overrides it at runtime), so failures here are reported, not thrown.
 */
export function updateModelsJsonFile(
  modelsJsonPath: string = MODELS_JSON_PATH,
  latest: Partial<Record<GeminiFamily, FamilyLatest>>,
  ocPlan?: OpenCodeSyncPlan,
  httpPlans?: Partial<Record<HttpBackendName, HttpSyncPlan>>,
): { updated: boolean; error?: string } {
  try {
    const raw = fs.readFileSync(modelsJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as ModelsJsonShape;

    const replace = (display: string): string => {
      const ref = parseGeminiModelDisplay(display);
      if (!ref) return display;
      const familyLatest = latest[ref.family];
      if (!familyLatest || !versionLt(ref, familyLatest)) return display;
      return familyLatest.displays[ref.effort] ?? display;
    };

    let changed = false;
    const track = <T>(arr: T[], map: (v: T) => T): T[] => {
      const next = arr.map(map);
      if (next.some((v, i) => v !== arr[i])) changed = true;
      return next;
    };

    if (parsed.tiers) {
      for (const tier of parsed.tiers) {
        if (tier.models) tier.models = track(tier.models, replace);
      }
    }
    if (parsed.defaultOrder) parsed.defaultOrder = track(parsed.defaultOrder, replace);
    if (parsed.descriptions) {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.descriptions)) {
        const mapped = replace(key);
        if (mapped !== key) changed = true;
        next[mapped] = value;
      }
      parsed.descriptions = next;
    }

    if (ocPlan && !isPlanEmpty(ocPlan)) {
      const ocChanged = applyOpenCodePlanToJson(parsed, ocPlan);
      changed = changed || ocChanged;
    }

    for (const [service, httpPlan] of Object.entries(httpPlans ?? {}) as Array<[HttpBackendName, HttpSyncPlan]>) {
      if (!httpPlan || isHttpPlanEmpty(httpPlan)) continue;
      const httpChanged = applyHttpPlanToJson(parsed, service, httpPlan);
      changed = changed || httpChanged;
    }

    if (!changed) return { updated: false };
    fs.writeFileSync(modelsJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return { updated: true };
  } catch (e) {
    logger.warn(`[modelSync] Failed to update ${modelsJsonPath}: ${e}`);
    return { updated: false, error: String(e) };
  }
}

async function doRunModelSync(): Promise<ModelSyncResult> {
  // Parallel fetches: agy failure throws (existing contract); opencode / HTTP
  // backend failures each degrade to a per-backend report error
  const agyPromise = listAgyModels();
  const ocPromise = listOpenCodeModels().then(
    (entries) => ({ ok: true as const, entries }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  );
  const httpPromises = Promise.all(
    HTTP_BACKEND_NAMES.map(async (service) => {
      const r = await listHttpBackendModels(service).then(
        (entries) => ({ ok: true as const, entries }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
      );
      return [service, r] as const;
    }),
  );
  const entries = await agyPromise;
  const ocFetch = await ocPromise;
  const httpFetch = new Map(await httpPromises);

  const hasHttpErrors = [...httpFetch.values()].some((r) => !r.ok);
  const latest = pickLatestGemini(entries);
  const hasGemini = FAMILIES.some((f) => latest[f]);
  if (!hasGemini && !ocFetch.ok && !hasHttpErrors) {
    return { status: 'no-gemini', upgrades: [], appliedLocations: [], modelsJsonUpdated: false, opCode: ocError(ocFetch.error), http: httpAllNoop() };
  }

  const config = loadUserConfig();
  if (!config) {
    throw new Error('config.json 缺失或无法解析，无法写入升级结果');
  }

  const slots = collectGeminiSlots(config);
  const upgrades = hasGemini
    ? computeModelSyncPlan(
        slots.map((s) => s.display),
        latest,
      )
    : [];
  let ocPlan = ocFetch.ok ? computeOpenCodePlan(config, ocFetch.entries) : undefined;
  let ocNote: string | undefined;
  let ocEntries: OpenCodeModelEntry[] | undefined = ocFetch.ok ? ocFetch.entries : undefined;
  if (ocPlan && ocEntries && ocPlanDestructive(ocPlan, new Set(ocEntries.filter((e) => e.active).map((e) => e.id)))) {
    // Destructive plan: confirm with a second, independent fetch. An id seen
    // in either list stays alive; a confirmation failure keeps only additions.
    const confirm = await listOpenCodeModels().then(
      (entries) => ({ ok: true as const, entries }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    );
    if (confirm.ok) {
      const merged = unionById(ocEntries, confirm.entries);
      const confirmed = computeOpenCodePlan(config, merged);
      const before = ocPlan.removals.length + ocPlan.upgrades.length;
      const after = confirmed.removals.length + confirmed.upgrades.length;
      if (after < before) {
        ocNote = `首次拉取疑似不完整（${before} 项移除/替换，二次确认后仅 ${after} 项），已按二次拉取结果保留存疑条目`;
      }
      ocEntries = merged;
      ocPlan = confirmed;
    } else {
      ocNote = `二次确认拉取失败，为安全起见本次仅执行新增，跳过移除/替换: ${confirm.error}`;
      ocPlan = { ...ocPlan, removals: [], upgrades: [] };
    }
  }
  const hasOcWork = !!ocPlan && !isPlanEmpty(ocPlan);

  // HTTP plans: one per backend that fetched successfully; error backends report only
  const httpPlans: Partial<Record<HttpBackendName, HttpSyncPlan>> = {};
  const httpResults: Partial<Record<HttpBackendName, HttpSyncResult>> = {};
  for (const [service, fetch] of httpFetch) {
    if (!fetch.ok) {
      httpResults[service] = httpError(fetch.error);
      continue;
    }
    let plan = computeHttpPlan(config, service, fetch.entries);
    let note: string | undefined;
    if (!isHttpPlanEmpty(plan)) {
      // Every HTTP change hinges on a dead-id observation — confirm with a
      // second, independent fetch before mutating config (a truncated list
      // must never look like removals).
      const confirm = await listHttpBackendModels(service).then(
        (entries) => ({ ok: true as const, entries }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
      );
      if (confirm.ok) {
        const confirmed = computeHttpPlan(config, service, unionById(fetch.entries, confirm.entries));
        if (isHttpPlanEmpty(confirmed)) {
          note = '首次拉取疑似不完整，二次确认后无变更，已跳过';
        }
        plan = confirmed;
      } else {
        note = `二次确认拉取失败，为安全起见本次跳过该后端变更: ${confirm.error}`;
        plan = { removals: [], upgrades: [], mediaReplacements: [] };
      }
    }
    httpPlans[service] = plan;
    httpResults[service] = { status: isHttpPlanEmpty(plan) ? 'up-to-date' : 'updated', ...plan, appliedLocations: [], note };
  }
  const hasHttpWork = Object.values(httpPlans).some((p) => p && !isHttpPlanEmpty(p));

  if (upgrades.length === 0 && !hasOcWork && !hasHttpWork) {
    const status: ModelSyncStatus = hasGemini ? 'up-to-date' : 'no-gemini';
    return {
      status,
      upgrades: [],
      appliedLocations: [],
      modelsJsonUpdated: false,
      opCode: ocFetch.ok ? { ...ocNoop(), note: ocNote } : ocError(ocFetch.error),
      http: { ...httpAllNoop(), ...httpResults } as Record<HttpBackendName, HttpSyncResult>,
    };
  }

  // Backup before saveUserConfig reformats the whole file (repo has a .bak convention)
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${ts}`);
  } catch (e) {
    logger.warn(`[modelSync] Backup of config.json failed (continuing anyway): ${e}`);
  }

  const newConfig = structuredClone(config);
  const geminiLocations = applyUpgradesToConfig(newConfig, upgrades);
  const ocLocations = hasOcWork ? applyOpenCodePlan(newConfig, ocPlan!) : [];
  const httpLocations: string[] = [];
  for (const [service, plan] of Object.entries(httpPlans) as Array<[HttpBackendName, HttpSyncPlan]>) {
    if (!plan || isHttpPlanEmpty(plan)) continue;
    httpLocations.push(...applyHttpPlan(newConfig, service, plan));
  }
  const appliedLocations = [...geminiLocations, ...ocLocations, ...httpLocations];
  saveUserConfig(newConfig);

  // Hot-reload: same cache-clearing trio the SIGHUP handler uses (src/index.ts)
  clearConfigCache();
  clearDefaultModelsCache();
  clearModelOrderCache();

  const modelsJson = updateModelsJsonFile(MODELS_JSON_PATH, latest, ocPlan, httpPlans);

  // Fill appliedLocations into the per-backend HTTP results now that they're known
  for (const [service, plan] of Object.entries(httpPlans) as Array<[HttpBackendName, HttpSyncPlan]>) {
    if (!plan) continue;
    const result = httpResults[service]!;
    if (result.status === 'updated') result.appliedLocations = httpLocations;
  }

  const opCode: OpenCodeSyncResult = ocFetch.ok
    ? {
        status: hasOcWork ? 'updated' : 'up-to-date',
        removals: ocPlan?.removals ?? [],
        upgrades: ocPlan?.upgrades ?? [],
        additions: ocPlan?.additions ?? [],
        appliedLocations: ocLocations,
        modelsJsonUpdated: modelsJson.updated,
        note: ocNote,
      }
    : ocError(ocFetch.error);

  return {
    status: 'updated',
    upgrades,
    appliedLocations,
    modelsJsonUpdated: modelsJson.updated,
    modelsJsonError: modelsJson.error,
    opCode,
    http: { ...httpAllNoop(), ...httpResults } as Record<HttpBackendName, HttpSyncResult>,
  };
}

let _inFlight: Promise<ModelSyncResult> | null = null;

/** Run a model sync. Concurrent callers share the same in-flight run. @throws on agy/config failures. */
export async function runModelSync(): Promise<ModelSyncResult> {
  if (_inFlight) return _inFlight;
  _inFlight = doRunModelSync().finally(() => {
    _inFlight = null;
  });
  return _inFlight;
}
