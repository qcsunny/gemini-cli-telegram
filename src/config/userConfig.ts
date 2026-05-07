/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.gemini-cli-telegram');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
export const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');

export interface Account {
  name: string;
  type: 'api_key' | 'oauth';
  apiKey?: string;
}

export interface UserConfig {
  telegramBotToken: string;
  allowedUsers: number[];
  model?: string;
  accounts?: Account[];
  activeAccountName?: string;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadUserConfig(): UserConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(content) as UserConfig;
}

export function saveUserConfig(config: UserConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const content = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
}

export function getAccounts(): Account[] {
  const config = loadUserConfig();
  return config?.accounts || [];
}

export function getActiveAccount(): Account | null {
  const config = loadUserConfig();
  if (!config || !config.accounts || !config.activeAccountName) return null;
  return config.accounts.find(a => a.name === config.activeAccountName) || null;
}

export function setActiveAccount(name: string): void {
  const config = loadUserConfig();
  if (config) {
    config.activeAccountName = name;
    saveUserConfig(config);
  }
}

export function addAccount(account: Account): void {
  const config = loadUserConfig();
  if (config) {
    if (!config.accounts) config.accounts = [];
    config.accounts = config.accounts.filter(a => a.name !== account.name);
    config.accounts.push(account);
    if (!config.activeAccountName) config.activeAccountName = account.name;
    saveUserConfig(config);
  }
}

export function removeAccount(name: string): void {
  const config = loadUserConfig();
  if (config && config.accounts) {
    config.accounts = config.accounts.filter(a => a.name !== name);
    if (config.activeAccountName === name) {
      config.activeAccountName = config.accounts[0]?.name;
    }
    saveUserConfig(config);
    
    const oauthPath = path.join(ACCOUNTS_DIR, `${name}.json`);
    if (fs.existsSync(oauthPath)) {
      fs.unlinkSync(oauthPath);
    }
  }
}

export function saveAccountOAuth(name: string, content: string): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const oauthPath = path.join(ACCOUNTS_DIR, `${name}.json`);
  fs.writeFileSync(oauthPath, content, { mode: 0o600 });
}

export function loadAccountOAuth(name: string): string | null {
  const oauthPath = path.join(ACCOUNTS_DIR, `${name}.json`);
  if (!fs.existsSync(oauthPath)) return null;
  return fs.readFileSync(oauthPath, 'utf-8');
}
