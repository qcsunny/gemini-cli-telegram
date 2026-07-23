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
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

/** Project root directory (auto-detected from import.meta.url) */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Main JSON configuration file path (project root) */
export const CONFIG_DIR = PROJECT_ROOT;
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Zod schema for a single model tier in the tiered fallback system */
export const modelTierSchema = z.object({
  /** Display name for this tier (e.g. "旗舰推理", "高级推理", "通用能力", "轻量快速") */
  name: z.string(),
  /** Priority level: 0 = highest priority (tried first) */
  priority: z.number(),
  /** Ordered list of model display names within this tier */
  models: z.array(z.string()),
});

/** Zod schema for the complete models configuration (tiers + routing) */
export const modelsConfigSchema = z.object({
  /** Tiered model groups for structured fallback */
  tiers: z.array(modelTierSchema),
  /** Mapping from display model name to backend API model ID */
  routing: z.record(z.string(), z.string()),
});

/** Zod schema for individual project configurations */
export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  lastUsed: z.coerce.date().optional(),
});

/** Zod schema for overall UserConfig validation */
export const userConfigSchema = z.object({
  telegramBotToken: z.string(),
  allowedUsers: z.array(z.number()),
  model: z.string().optional(),
  proxy: z.string().optional(),
  notebookPath: z.string().optional(),
  geminiApiKey: z.string().optional(),
  deepseekApiKey: z.string().optional(),
  /** HTTP health endpoint port (optional). If set, starts a /health HTTP server. */
  healthPort: z.number().optional(),
  /**
   * Directory path for the /save command output (optional).
   * If not set, defaults to ~/Documents/Obsidian/Inbox.
   */
  savePath: z.string().optional(),
  /** Solidified project list (id/name/path/description). Kept in the local,
   *  gitignored config so personal directory paths never reach the remote repo. */
  projects: z.array(projectInfoSchema).optional(),
  /**
   * Custom file paths (optional). All default to CONFIG_DIR (project root).
   * Override any path to store data elsewhere.
   */
   paths: z.object({
    /** SQLite database file. Default: CONFIG_DIR/db.sqlite */
    db: z.string().optional(),
    /** Main daemon log file. Default: CONFIG_DIR/daemon.log */
    log: z.string().optional(),
    /** Error log file. Default: CONFIG_DIR/error.log */
    errorLog: z.string().optional(),
    /** Process ID file. Default: CONFIG_DIR/daemon.pid */
    pid: z.string().optional(),
    /** Notebook directory for /save output. Default: CONFIG_DIR/notebook */
    notebook: z.string().optional(),
    /** Scheduled tasks JSON file. Default: CONFIG_DIR/scheduled-tasks.json */
    scheduledTasks: z.string().optional(),
    /** Legacy agy conversations JSON file. Default: CONFIG_DIR/agy-conversations.json */
    agyConversations: z.string().optional(),
    /** agy CLI data directory (conversations, brain, OAuth token). Default: ~/.gemini/antigravity-cli */
    agyDataDir: z.string().optional(),
    /** Default browse root directory for /project_browse. Default: ~/Documents */
    browseRoot: z.string().optional(),
    /** Default inbox directory for saving responses. Default: ~/Documents/Obsidian/Inbox */
    inboxDir: z.string().optional(),
  }).optional(),
  /**
   * Custom model fallback order (optional). When set, overrides the hardcoded
   * ORDERED_MODELS array in messageLoop.ts. Each entry must be a model display
   * name as used by the fallback system (e.g. 'Claude Opus 4.6 (Thinking)',
   * 'Web2API: Gemini 3.5 Flash'). Models not present in this list are still
   * reachable but won't appear in the fallback chain.
   */
  orderedModels: z.array(z.string()).optional(),
  /**
   * Tiered models configuration (optional). When set, overrides the hardcoded
   * models.json and provides structured fallback with tier awareness.
   * Each tier groups models by capability level, and the fallback system
   * degrades tier-by-tier rather than model-by-model.
   */
  modelsConfig: modelsConfigSchema.optional(),
  /**
   * Backend service URLs for local proxy services.
   * Foreign users can skip by omitting the key entirely (the corresponding
   * model routes will not be available).
   */
  backends: z.object({
    /** Web2API reverse proxy URL. Default: http://127.0.0.1:8081/v1 */
    web2api: z.string().optional(),
    /** Web2API shared secret key. Default: sk-gemini-local */
    web2apiKey: z.string().optional(),
    /** DeepSeek API proxy URL. Default: http://127.0.0.1:5001/v1 */
    deepseek: z.string().optional(),
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
     * Default: 1000 (1 second) — balances smoothness and rate-limit safety.
     */
    debounceIntervalMs: z.number().optional(),
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
    modelRunHardTimeoutMs: z.number().optional(),
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
    modelRunInactivityMs: z.number().optional(),
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
    retriesPerModel: z.number().optional(),
    /**
     * Sliding window size for conversation history sent to web2api / deepseek / gemini-direct
     * backends. These backends don't maintain server-side conversation state, so the full
     * history must be sent with each request.
     *
     * - Lower values (e.g. 20):  Faster responses, less token usage, but less context.
     * - Higher values (e.g. 80): More context, but higher latency and token costs.
     *
     * Default: 40 — sufficient context for multi-turn conversations without excessive cost.
     */
    maxHistoryMessages: z.number().optional(),
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
    cacheTtlMs: z.number().optional(),
    /**
     * Maximum number of entries in the message cache. When the cache reaches this
     * limit, the least-recently-used entry is evicted to make room for new ones.
     *
     * - Lower values (e.g. 200):   Less memory usage, but evicts older messages faster.
     * - Higher values (e.g. 5000): More messages retained, but higher memory footprint.
     *
     * Default: 1000 — handles ~1000 messages/day with room for burst traffic.
     */
    cacheMaxSize: z.number().optional(),
  }).optional(),
});

/**
 * User configuration type inferred from Zod schema.
 */
export type UserConfig = z.infer<typeof userConfigSchema>;

// ── Path Resolvers ─────────────────────────────────────────────────────────
// All paths resolve from config.json `paths.*` fields, falling back to CONFIG_DIR.

function resolvePath(configPath: string | undefined, fallbackName: string): string {
  return configPath || path.join(CONFIG_DIR, fallbackName);
}

export function getDbPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.db, 'db.sqlite');
}

export function getLogPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.log, 'daemon.log');
}

export function getErrorLogPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.errorLog, 'error.log');
}

export function getPidPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.pid, 'daemon.pid');
}

export function getNotebookPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.notebook, 'notebook');
}

export function getScheduledTasksPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.scheduledTasks, 'scheduled-tasks.json');
}

export function getAgyConversationsPath(config?: UserConfig | null): string {
  return resolvePath(config?.paths?.agyConversations, 'agy-conversations.json');
}

/** Default tuning constants — used when config.tuning fields are omitted. */
export const TUNING_DEFAULTS = {
  debounceIntervalMs: 1000,
  modelRunHardTimeoutMs: 900_000,
  modelRunInactivityMs: 600_000,
  retriesPerModel: 3,
  maxHistoryMessages: 40,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  cacheMaxSize: 1000,
};

/**
 * Resolved tuning values: config overrides merged with defaults.
 */
export type TuningConfig = {
  debounceIntervalMs: number;
  modelRunHardTimeoutMs: number;
  modelRunInactivityMs: number;
  retriesPerModel: number;
  maxHistoryMessages: number;
  cacheTtlMs: number;
  cacheMaxSize: number;
};

let _cachedTuning: TuningConfig | undefined;

/** Default backend URLs — used when config.backends fields are omitted. */
export const BACKEND_URL_DEFAULTS = {
  web2api: 'http://127.0.0.1:8081/v1',
  deepseek: 'http://127.0.0.1:5001/v1',
  web2apiKey: 'sk-gemini-local',
};

/**
 * Returns the configured backend URL for a given service, falling back to defaults.
 * Returns null if neither config nor default is set (backend not available).
 */
export function getBackendUrl(service: 'web2api' | 'deepseek'): string | null {
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
  return cfg?.paths?.agyDataDir || AGY_DATA_DIR_DEFAULT;
}

const BROWSE_ROOT_DEFAULT = path.join(os.homedir(), 'Documents');

export function getBrowseRoot(): string {
  const cfg = loadUserConfig();
  return cfg?.paths?.browseRoot || BROWSE_ROOT_DEFAULT;
}

const INBOX_DIR_DEFAULT = path.join(os.homedir(), 'Documents', 'Obsidian', 'Inbox');

export function getInboxDir(): string {
  const cfg = loadUserConfig();
  return cfg?.paths?.inboxDir || cfg?.savePath || INBOX_DIR_DEFAULT;
}

/**
 * Clears the cached tuning configuration. Called on SIGHUP to force a fresh read
 * from disk on the next call to getTuningConfig().
 */
export function clearConfigCache(): void {
  _cachedTuning = undefined;
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

/**
 * Synchronously loads and parses the user configuration file from disk.
 * Validates strictly using userConfigSchema.
 * Returns null if the file does not exist or is malformed/invalid.
 */
export function loadUserConfig(): UserConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(content);
    return userConfigSchema.parse(parsed);
  } catch (e) {
    logger.warn(`[userConfig] Failed to load config.json: ${e instanceof Error ? e.message : e}. Falling back to defaults.`);
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
  fs.writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
}

