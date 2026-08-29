/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file userConfig.ts
 * @description Manages persistence and loading of the daemon's local configuration.
 * Handles Telegram bot token, user whitelist, default model, proxy settings, project list,
 * and configurable file paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

/** Project root directory (auto-detected from import.meta.url) */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Main JSON configuration file path (project root) */
export const CONFIG_DIR = PROJECT_ROOT;
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Zod schema for a single model tier in the tiered fallback system */
const modelTierSchema = z.object({
  /** Display name for this tier (e.g. "旗舰推理", "高级推理", "通用能力", "轻量快速") */
  name: z.string(),
  /** Priority level: 0 = highest priority (tried first) */
  priority: z.number(),
  /** Ordered list of model display names within this tier */
  models: z.array(z.string()),
});

/** Zod schema for the complete models configuration (tiers + routing) */
const modelsConfigSchema = z.object({
  /** Tiered model groups for structured fallback */
  tiers: z.array(modelTierSchema),
  /** Mapping from display model name to backend API model ID */
  routing: z.record(z.string(), z.string()),
  /** Default models selected when starting a /v comparison query. */
  compareDefaults: z.array(z.string()).optional(),
});

/**
 * Zod schema for default model names used as runtime fallbacks.
 * All fields are optional; when absent the callers degrade gracefully
 * (e.g. empty suggestion list, no extra comparison group).
 */
const defaultModelsSchema = z.object({
  /** DeepSeek backend API model ID used when routing lookup misses. */
  deepseekId: z.string().optional(),
  /** Default model display name for /task runs when nothing else is set. */
  taskModel: z.string().optional(),
  /** Extra model display names suggested on inline queries without a model. */
  inlineSuggestions: z.array(z.string()).optional(),
  /** Fixed challengers appended after the dynamic first model in default /v group. */
  compareGroup: z.array(z.string()).optional(),
});

/** Zod schema for /sum chat summarization settings. */
const summarizationSchema = z.object({
  /** Default number of recent messages summarized by /sum when no count is given. */
  defaultCount: z.number().optional(),
  /** Maximum number of recent messages /sum is allowed to summarize. */
  maxCount: z.number().optional(),
  /** Model display name used for summarization. Falls back to the session/default model. */
  model: z.string().optional(),
});

/** Zod schema for individual project configurations */
const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  lastUsed: z.coerce.date().optional(),
});

/** Zod schema for overall UserConfig validation */
const userConfigSchema = z.object({
  telegramBotToken: z.string(),
  allowedUsers: z.array(z.number()).min(1, 'allowedUsers must contain at least one Telegram user ID'),
  model: z.string().optional(),
  proxy: z.string().optional(),
  geminiApiKey: z.string().optional(),
  deepseekApiKey: z.string().optional(),
  anthropicAuthToken: z.string().optional(),
  agentRouterApiKey: z.string().optional(),
  codexPath: z.string().optional(),
  /** API key for external stock market data provider (optional). */
  stockMarketApiKey: z.string().optional(),
  /** API key for RapidAPI Yahoo Finance provider fallback (optional). */
  rapidApiKey: z.string().optional(),
  /** HTTP health endpoint port (optional). If set, starts a /health HTTP server. */
  healthPort: z.number().optional(),
  /** Solidified project list (id/name/path/description). Kept in the local,
   *  gitignored config so personal directory paths never reach the remote repo. */
  projects: z.array(projectInfoSchema).optional(),
  /** Default project name used when a chat has no saved cwd. Matches a project
   *  name in the `projects` list. If unset, falls back to the first project. */
  defaultProject: z.string().optional(),
  /**
   * Custom file paths (optional). Each path defaults independently (db, log,
   * and scheduled-tasks default to the project root; answerSaveDir is required;
   * agyDataDir / opencodeDb / browseRoot default to XDG/standard user dirs).
   * Override any path to store data elsewhere.
   */
   paths: z.object({
    /** SQLite database file. Default: CONFIG_DIR/db.sqlite */
    db: z.string().optional(),
    /** Main daemon log file. Default: CONFIG_DIR/logs/daemon.log */
    log: z.string().optional(),
    /** Error log file. Default: CONFIG_DIR/logs/error.log */
    errorLog: z.string().optional(),
    /** Process ID file. Default: CONFIG_DIR/daemon.pid */
    pid: z.string().optional(),
    /** Scheduled tasks JSON file. Default: CONFIG_DIR/scheduled-tasks.json */
    scheduledTasks: z.string().optional(),
    /** Legacy agy conversations JSON file. Default: CONFIG_DIR/agy-conversations.json */
    agyConversations: z.string().optional(),
    /** agy CLI data directory (conversations, brain, OAuth token). Default: ~/.gemini/antigravity-cli */
    agyDataDir: z.string().optional(),
    /** opencode SQLite database path. Default: $XDG_DATA_HOME/opencode/opencode.db or ~/.local/share/opencode/opencode.db */
    opencodeDb: z.string().optional(),
    /** Default browse root directory for /project_browse. Default: ~/Documents */
    browseRoot: z.string().optional(),
    /** Directory where /save and save-latest write markdown answer files. Required. */
    answerSaveDir: z.string().optional(),
  }).optional(),
  /**
   * Custom model fallback order (optional). When set, takes highest priority
   * over the tier-derived order from modelsConfig.tiers / models.json (see
   * getEffectiveModelOrder in core/modelRegistry.ts). Each entry must be a
   * model display name as used by the fallback system (e.g. 'Claude Opus 4.6
   * (Thinking)', 'Web2API: Gemini 3.5 Flash'). Models not present in this list
   * are still reachable but won't appear in the fallback chain.
   */
  orderedModels: z.array(z.string()).optional(),
  /**
   * Tiered models configuration (optional). When set, overrides the tier/order
   * definitions in models.json and provides structured fallback with tier
   * awareness. Each tier groups models by capability level, and the fallback
   * system degrades tier-by-tier rather than model-by-model.
   */
  modelsConfig: modelsConfigSchema.optional(),
  /**
   * Default model names used as runtime fallbacks (optional).
   * All fields are optional; omitted fields degrade gracefully instead of
   * falling back to hardcoded model names.
   */
  defaultModels: defaultModelsSchema.optional(),
  /**
   * /sum chat summarization settings (optional).
   * Controls how many recent messages are summarized and which model is used.
   */
  summarization: summarizationSchema.optional(),
  /**
   * Backend service URLs for local proxy services.
   * Foreign users can skip by omitting the key entirely (the corresponding
   * model routes will not be available).
   */
  backends: z.object({
    /** Web2API reverse proxy URL. Default: http://127.0.0.1:8083/v1 */
    web2api: z.string().optional(),
    /** Web2API shared secret key. Default: sk-gemini-local */
    web2apiKey: z.string().optional(),
    /** DeepSeek API proxy URL. Default: http://127.0.0.1:5001/v1 */
    deepseek: z.string().optional(),
    /** GLM (chatglm.cn) proxy URL — HelloGML. Default: http://127.0.0.1:8093/v1 */
    glm: z.string().optional(),
    /** GLM proxy API key. No default: HelloGML generates one per install. */
    glmKey: z.string().optional(),
    /** Qwen (chat.qwen.ai) proxy URL — Qwen2API. Default: http://127.0.0.1:8092/v1 */
    qwen: z.string().optional(),
    /** Qwen proxy API key. No default: Qwen2API generates one per install. */
    qwenKey: z.string().optional(),
  }).optional(),
  /**
   * Tuning parameters for runtime behavior.
   * All fields are optional; omitted fields use the defaults shown in TUNING_DEFAULTS.
   */
  tuning: z.object({
    /**
     * Minimum interval (ms) between consecutive Telegram message edits during streaming.
     * Controls how often the bot updates the "typing..." draft in the chat.
     *
     * - Lower values (e.g. 500):  Smoother streaming, more API calls, may hit Telegram rate limits.
     * - Higher values (e.g. 3000): Less API traffic, but choppier visual updates.
     *
     * Default: 350 (0.35 seconds) — balances smoothness and rate-limit safety.
     */
    debounceIntervalMs: z.number().positive().optional(),
    /**
     * Absolute wall-clock timeout (ms) for a single model run. This timer is NEVER
     * reset by activity and serves as a hard kill switch. If a model run exceeds
     * this duration, it is forcibly terminated regardless of streaming progress.
     *
     * - Lower values (e.g. 300000 = 5min):  Kills stuck models faster, but may
     *   truncate very long outputs (e.g. code generation, large documents).
     * - Higher values (e.g. 1800000 = 30min): Allows extremely long outputs, but
     *   stuck models waste more time/resources before being killed.
     *
     * Default: 900000 (15 minutes) — sufficient for ~180k Chinese chars at 200 char/s.
     */
    modelRunHardTimeoutMs: z.number().positive().optional(),
    /**
     * Inactivity timeout (ms) — if the model produces NO output for this long, the
     * run is killed as a suspected upstream stall. This timer resets on every
     * streamed chunk, so actively streaming replies are never killed.
     *
     * - Lower values (e.g. 120000 = 2min):  Faster stall detection, but may kill
     *   models that pause for "thinking" between chunks.
     * - Higher values (e.g. 1800000 = 30min): More tolerant of slow models, but
     *   genuine stalls waste more time before detection.
     *
     * Default: 600000 (10 minutes) — balances stall detection with slow-model tolerance.
     */
    modelRunInactivityMs: z.number().positive().optional(),
    /**
     * Number of times each model is retried before falling back to the next tier.
     * Applies per-model: if a model fails, it is retried up to this many times
     * before the fallback chain advances to a weaker model.
     *
     * - Lower values (e.g. 1):  Fast fallback, but may abandon a model that fails
     *   due to a transient error (rate limit, brief outage).
     * - Higher values (e.g. 5): More resilient to transient errors, but slower to
     *   fall back when a model is genuinely unavailable.
     *
     * Default: 3 — retries transient failures while still falling back promptly.
     */
    retriesPerModel: z.number().positive().optional(),
    /**
     * Sliding window size for conversation history sent to the web2api / deepseek
     * backends. These OpenAI-compatible SSE backends don't maintain server-side
     * conversation state, so the full history must be sent with each request.
     *
     * - Lower values (e.g. 20):  Faster responses, less token usage, but less context.
     * - Higher values (e.g. 80): More context, but higher latency and token costs.
     *
     * Default: 40 — sufficient context for multi-turn conversations without excessive cost.
     */
    maxHistoryMessages: z.number().positive().optional(),
    /**
     * Time-to-live (ms) for cached raw Markdown messages used by the /save command.
     * After this duration, cached entries are automatically evicted.
     *
     * - Lower values (e.g. 3600000 = 1h):   Frees memory faster, but /save may fail
     *   if the user waits too long after receiving a reply.
     * - Higher values (e.g. 604800000 = 7d): Allows /save for older messages, but
     *   consumes more memory.
     *
     * Default: 86400000 (24 hours) — covers typical daily usage patterns.
     */
    cacheTtlMs: z.number().positive().optional(),
    /**
     * Maximum number of entries in the message cache. When the cache reaches this
     * limit, the least-recently-used entry is evicted to make room for new ones.
     *
     * - Lower values (e.g. 200):   Less memory usage, but evicts older messages faster.
     * - Higher values (e.g. 5000): More messages retained, but higher memory footprint.
     *
     * Default: 1000 — handles ~1000 messages/day with room for burst traffic.
     */
    cacheMaxSize: z.number().positive().optional(),
    /** Maximum Telegram attachment size accepted for model input. Default: 50 MiB. */
    maxDownloadBytes: z.number().positive().optional(),
    /**
     * Auto-approve ALL tool permissions for backend model runs in the regular
     * chat path (not just /invest): opencode gets `--auto`, agy native gets
     * `--dangerously-skip-permissions`. This lets models use web search, run
     * commands, etc. without manual approval.
     *
     * - true:  models can call any tool (web fetch, bash, file writes) freely.
     * - false: tools stay disabled in regular chat.
     *
     * Default: true — this is a personal bot; the owner wants full tool access.
     */
    autoApproveTools: z.boolean().optional(),
    /** Stream reasoning/tool events into the inline details block. */
    inlineThinkingStreaming: z.boolean().optional(),
    /**
     * Dump the shape of every agy `--output-format stream-json` event to the log
     * (event name + field names + truncated values, never full content).
     *
     * Diagnostic only: agy's event contract is undocumented, so this is how we
     * find out which event actually carries `conversation_id` etc. Leave off in
     * normal operation — it logs one line per event. config.json is re-read
     * every few seconds, so toggling this needs no restart.
     *
     * Default: false.
     */
    debugAgyStreamEvents: z.boolean().optional(),
    /**
     * Make the regular chat path (messageLoop) request agy's machine-readable
     * `--output-format stream-json` stream, exactly like the inline path already
     * does. agy's stream-json stdout is the only source that carries reasoning
     * as it is generated; the transcript file is flushed by agy in one late batch
     * at process exit, so polling it can never stream thinking in real time.
     *
     * The reason this is a flag and not the default: agy's event contract is
     * undocumented and we have not yet confirmed which field carries the planner
     * reasoning in this mode. Enable it together with `debugAgyStreamEvents` to
     * capture the real event shapes, wire the correct field, then flip the
     * default. Body text still arrives via the same `onEvent` text events the
     * poll-based path already uses, so the downgrade risk is limited to the
     * thinking extraction.
     *
     * Default: false.
     */
    streamJsonForChat: z.boolean().optional(),
    /**
     * Stream private-chat replies through the official Bot API draft mechanism:
     * `sendRichMessageDraft` for the animated ephemeral preview, then
     * `sendRichMessage` at finalize to persist the real message. The draft is a
     * temporary ~30s preview that must be kept alive with periodic re-sends
     * (messageLoop heartbeat) and only works in private chats, so this is off by
     * default. Groups/supergroups always keep the real-message + editMessageText
     * path regardless of this flag.
     *
     * Default: false.
     */
    useRichDraftPrivate: z.boolean().optional(),
    /**
     * Stream the reasoning text INSIDE the native `thinking` pill during the
     * thinking phase of a private-chat draft, so the pill animation covers the
     * reasoning itself and not just the "🧠 Thinking..." label.
     *
     * Set to false to restore the older split layout — a label-only pill with
     * the reasoning rendered as plain paragraphs beneath it — which is the safer
     * choice on clients that render the pill collapsed and therefore hide its
     * text. Only affects the sendRichMessageDraft path (private chats with
     * `useRichDraftPrivate` on); the final persisted message always carries the
     * full reasoning in the "🧠 Thinking Process" details block either way.
     *
     * Default: true.
     */
    richDraftThinkingInPill: z.boolean().optional(),
  }).optional(),
});

/**
 * User configuration type inferred from Zod schema.
 */
export type UserConfig = z.infer<typeof userConfigSchema>;

/**
 * Default model names block inferred from Zod schema.
 */
type DefaultModels = z.infer<typeof defaultModelsSchema>;

// ── Path Resolvers ─────────────────────────────────────────────────────────
// All paths resolve from config.json `paths.*` fields, falling back to CONFIG_DIR.

function resolvePath(configPath: string | undefined, fallbackName: string): string {
  const value = configPath ?? (path.isAbsolute(fallbackName) ? fallbackName : path.join(CONFIG_DIR, fallbackName));
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}

export function getDbPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.db, 'db.sqlite');
}

export function getLogPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.log, path.join('logs', 'daemon.log'));
}

export function getPidPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.pid, 'daemon.pid');
}

export function getScheduledTasksPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.scheduledTasks, 'scheduled-tasks.json');
}

export function getAgyConversationsPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.agyConversations, 'agy-conversations.json');
}

/** Default tuning constants — used when config.tuning fields are omitted. */
export const TUNING_DEFAULTS = {
  debounceIntervalMs: 350,
  modelRunHardTimeoutMs: 900_000,
  modelRunInactivityMs: 600_000,
  retriesPerModel: 3,
  maxHistoryMessages: 40,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  cacheMaxSize: 1000,
  maxDownloadBytes: 50 * 1024 * 1024,
  autoApproveTools: true,
  inlineThinkingStreaming: true,
  debugAgyStreamEvents: false,
  streamJsonForChat: false,
  useRichDraftPrivate: false,
  richDraftThinkingInPill: true,
};

/**
 * Resolved tuning values: config overrides merged with defaults.
 */
type TuningConfig = {
  debounceIntervalMs: number;
  modelRunHardTimeoutMs: number;
  modelRunInactivityMs: number;
  retriesPerModel: number;
  maxHistoryMessages: number;
  cacheTtlMs: number;
  cacheMaxSize: number;
  maxDownloadBytes: number;
  autoApproveTools: boolean;
  inlineThinkingStreaming: boolean;
  debugAgyStreamEvents: boolean;
  streamJsonForChat: boolean;
  useRichDraftPrivate: boolean;
  richDraftThinkingInPill: boolean;
};

let _cachedTuning: TuningConfig | undefined;

/** Default backend URLs — used when config.backends fields are omitted. */
export const BACKEND_URL_DEFAULTS = {
  web2api: 'http://127.0.0.1:8083/v1',
  deepseek: 'http://127.0.0.1:5001/v1',
  glm: 'http://127.0.0.1:8093/v1',
  qwen: 'http://127.0.0.1:8092/v1',
  web2apiKey: 'sk-gemini-local',
};

/**
 * Returns the configured backend URL for a given service, falling back to defaults.
 * Returns null if neither config nor default is set (backend not available).
 */
export function getBackendUrl(service: 'web2api' | 'deepseek' | 'glm' | 'qwen'): string | null {
  const cfg = loadUserConfig();
  return cfg?.backends?.[service] || BACKEND_URL_DEFAULTS[service] || null;
}

/** Returns the Web2API shared secret key, from config or default. */
export function getWeb2ApiKey(): string {
  const cfg = loadUserConfig();
  return cfg?.backends?.web2apiKey || BACKEND_URL_DEFAULTS.web2apiKey;
}

const AGY_DATA_DIR_DEFAULT = path.join(os.homedir(), '.gemini', 'antigravity-cli');

export function getAgyDataDir(): string {
  if (process.env['ANTIGRAVITY_USER_DIR']) return process.env['ANTIGRAVITY_USER_DIR'];
  const cfg = loadUserConfig();
  return resolvePath(cfg?.paths?.agyDataDir, AGY_DATA_DIR_DEFAULT);
}

/**
 * Returns the configured default model display name (config.json "model").
 * Returns null when unset so callers can fall back to their own ordering.
 */
export function getDefaultModel(): string | null {
  return loadUserConfig()?.model ?? null;
}

/** Returns the configured stock market data API key (config.json "stockMarketApiKey"). Null when unset. */
export function getStockMarketApiKey(): string | null {
  return loadUserConfig()?.stockMarketApiKey ?? null;
}

/** Returns the configured RapidAPI Key for Yahoo Finance API (config.json "rapidApiKey"). Null when unset. */
export function getRapidApiKey(): string | null {
  return loadUserConfig()?.rapidApiKey ?? null;
}

/** Local-only token for the stock/watchlist HTTP API, derived without exposing the bot token. */
export function getStockApiToken(): string {
  const token = loadUserConfig()?.telegramBotToken || process.env['TELEGRAM_BOT_TOKEN'] || 'unset';
  return createHash('sha256').update(`stock-api:${token}`).digest('hex');
}

/**
 * Returns the configured default project name (config.json "defaultProject").
 * Returns null when unset so callers fall back to the first project.
 */
export function getDefaultProjectName(): string | null {
  return loadUserConfig()?.defaultProject ?? null;
}

/**
 * Returns the configured default model names block (config.json "defaultModels").
 * Returns null when unset so callers degrade gracefully.
 */
export function getDefaultModels(): DefaultModels | null {
  return loadUserConfig()?.defaultModels ?? null;
}

/** Default /sum summarization settings — used when config.summarization fields are omitted. */
export const SUMMARIZATION_DEFAULTS = {
  defaultCount: 100,
  maxCount: 500,
};

/** Resolved summarization settings: config overrides merged with defaults. */
export type SummarizationConfig = {
  defaultCount: number;
  maxCount: number;
  model?: string;
};

let _cachedSummarization: SummarizationConfig | undefined;

/**
 * Returns the resolved /sum summarization configuration (config values + defaults).
 * Cached after first call and cleared via clearConfigCache() on SIGHUP.
 */
export function getSummarizationConfig(): SummarizationConfig {
  if (_cachedSummarization) return _cachedSummarization;
  const cfg = loadUserConfig();
  _cachedSummarization = { ...SUMMARIZATION_DEFAULTS, ...cfg?.summarization };
  return _cachedSummarization;
}

const BROWSE_ROOT_DEFAULT = path.join(os.homedir(), 'Documents');

export function getBrowseRoot(): string {
  const cfg = loadUserConfig();
  return cfg?.paths?.browseRoot || BROWSE_ROOT_DEFAULT;
}

const OPENCODE_DATA_DIR_DEFAULT = path.join(os.homedir(), '.local', 'share', 'opencode');
const OPENCODE_DB_DEFAULT = path.join(OPENCODE_DATA_DIR_DEFAULT, 'opencode.db');

export function getOpenCodeDbPath(): string {
  if (process.env['OPENCODE_DB']) return process.env['OPENCODE_DB'];
  const cfg = loadUserConfig();
  if (cfg?.paths?.opencodeDb) return resolvePath(cfg.paths.opencodeDb, OPENCODE_DB_DEFAULT);
  if (process.env['XDG_DATA_HOME']) {
    return path.join(process.env['XDG_DATA_HOME'], 'opencode', 'opencode.db');
  }
  return OPENCODE_DB_DEFAULT;
}

export function getAnswerSaveDir(): string {
  const answerSaveDir = loadUserConfig()?.paths?.answerSaveDir;
  if (!answerSaveDir) {
    throw new Error('paths.answerSaveDir is not configured. Set it in config.json (e.g. "~/Documents/Obsidian/Inbox").');
  }
  return resolvePath(answerSaveDir, answerSaveDir);
}

/**
 * Clears the cached tuning and user config. Called on SIGHUP to force a fresh read
 * from disk on the next call to getTuningConfig() / loadUserConfig().
 */
export function clearConfigCache(): void {
  _cachedTuning = undefined;
  _cachedSummarization = undefined;
  _configCache = undefined;
}

/**
 * Returns the resolved tuning configuration (config values + defaults).
 * Cached after first call and cleared via clearConfigCache() on SIGHUP.
 */
export function getTuningConfig(): TuningConfig {
  if (_cachedTuning) return _cachedTuning;
  const cfg = loadUserConfig();
  _cachedTuning = { ...TUNING_DEFAULTS, ...cfg?.tuning };
  return _cachedTuning;
}

/**
 * Checks whether the configuration file exists on disk.
 */
export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

const CONFIG_CACHE_TTL = 5_000;
let _configCache: { result: UserConfig | null; ts: number } | undefined;

/**
 * Synchronously loads and parses the user configuration file from disk.
 * Validates strictly using userConfigSchema.
 * Returns null if the file does not exist or is malformed/invalid.
 * Results are cached for CONFIG_CACHE_TTL ms to avoid repeated I/O + Zod validation.
 */
export function loadUserConfig(): UserConfig | null {
  if (_configCache && Date.now() - _configCache.ts < CONFIG_CACHE_TTL) {
    return _configCache.result;
  }
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(content);
    const result = userConfigSchema.parse(parsed);
    _configCache = { result, ts: Date.now() };
    return result;
  } catch (e) {
    logger.warn(`[userConfig] Failed to load config.json: ${e instanceof Error ? e.message : e}. Falling back to defaults.`);
    _configCache = { result: null, ts: Date.now() };
    return null;
  }
}

/**
 * Saves the given UserConfig object to disk with restrictive file permissions (0600).
 *
 * @param config - The UserConfig object to save.
 */
export function saveUserConfig(config: UserConfig): void {
  const validated = userConfigSchema.parse(config);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const content = JSON.stringify(validated, null, 2) + '\n';
  // Atomic write: write to temp file then rename so a crash mid-write never
  // leaves config.json truncated/corrupted.
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
  // Invalidate the read caches so callers immediately see the new value and
  // concurrent writers don't clobber each other within the previous TTL window.
  _configCache = undefined;
  _cachedTuning = undefined;
  _cachedSummarization = undefined;
}
