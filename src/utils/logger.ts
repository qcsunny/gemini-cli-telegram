/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file logger.ts
 * @description Lightweight timestamped logging utility with configurable log levels.
 * Log levels: debug < info < warn < error (controlled via process.env.LOG_LEVEL).
 */

const levels = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof levels)[number];

/**
 * Type guard to check if a string matches a valid LogLevel.
 */
function isLogLevel(value: string): value is LogLevel {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return levels.includes(value as LogLevel);
}

const envLevel = process.env['LOG_LEVEL'] || 'info';
const currentLevel: LogLevel = isLogLevel(envLevel) ? envLevel : 'info';
const currentLevelIndex = levels.indexOf(currentLevel);

/**
 * Generates an ISO timestamp string for log entry prefixes.
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Core logging method that outputs formatted log messages to process.stderr
 * if the level meets or exceeds the currently configured log level index.
 *
 * @param level - Log severity level
 * @param message - Primary message string
 * @param args - Additional contextual arguments to concatenate
 */
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (levels.indexOf(level) < currentLevelIndex) {
    return;
  }
  const prefix = `[${level.toUpperCase()}] ${formatTimestamp()} --`;
  const line =
    args.length > 0
      ? `${prefix} ${message} ${args.map((a) => String(a)).join(' ')}`
      : `${prefix} ${message}`;
  process.stderr.write(line + '\n');
}

/**
 * Shared application logger instance.
 */
export const logger = {
  debug: (message: string, ...args: unknown[]) =>
    log('debug', message, ...args),
  info: (message: string, ...args: unknown[]) =>
    log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) =>
    log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log('error', message, ...args),
};
