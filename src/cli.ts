#!/usr/bin/env node

/**
 * @file cli.ts
 * @description Command-line executable entry point (`gemini-cli-telegram`).
 * Handles CLI command routing using Commander for starting/stopping the daemon,
 * checking status, tailing logs, running the setup wizard, and spawning background
 * detached processes vs running in foreground (--live).
 */

// Suppress Node.js deprecation warnings from upstream dependencies
process.noDeprecation = true;

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { runSetup, type SetupStep } from './setup.js';
import {
  loadUserConfig,
  configExists,
  CONFIG_DIR,
  getPidPath,
  getLogPath,
} from './config/userConfig.js';
import { startTelegramDaemon } from './index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('gemini-cli-telegram')
  .description('Connect Gemini CLI to Telegram')
  .version(pkg.version, '-v, --version', 'Show version number');

program
  .command('start')
  .description('Start the daemon')
  .option('-l, --live', 'Run in foreground instead of backgrounding')
  .action(async (options: { live?: boolean }) => {
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

    const pidPath = getPidPath(config);

    // Unified singleton check for both live and background modes
    if (fs.existsSync(pidPath)) {
      try {
        const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(existingPid, 0); // Check if process is alive
        console.error(`Daemon is already running (pid ${existingPid}). Use 'gemini-cli-telegram stop' first.`);
        process.exit(1);
      } catch {
        // Stale pid file, remove it and continue
        try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
      }
    }

    const isLive =
      options.live ||
      process.env['_GEMINI_CLI_TELEGRAM_DAEMON'] === '1';

    try {
      fs.writeFileSync('/tmp/cli_debug.log', JSON.stringify({ options, argv: process.argv, isLive, env: process.env['_GEMINI_CLI_TELEGRAM_DAEMON'] }, null, 2));
    } catch {}

    if (isLive) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(pidPath, process.pid.toString());

      const logStream = fs.createWriteStream(getLogPath(config), { flags: 'a' });
      process.stdout.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stderr.write;

      const cleanup = () => {
        try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
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
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const logPath = getLogPath(config);
      const logFd = fs.openSync(logPath, 'a');
      const errFd = fs.openSync(logPath + '.err', 'a');

      const scriptPath = path.resolve(
        new URL(import.meta.url).pathname,
      );

      const child = spawn(process.execPath, ['--no-warnings', scriptPath, 'start', '--live'], {
        detached: true,
        stdio: ['ignore', logFd, errFd],
        env: {
          ...process.env,
          _GEMINI_CLI_TELEGRAM_DAEMON: '1',
          NODE_NO_WARNINGS: '1',
        },
        cwd: process.cwd(),
      });

      child.unref();
      fs.closeSync(logFd);
      fs.closeSync(errFd);

      console.log(`Daemon started in background (pid ${child.pid}).`);
      console.log(`Logs: ${logPath}`);
      console.log(`Errors: ${logPath}.err`);
      console.log(`Stop:  gemini-cli-telegram stop`);

      try {
        const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`);
        const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
        if (data.ok && data.result?.username) {
          console.log(`\nChat: https://t.me/${data.result.username}`);
        }
      } catch { /* ignore — non-critical */ }

      process.exit(0);
    }
  });

program
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    const pidPath = getPidPath();
    if (!fs.existsSync(pidPath)) {
      console.log('No running daemon found.');
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(pidPath);
      console.log(`Daemon (pid ${pid}) stopped.`);
    } catch {
      fs.unlinkSync(pidPath);
      console.log('Daemon was not running. Cleaned up stale pid file.');
    }
    process.exit(0);
  });

program
  .command('status')
  .description('Check if the daemon is running')
  .action(() => {
    const pidPath = getPidPath();
    if (!fs.existsSync(pidPath)) {
      console.log('Daemon is not running.');
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0); // signal 0 = check if alive
      console.log(`Daemon is running (pid ${pid}).`);
    } catch {
      fs.unlinkSync(pidPath);
      console.log('Daemon is not running (cleaned up stale pid file).');
    }
    process.exit(0);
  });

program
  .command('logs')
  .description('Show recent daemon logs')
  .action(() => {
    const logPath = getLogPath();
    if (!fs.existsSync(logPath)) {
      console.log('No log file found.');
      process.exit(0);
    }
    // Tail the last 50 lines
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-50).join('\n');
    console.log(tail);
    process.exit(0);
  });

program
  .command('setup')
  .description('Run setup wizard (steps: token, users, model, auth)')
  .argument('[step]', 'Setup step (token, users, model, auth)')
  .action(async (step?: string) => {
    const VALID_STEPS: SetupStep[] = ['token', 'users', 'model', 'auth'];
    if (step && !VALID_STEPS.includes(step as SetupStep)) {
      console.error(`Unknown setup step: ${step}`);
      console.error(`Valid steps: ${VALID_STEPS.join(', ')}`);
      process.exit(1);
    }
    await runSetup(step as SetupStep | undefined);
    process.exit(0);
  });

// Handle default case with no subcommands: print help
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

await program.parseAsync(process.argv);
