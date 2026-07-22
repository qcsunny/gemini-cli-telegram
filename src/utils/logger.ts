/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file logger.ts
 * @description Structured Pino logger utility with pino-pretty support in development/TTY environments.
 * Log levels: debug < info < warn < error (controlled via process.env.LOG_LEVEL).
 */

import pino from 'pino';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const isDev =
  process.env['NODE_ENV'] === 'development' ||
  process.env['NODE_ENV'] === 'test' ||
  Boolean(process.stdout.isTTY) ||
  !process.env['NODE_ENV'];

const level = process.env['LOG_LEVEL'] || 'info';

/**
 * Path to error.log file in daemon runtime directory (~/.gemini-cli-telegram/error.log)
 */
export const ERROR_LOG_PATH = path.join(os.homedir(), '.gemini-cli-telegram', 'error.log');

/**
 * Underlying Pino logger instance.
 * Uses pino-pretty transport in development/local/TTY environments.
 */
export const pinoInstance = pino({
  level,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

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
      const formatted = formatMsg(message, args);
      pinoInstance.error(formatted);
      try {
        const timestamp = new Date().toISOString();
        fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
        fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] ${formatted}\n`);
      } catch {
        // Fail silent to prevent log writing errors from crashing the daemon
      }
    }
  },
};
