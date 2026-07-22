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
import type { ProjectInfo } from '../core/types.js';

/** Base directory for daemon configuration and runtime files (~/.gemini-cli-telegram) */
export const CONFIG_DIR = path.join(os.homedir(), '.gemini-cli-telegram');
/** Main JSON configuration file path */
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
/** Process ID file path for daemon tracking */
export const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
/** Canonical log output file path */
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');

/**
 * User configuration interface defining bot settings and environment preferences.
 */
export interface UserConfig {
  telegramBotToken: string;
  allowedUsers: number[];
  model?: string;
  proxy?: string;
  notebookPath?: string;
  geminiApiKey?: string;
  deepseekApiKey?: string;
  /** Solidified project list (id/name/path/description). Kept in the local,
   *  gitignored config so personal directory paths never reach the remote repo. */
  projects?: ProjectInfo[];
}

/**
 * Checks whether the configuration file exists on disk.
 */
export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

/**
 * Synchronously loads and parses the user configuration file from disk.
 * Returns null if the file does not exist.
 */
export function loadUserConfig(): UserConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(content) as UserConfig;
}

/**
 * Saves the given UserConfig object to disk with restrictive file permissions (0600).
 *
 * @param config - The UserConfig object to save.
 */
export function saveUserConfig(config: UserConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const content = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
}

