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
import { startTelegramDaemon } from './index.js';

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
  setup [step]         Run setup wizard (steps: token, users, model)

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
  const VALID_STEPS: SetupStep[] = ['token', 'users', 'model'];
  const step = args[1] as SetupStep | undefined;
  if (step && !VALID_STEPS.includes(step)) {
    console.error(`Unknown setup step: ${step}`);
    console.error(`Valid steps: ${VALID_STEPS.join(', ')}`);
    process.exit(1);
  }
  await runSetup(step);
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



// --- Live mode: run directly ---

const isLive =
  args.includes('--live') ||
  args.includes('-l') ||
  process.env['_GEMINI_CLI_TELEGRAM_DAEMON'] === '1';

if (isLive) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, process.pid.toString());

  // Redirect stdout/stderr to the canonical log file (append mode) so that
  // logs are always written to LOG_PATH regardless of how the process is
  // launched (systemd, nohup, or a terminal). This avoids the situation where
  // a stdio redirection (e.g. systemd StandardOutput=append:) holds a file
  // descriptor to a different inode than the on-disk log file after the log is
  // rotated/recreated, causing logs to silently disappear.
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  process.stdout.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stderr.write;

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
    proxy: config.proxy || process.env['HTTPS_PROXY'] || process.env['HTTP_PROXY'] || process.env['TELEGRAM_PROXY'],
  });
} else {
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
}
