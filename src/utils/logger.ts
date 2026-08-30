/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file logger.ts
 * @description Structured Pino logger utility with pino-pretty support in development/TTY environments.
 * Log levels: debug < info < warn < error (controlled via process.env.LOG_LEVEL).
 *
 * Production mode (daemon): pino writes directly to log files under `logs/`.
 *   - logs/daemon.log  ← info + warn
 *   - logs/error.log   ← error only
 *   Systemd should NOT use StandardOutput/StandardError redirects.
 *   Both files rotate in-process by size (LOG_MAX_BYTES / LOG_KEEP_FILES) — the
 *   daemon holds the fd open, so an external logrotate would need copytruncate.
 *
 * Dev mode (TTY/test): pino-pretty to stdout (no file output).
 */

import pino from 'pino';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev =
  process.env['NODE_ENV'] === 'development' ||
  process.env['NODE_ENV'] === 'test' ||
  Boolean(process.stdout.isTTY) ||
  !process.env['NODE_ENV'];

const level = process.env['LOG_LEVEL'] || 'info';

/**
 * Log paths. Inlined (not read from userConfig) to avoid a circular dependency:
 * userConfig → logger → userConfig would leave CONFIG_DIR undefined.
 *
 * Everything lives in `logs/` rather than the project root so the root stays
 * readable — override the directory with LOG_DIR (absolute or root-relative).
 * The TEST_* overrides let tests aim at a temp dir instead, so they never unlink
 * the live logs the running daemon holds an fd on (which would silently orphan
 * the daemon's writes to a deleted inode).
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const LOG_DIR = process.env['LOG_DIR']
  ? path.resolve(PROJECT_ROOT, process.env['LOG_DIR'])
  : path.join(PROJECT_ROOT, 'logs');

export const ERROR_LOG_PATH = process.env['TEST_ERROR_LOG_PATH'] || path.join(LOG_DIR, 'error.log');
export const DAEMON_LOG_PATH = process.env['TEST_DAEMON_LOG_PATH'] || path.join(LOG_DIR, 'daemon.log');

/** Reads a non-negative integer env knob, falling back on empty/garbage values. */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Rotate a log file once it grows past this size. `0` disables rotation. */
const LOG_MAX_BYTES = envInt(process.env['LOG_MAX_BYTES'], 16 * 1024 * 1024);
/** How many rotated generations to keep (`daemon.log.1` … `.N`). */
const LOG_KEEP_FILES = Math.max(1, envInt(process.env['LOG_KEEP_FILES'], 3));

/** Minimal sink interface pino's multistream needs. */
interface LogSink {
  write(chunk: string): boolean;
}

/**
 * Append-only sink that rotates `filePath` by size, keeping `keep` generations.
 *
 * Rotation renames the current file to `.1` (shifting older generations up) and
 * reopens a fresh fd. The old stream is `end()`ed *after* the rename, so buffered
 * bytes land in the rotated file rather than being lost — on POSIX the fd follows
 * the inode, not the name.
 *
 * The initial size is read from disk so a daemon restart resumes the existing
 * file's budget instead of restarting the count at zero.
 *
 * Exported for unit tests; production code uses it via `pinoInstance`.
 */
export function createRotatingStream(
  filePath: string,
  opts: { maxBytes?: number; keep?: number } = {},
): LogSink {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? LOG_KEEP_FILES);

  const open = (): fs.WriteStream | null => {
    let fd: number;
    try {
      // Only runs on construction and once per rotation, so the mkdir is not on
      // the per-line path. Repeated here rather than hoisted so a log dir that
      // gets removed underneath us is recreated on the next rotation.
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Open eagerly: createWriteStream(path) opens on a later tick, so a rotation
      // in the same tick as construction would rename a file that does not exist yet.
      fd = fs.openSync(filePath, 'a');
    } catch (e) {
      process.stderr.write(`[logger] cannot open ${filePath}: ${String(e)}\n`);
      return null;
    }
    const s = fs.createWriteStream(filePath, { fd, autoClose: true });
    // Without a listener an EIO/ENOSPC 'error' event is unhandled and takes the
    // whole daemon down (index.ts turns uncaughtException into a shutdown).
    s.on('error', (e) => {
      process.stderr.write(`[logger] write failed on ${filePath}: ${String(e)}\n`);
    });
    return s;
  };

  let stream = open();
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    /* file does not exist yet → size stays 0 */
  }

  const rotate = (): void => {
    // .N is dropped, .N-1 → .N, …, .1 → .2, then current → .1
    for (let i = keep; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      try {
        if (!fs.existsSync(from)) continue;
        if (i === keep) fs.unlinkSync(from);
        else fs.renameSync(from, `${filePath}.${i + 1}`);
      } catch {
        /* a single generation failing to shift must not stop rotation */
      }
    }
    const previous = stream;
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
    stream = open();
    size = 0;
    // end() after the rename so buffered bytes land in the rotated file: on POSIX
    // the fd follows the inode, not the name.
    previous?.end();
  };

  return {
    write(chunk: string): boolean {
      const bytes = Buffer.byteLength(chunk);
      if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
        try {
          rotate();
        } catch (e) {
          // Keep logging to the oversized file rather than dropping the line.
          process.stderr.write(`[logger] rotation failed for ${filePath}: ${String(e)}\n`);
        }
      }
      size += bytes;
      if (!stream) {
        process.stderr.write(chunk);
        return true;
      }
      return stream.write(chunk);
    },
  };
}

/**
 * Extracts pino's numeric level from a serialized log line without parsing the
 * whole record. Pino always serializes `level` first, so the fast path is a
 * prefix read; the regex only covers a custom serializer changing that order.
 */
function readLevel(entry: string): number {
  if (entry.startsWith('{"level":')) {
    const end = entry.indexOf(',', 9);
    const n = Number(entry.slice(9, end === -1 ? undefined : end));
    if (Number.isFinite(n)) return n;
  }
  const m = /"level":(\d+)/.exec(entry.slice(0, 256));
  return m?.[1] ? Number(m[1]) : Number.NaN;
}

/**
 * Stream wrapper: only passes info(30) and warn(40) to destination, skips error(50+).
 *
 * A record whose level cannot be read is forwarded rather than dropped — losing a
 * line is worse than duplicating it, and the previous `JSON.parse` threw inside
 * pino's write path on any malformed entry.
 */
function createInfoWarnStream(dest: LogSink): LogSink {
  return {
    write(entry: string): boolean {
      const level = readLevel(entry);
      if (Number.isFinite(level) && level >= 50) return true;
      return dest.write(entry);
    },
  };
}

/**
 * Log timestamp in the machine's local time zone (system time), e.g.
 * `2026-08-30T14:58:06.349+08:00` on Asia/Shanghai.
 *
 * `toISOString()` always renders the UTC clock reading, so the local offset
 * suffix can only be appended after shifting the reading to local wall time —
 * otherwise every line claims `+08:00` while showing UTC digits, putting the
 * whole log 8 hours behind the system clock.
 */
export function localIsoTimestamp(date = new Date()): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const localWallClock = new Date(date.getTime() + offsetMin * 60_000);
  return localWallClock.toISOString().replace('Z', `${sign}${offset}`);
}

/**
 * Underlying Pino logger instance.
 *
 * - Dev mode: pino-pretty transport → stdout (colorized, human-readable).
 * - Prod mode: multistream → logs/daemon.log (info+warn) + logs/error.log (error
 *   only), both size-rotating. Systemd service must NOT redirect stdout/stderr.
 */
export const pinoInstance = (() => {
  if (isDev) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  const destDaemon = createRotatingStream(DAEMON_LOG_PATH);
  const destError = createRotatingStream(ERROR_LOG_PATH);

  return pino(
    {
      level,
      timestamp: () => `,"time":"${localIsoTimestamp()}"`,
      base: { pid: process.pid },
    },
    pino.multistream([
      { stream: createInfoWarnStream(destDaemon), level: 'info' },
      { stream: destError, level: 'error' },
    ]),
  );
})();

/**
 * Flush buffered log writes so nothing is lost on graceful shutdown.
 * Best-effort: prod mode flushes the pino streams; dev mode is a no-op.
 */
export async function flushLogs(): Promise<void> {
  try {
    if (!isDev) {
      pinoInstance.flush();
    }
  } catch {
    // best-effort — never block shutdown on logging
  }
}

/**
 * Helper to combine message string and variadic arguments for backward compatibility.
 */
function formatMsg(message: unknown, args: unknown[]): string {
  const primary = typeof message === 'string' ? message : String(message);
  if (args.length === 0) return primary;
  const extra = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  return `${primary} ${extra}`;
}

/**
 * Shared application logger wrapper.
 * Maps legacy logger methods (debug, info, warn, error) to Pino.
 */
export const logger = {
  pino: pinoInstance,
  debug: (message: unknown, ...args: unknown[]) => {
    if (pinoInstance.isLevelEnabled('debug')) {
      pinoInstance.debug(formatMsg(message, args));
    }
  },
  info: (message: unknown, ...args: unknown[]) => {
    if (pinoInstance.isLevelEnabled('info')) {
      pinoInstance.info(formatMsg(message, args));
    }
  },
  warn: (message: unknown, ...args: unknown[]) => {
    if (pinoInstance.isLevelEnabled('warn')) {
      pinoInstance.warn(formatMsg(message, args));
    }
  },
  error: (message: unknown, ...args: unknown[]) => {
    if (pinoInstance.isLevelEnabled('error')) {
      pinoInstance.error(formatMsg(message, args));
    }
  },
};
