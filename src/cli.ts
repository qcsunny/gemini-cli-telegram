#!/usr/bin/env node

/**
 * @file cli.ts
 * @description Command-line executable entry point (`gemini-cli-telegram`).
 * Handles CLI command routing using Commander for starting/stopping the daemon,
 * checking status, tailing logs, running the setup wizard, and spawning background
 * detached processes vs running in foreground (--live).
 */

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
import { systemdOwnerForPid, systemdRefusalMessage } from './utils/systemdUnit.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Verify a PID actually refers to this project's daemon process, not just any
 * live process that happened to be assigned the same recycled PID.
 * Reads /proc/<pid>/cmdline (Linux) as an extra identity check.
 */
function isOurDaemonPid(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return cmdline.includes('cli.js') || cmdline.includes('gemini-cli-telegram') || cmdline.includes('dist/cli');
  } catch {
    // /proc unavailable (non-Linux) — fall back to the plain liveness check only.
    return true;
  }
}

/** Check whether pid points to our (or any) live process. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePidLock(pidPath: string): boolean {
  try {
    const fd = fs.openSync(pidPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

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

    const isLive =
      options.live ||
      process.env['_GEMINI_CLI_TELEGRAM_DAEMON'] === '1';

    // Unified singleton check for both live and background modes
    if (fs.existsSync(pidPath)) {
      try {
        const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        if (!(Number.isInteger(existingPid) && existingPid > 0)) {
          console.error(`[PID CHECK] Invalid pid file content: ${fs.readFileSync(pidPath, 'utf-8').trim()}`);
          console.error(`[PID CHECK] Removing invalid pid file and continuing...`);
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
        } else if (pidIsAlive(existingPid) && isOurDaemonPid(existingPid)) {
          // A systemd-owned instance is already serving. Starting a second one
          // races for the same Telegram token (409 Conflict); in --live mode the
          // PID-lock handover below would also stall for 60s before failing.
          const owner = systemdOwnerForPid(existingPid);
          if (owner) {
            console.error(systemdRefusalMessage(existingPid, owner, 'restart'));
            process.exit(1);
          }
          if (!isLive) {
            console.error(`Daemon is already running (pid ${existingPid}). Use 'gemini-cli-telegram stop' first.`);
            process.exit(1);
          }
        } else if (pidIsAlive(existingPid)) {
          // PID is alive but belongs to a different process (PID reused or a
          // foreign Daemon). Never kill it — treat the pid file as stale.
          console.error(`[PID CHECK] pid ${existingPid} is alive but not this daemon. Treating pid file as stale and continuing...`);
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
        } else {
          console.error(`[PID CHECK] Stale pid file detected: ${pidPath}, content: ${existingPid}`);
          console.error(`[PID CHECK] Removing stale pid file and continuing...`);
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
        }
      } catch (err) {
        console.error(`[PID CHECK] Error reading pid file: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    // Atomic PID lock: only one process can ever hold it
    if (isLive) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      if (!acquirePidLock(pidPath)) {
        try {
          const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
          process.kill(existingPid, 0);
          console.error(`Daemon already running (pid ${existingPid}). Waiting up to 60s for graceful handover...`);
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            if (acquirePidLock(pidPath)) break;
            try {
              const content = fs.readFileSync(pidPath, 'utf-8').trim();
              const pid = parseInt(content, 10);
              process.kill(pid, 0);
              await sleep(2000);
            } catch {
              await sleep(3000);
              try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
              if (acquirePidLock(pidPath)) break;
            }
          }
          if (!acquirePidLock(pidPath)) {
            console.error('Could not acquire PID lock within 60s. Another instance may still be running.');
            process.exit(1);
          }
          console.log('PID lock acquired. Starting daemon...');
        } catch {
          try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
          if (!acquirePidLock(pidPath)) {
            console.error('Failed to acquire PID lock.');
            process.exit(1);
          }
        }
      }

      const livePath = getLogPath(config);
      fs.mkdirSync(path.dirname(livePath), { recursive: true });
      const logStream = fs.createWriteStream(livePath, { flags: 'a' });
      process.stdout.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => logStream.write(chunk)) as typeof process.stderr.write;

      // Flush the log stream before exiting so redirected buffers aren't lost.
      process.once('exit', () => {
        try { logStream.end(); } catch { /* ignore */ }
      });

      // SIGTERM/SIGINT: delete PID, let index.ts drain bot and exit
      process.once('SIGTERM', () => { try { fs.unlinkSync(pidPath); } catch { /* ignore */ } });
      process.once('SIGINT', () => { try { fs.unlinkSync(pidPath); } catch { /* ignore */ } });

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
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
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
      } catch (e) {
        console.warn(`Could not fetch bot username from Telegram (bot may need a moment): ${e instanceof Error ? e.message : e}`);
      }

      process.exit(0);
    }
  });

  program
    .command('check-pid')
    .description('Check daemon.pid status without starting')
    .action(() => {
      const pidPath = getPidPath();
      if (!fs.existsSync(pidPath)) {
        console.log('[PID CHECK] No daemon.pid file found. Daemon is not running.');
        process.exit(0);
      }

      try {
        const pidContent = fs.readFileSync(pidPath, 'utf-8').trim();
        const pid = parseInt(pidContent, 10);

        if (isNaN(pid)) {
          console.error(`[PID CHECK] Invalid pid file content: "${pidContent}"`);
          process.exit(1);
        }

        console.log(`[PID CHECK] Found daemon.pid: ${pid}`);

        try {
          if (!pidIsAlive(pid)) throw Object.assign(new Error(), { code: 'ESRCH' });
          if (!isOurDaemonPid(pid)) {
            console.error(`[PID CHECK] Process ${pid} is alive but is NOT this daemon (PID was reused).`);
            console.error(`[PID CHECK] Treating pid file as stale. Remove it: rm ${pidPath}`);
            process.exit(1);
          }
          console.log(`[PID CHECK] Process ${pid} is running (verified)`);
          console.log(`[PID CHECK] Daemon is running. Use 'gemini-cli-telegram stop' to stop it.`);
          process.exit(0);
        } catch (killErr: unknown) {
          const errorCode = typeof killErr === 'object' && killErr !== null && 'code' in killErr
            ? (killErr.code as string | undefined)
            : undefined;
          if (errorCode === 'ESRCH') {
            console.error(`[PID CHECK] Process ${pid} is not running (ESRCH)`);
            console.error(`[PID CHECK] Stale pid file detected. Remove it manually: rm ${pidPath}`);
            console.error(`[PID CHECK] Or run: gemini-cli-telegram stop`);
            process.exit(1);
          } else {
            console.error(`[PID CHECK] Failed to check process status: ${errorCode ?? 'unknown error'}`);
            process.exit(1);
          }
        }
      } catch (err) {
        console.error(`[PID CHECK] Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
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
    const rawPid = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(rawPid, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`Invalid PID in ${pidPath}: "${rawPid}". Cleaning up stale pid file.`);
      try { fs.unlinkSync(pidPath); } catch {}
      process.exit(1);
    }
    if (pidIsAlive(pid) && !isOurDaemonPid(pid)) {
      // The pid is alive but NOT our daemon (PID recycled by another process).
      // Do NOT send signals to it — just remove the stale pid file.
      console.error(`[stop] pid ${pid} is alive but not this daemon. Removing stale pid file without killing it.`);
      fs.unlinkSync(pidPath);
      process.exit(0);
    }
    // Never SIGTERM a systemd-owned daemon: the unit would exit 0/SUCCESS, which
    // Restart=on-failure does not restart, leaving the bot silently offline.
    const stopOwner = systemdOwnerForPid(pid);
    if (stopOwner) {
      console.error(systemdRefusalMessage(pid, stopOwner, 'stop'));
      process.exit(1);
    }
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
    const rawPid = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(rawPid, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`Invalid PID in ${pidPath}: "${rawPid}". Cleaning up stale pid file.`);
      try { fs.unlinkSync(pidPath); } catch {}
      process.exit(1);
    }
    if (!pidIsAlive(pid)) {
      fs.unlinkSync(pidPath);
      console.log('Daemon is not running (cleaned up stale pid file).');
      process.exit(0);
    }
    if (!isOurDaemonPid(pid)) {
      console.error(`Daemon is not running (pid ${pid} is alive but not this daemon; removed stale pid file).`);
      fs.unlinkSync(pidPath);
      process.exit(0);
    }
    console.log(`Daemon is running (pid ${pid}).`);
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
