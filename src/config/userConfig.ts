/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file userConfig.ts
 * @description Manages persistence and loading of the daemon's local configuration (~/.gemini-cli-telegram/config.json).
 * Handles Telegram bot token, user whitelist, default model, proxy settings, and project list.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

/** Base directory for daemon configuration and runtime files (~/.gemini-cli-telegram) */
export const CONFIG_DIR = path.join(os.homedir(), '.gemini-cli-telegram');
/** Main JSON configuration file path */
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
/** Process ID file path for daemon tracking */
export const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
/** Canonical log output file path */
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');

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
  /** Solidified project list (id/name/path/description). Kept in the local,
   *  gitignored config so personal directory paths never reach the remote repo. */
  projects: z.array(projectInfoSchema).optional(),
});

/**
 * User configuration type inferred from Zod schema.
 */
export type UserConfig = z.infer<typeof userConfigSchema>;

/**
 * Checks whether the configuration file exists on disk.
 */
export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

/**
 * Synchronously loads and parses the user configuration file from disk.
 * Validates strictly using userConfigSchema.
 * Returns null if the file does not exist.
 */
export function loadUserConfig(): UserConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(content);
  return userConfigSchema.parse(parsed);
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

