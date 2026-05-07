/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const USW_BIN = '/usr/local/bin/usw';

export interface USwitchAccount {
  name: string;
  username: string;
  type: 'oauth' | 'api_key';
  createdAt: string;
}

const ACCOUNTS_METADATA_PATH = path.join(os.homedir(), '.gemini-cli-telegram', 'uswitch-accounts.json');

function loadAccountsMetadata(): USwitchAccount[] {
  if (!fs.existsSync(ACCOUNTS_METADATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_METADATA_PATH, 'utf-8'));
}

function saveAccountsMetadata(accounts: USwitchAccount[]): void {
  fs.mkdirSync(path.dirname(ACCOUNTS_METADATA_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNTS_METADATA_PATH, JSON.stringify(accounts, null, 2) + '\n');
}

export function uswAvailable(): boolean {
  try {
    return fs.existsSync(USW_BIN);
  } catch {
    return false;
  }
}

export async function createAccount(name: string, oauthJson?: string): Promise<void> {
  if (!uswAvailable()) {
    throw new Error('USwitch not installed. Install with: sudo make install');
  }

  const accounts = loadAccountsMetadata();
  if (accounts.find(a => a.name === name)) {
    throw new Error(`Account "${name}" already exists. Use "account switch ${name}" to activate.`);
  }

  console.log(`Creating USwitch runtime for "${name}"...`);
  
  try {
    execSync(`${USW_BIN} create ${name}`, { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`Failed to create USwitch runtime: ${e instanceof Error ? e.message : String(e)}`);
  }

  const username = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const userHome = `/home/${username}`;
  const userGeminiDir = path.join(userHome, '.gemini');
  const userConfigDir = path.join(userHome, '.gemini-cli-telegram');

  fs.mkdirSync(userGeminiDir, { recursive: true });
  fs.mkdirSync(userConfigDir, { recursive: true });

  if (oauthJson) {
    fs.writeFileSync(path.join(userGeminiDir, 'oauth_creds.json'), oauthJson, { mode: 0o600 });
  }

  fs.chmodSync(path.join(userGeminiDir, 'oauth_creds.json'), 0o600);
  fs.chmodSync(userConfigDir, 0o700);

  const account: USwitchAccount = {
    name,
    username,
    type: oauthJson ? 'oauth' : 'oauth',
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  saveAccountsMetadata(accounts);

  console.log(`\nAccount "${name}" created successfully!`);
  console.log(`Username: ${username}`);
  console.log(`Home: ${userHome}`);
}

export async function switchAccount(name: string): Promise<void> {
  if (!uswAvailable()) {
    throw new Error('USwitch not installed. Install with: sudo make install');
  }

  const accounts = loadAccountsMetadata();
  const account = accounts.find(a => a.name === name);
  if (!account) {
    throw new Error(`Account "${name}" not found. Create with: gemini-cli-telegram account create ${name}`);
  }

  console.log(`Switching to account "${name}"...`);
  console.log(`This will switch to Linux user: ${account.username}`);
  console.log('');

  try {
    execSync(`${USW_BIN} ${account.username}`, { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`Failed to switch account: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function listAccounts(): USwitchAccount[] {
  return loadAccountsMetadata();
}

export async function deleteAccount(name: string): Promise<void> {
  if (!uswAvailable()) {
    throw new Error('USwitch not installed. Install with: sudo make install');
  }

  const accounts = loadAccountsMetadata();
  const account = accounts.find(a => a.name === name);
  if (!account) {
    throw new Error(`Account "${name}" not found.`);
  }

  console.log(`Deleting account "${name}" and USwitch runtime...`);

  try {
    execSync(`${USW_BIN} destroy ${account.username}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`Warning: Failed to delete USwitch runtime: ${e instanceof Error ? e.message : String(e)}`);
  }

  const newAccounts = accounts.filter(a => a.name !== name);
  saveAccountsMetadata(newAccounts);

  console.log(`Account "${name}" deleted.`);
}

export function getCurrentAccount(): string | null {
  const username = os.userInfo().username;
  const accounts = loadAccountsMetadata();
  const account = accounts.find(a => a.username === username);
  return account?.name || null;
}