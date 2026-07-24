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
 * Production mode (daemon): pino writes directly to log files.
 *   - daemon.log  ← info + warn
 *   - error.log   ← error only
 *   Systemd should NOT use StandardOutput/StandardError redirects.
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
 * Path to error.log file. Inlined to avoid circular dependency with userConfig.ts
 * (userConfig → logger → userConfig would cause CONFIG_DIR to be undefined).
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ERROR_LOG_PATH = path.join(PROJECT_ROOT, 'error.log');
export const DAEMON_LOG_PATH = path.join(PROJECT_ROOT, 'daemon.log');

/**
 * Simple stream wrapper: only passes info(30) and warn(40) to destination, skips error(50+).
 */
function createInfoWarnStream(dest: fs.WriteStream) {
  return {
    write(entry: string | object) {
      const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
      if (obj.level < 50) {
        dest.write(typeof entry === 'string' ? entry : JSON.stringify(obj) + '\n');
      }
      return true;
    },
  };
}

/**
 * Underlying Pino logger instance.
 *
 * - Dev mode: pino-pretty transport → stdout (colorized, human-readable).
 * - Prod mode: multistream → daemon.log (info+warn) + error.log (error only).
 *   Systemd service must NOT redirect stdout/stderr.
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

  const destDaemon = fs.createWriteStream(DAEMON_LOG_PATH, { flags: 'a' });
  const destError = fs.createWriteStream(ERROR_LOG_PATH, { flags: 'a' });

  return pino(
    { level },
    pino.multistream([
      { stream: createInfoWarnStream(destDaemon), level: 'info' },
      { stream: destError, level: 'error' },
    ]),
  );
})();

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
