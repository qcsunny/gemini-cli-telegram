#!/usr/bin/env node

/**
 * gemini-cli-telegram — Connect Gemini CLI to Telegram.
 */

// Suppress Node.js deprecation warnings from upstream dependencies
process.noDeprecation = true;
(process as unknown as { emitWarning: typeof process.emitWarning }).emitWarning = () => {};

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runSetup, type SetupStep } from './setup.js';
import {
  loadUserConfig,
  configExists,
  CONFIG_DIR,
  PID_PATH,
  LOG_PATH,
} from './config/userConfig.js';
import { startTelegramDaemon, runAuthProbe } from './index.js';
import {
  createAccount,
  switchAccount,
  listAccounts,
  deleteAccount,
  getCurrentAccount,
  uswAvailable,
} from './config/uswitch.js';

const args = process.argv.slice(2);
const command = args[0];

// --- Flags (checked before subcommands) ---

const helpText = `gemini-cli-telegram — Connect Gemini CLI to Telegram

Usage:
  gemini-cli-telegram <command> [options]

Commands:
  start                Start the daemon
  stop                 Stop the running daemon
  status               Check if the daemon is running
  logs                 Show recent daemon logs
  setup [step]         Run setup wizard (steps: token, users, model, auth)
  account              Manage USwitch accounts (create, switch, list, delete)

Account Commands:
  account create <name>   Create new isolated account via USwitch
  account switch <name>   Switch to account (switch Linux user)
  account list            List all USwitch accounts
  account delete <name>  Delete account and USwitch runtime
  account current        Show current account

Options:
  --live, -l           Run in foreground instead of backgrounding (with start)
  --help, -h           Show this help message
  --version, -v        Show version number`;

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(helpText);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

// --- Subcommands ---

if (command === 'setup') {
  const VALID_STEPS: SetupStep[] = ['token', 'users', 'model', 'auth', 'accounts'];
  const step = args[1] as SetupStep | undefined;
  if (step && !VALID_STEPS.includes(step)) {
    console.error(`Unknown setup step: ${step}`);
    console.error(`Valid steps: ${VALID_STEPS.join(', ')}`);
    process.exit(1);
  }
  await runSetup(step);
  process.exit(0);
}

if (command === 'account') {
  const accountCmd = args[1];
  const accountName = args[2];

  if (!uswAvailable()) {
    console.error('USwitch not found. Install with: sudo make install');
    console.error('Then run: gemini-cli-telegram setup');
    process.exit(1);
  }

  if (accountCmd === 'create' || accountCmd === 'add' || accountCmd === 'new') {
    if (!accountName) {
      console.error('Account name required: gemini-cli-telegram account create <name>');
      process.exit(1);
    }
    await createAccount(accountName);
    process.exit(0);
  }

  if (accountCmd === 'switch' || accountCmd === 'use' || accountCmd === 'sw') {
    if (!accountName) {
      console.error('Account name required: gemini-cli-telegram account switch <name>');
      process.exit(1);
    }
    await switchAccount(accountName);
    process.exit(0);
  }

  if (accountCmd === 'list' || accountCmd === 'ls' || accountCmd === 'ls') {
    const accounts = listAccounts();
    const current = getCurrentAccount();
    if (accounts.length === 0) {
      console.log('No USwitch accounts found.');
      console.log('Create one: gemini-cli-telegram account create <name>');
    } else {
      console.log('USwitch Accounts:');
      accounts.forEach(a => {
        const marker = a.name === current ? ' ●' : ' ○';
        console.log(`  ${a.name}${marker} (user: ${a.username})`);
      });
    }
    process.exit(0);
  }

  if (accountCmd === 'delete' || accountCmd === 'rm' || accountCmd === 'remove') {
    if (!accountName) {
      console.error('Account name required: gemini-cli-telegram account delete <name>');
      process.exit(1);
    }
    await deleteAccount(accountName);
    process.exit(0);
  }

  if (accountCmd === 'current' || accountCmd === 'whoami') {
    const current = getCurrentAccount();
    if (current) {
      console.log(`Current account: ${current}`);
    } else {
      console.log('Not in a USwitch account.');
      console.log('Switch to an account: gemini-cli-telegram account switch <name>');
    }
    process.exit(0);
  }

  console.log(`USwitch Account Commands:
  gemini-cli-telegram account create <name>  Create new account (USwitch runtime)
  gemini-cli-telegram account switch <name>  Switch to account (login as user)
  gemini-cli-telegram account list          List all accounts
  gemini-cli-telegram account delete <name> Delete account and USwitch runtime
  gemini-cli-telegram account current       Show current account
  `);
  process.exit(0);
}

if (command === 'stop') {
  if (!fs.existsSync(PID_PATH)) {
    console.log('No running daemon found.');
    process.exit(0);
  }
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_PATH);
    console.log(`Daemon (pid ${pid}) stopped.`);
  } catch {
    fs.unlinkSync(PID_PATH);
    console.log('Daemon was not running. Cleaned up stale pid file.');
  }
  process.exit(0);
}

if (command === 'status') {
  if (!fs.existsSync(PID_PATH)) {
    console.log('Daemon is not running.');
    process.exit(0);
  }
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0); // signal 0 = check if alive
    console.log(`Daemon is running (pid ${pid}).`);
  } catch {
    fs.unlinkSync(PID_PATH);
    console.log('Daemon is not running (cleaned up stale pid file).');
  }
  process.exit(0);
}

if (command === 'logs') {
  if (!fs.existsSync(LOG_PATH)) {
    console.log('No log file found.');
    process.exit(0);
  }
  // Tail the last 50 lines
  const content = fs.readFileSync(LOG_PATH, 'utf-8');
  const lines = content.split('\n');
  const tail = lines.slice(-50).join('\n');
  console.log(tail);
  process.exit(0);
}

// --- Unknown subcommand ---

if (command !== 'start') {
  console.error(`Unknown command: ${command}`);
  console.error(`Run 'gemini-cli-telegram --help' for usage.`);
  process.exit(1);
}

// --- Start daemon ---

if (!configExists()) {
  console.log('No configuration found. Running setup...\n');
  await runSetup();
  console.log();
}

const config = loadUserConfig();
if (!config) {
  console.error('Failed to load config. Run: gemini-cli-telegram setup');
  process.exit(1);
}

// Validate auth before backgrounding.
// Runs silently if auth is already configured.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const filterStderr = (chunk: string | Uint8Array): boolean => {
  const msg = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
  return msg.includes('GEMINI_API_KEY') || msg.includes('OAuth') || msg.includes('Falling back') || msg.includes('[INFO]');
};
process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: (() => void)): boolean => {
  if (filterStderr(chunk)) {
    if (typeof callback === 'function') callback();
    else if (typeof encoding === 'function') encoding();
    return true;
  }
  if (typeof encoding === 'function') {
    return originalStderrWrite(chunk, encoding as unknown as BufferEncoding, callback as unknown as (err?: Error | null) => void);
  }
  return originalStderrWrite(chunk, encoding as BufferEncoding, callback as unknown as (err?: Error | null) => void);
}) as typeof process.stderr.write;
try {
  await runAuthProbe();
} catch (e) {
  process.stderr.write = originalStderrWrite;
  console.error(`Authentication failed: ${e instanceof Error ? e.message : String(e)}`);
  console.error('Run: gemini-cli-telegram setup auth');
  process.exit(1);
}
process.stderr.write = originalStderrWrite;

// --- Live mode: run directly ---

const isLive =
  args.includes('--live') ||
  args.includes('-l') ||
  process.env['_GEMINI_CLI_TELEGRAM_DAEMON'] === '1';

if (isLive) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, process.pid.toString());

  const cleanup = () => {
    try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
  };
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });

  await startTelegramDaemon({
    token: config.telegramBotToken,
    model: config.model,
    allowedUsers: config.allowedUsers,
    cwd: process.cwd(),
  });

  process.exit(0);
}

// --- Background mode (default): spawn detached child ---

if (fs.existsSync(PID_PATH)) {
  const existingPid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
  try {
    process.kill(existingPid, 0);
    console.log(`Daemon is already running (pid ${existingPid}). Use 'gemini-cli-telegram stop' first.`);
    process.exit(1);
  } catch {
    // Stale pid file, continue
  }
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
const logFd = fs.openSync(LOG_PATH, 'a');

const scriptPath = path.resolve(
  new URL(import.meta.url).pathname,
);

const child = spawn(process.execPath, ['--no-warnings', scriptPath, 'start', '--live'], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    _GEMINI_CLI_TELEGRAM_DAEMON: '1',
    NODE_NO_WARNINGS: '1',
  },
  cwd: process.cwd(),
});

child.unref();
fs.closeSync(logFd);

console.log(`Daemon started in background (pid ${child.pid}).`);
console.log(`Logs: ${LOG_PATH}`);
console.log(`Stop:  gemini-cli-telegram stop`);

// Show the bot's Telegram link
try {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`);
  const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (data.ok && data.result?.username) {
    console.log(`\nChat: https://t.me/${data.result.username}`);
  }
} catch { /* ignore — non-critical */ }

process.exit(0);
