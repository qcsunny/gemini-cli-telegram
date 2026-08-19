/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file index.ts
 * @description Primary library export entry point for gemini-cli-telegram.
 * Re-exports public core types, session managers, and message loop functions,
 * and provides the `startTelegramDaemon` bootstrap function for programmatically starting the bot daemon.
 */

import { TelegramBot, type TelegramBotOptions } from './channels/telegram/bot.js';
import { logger, flushLogs } from './utils/logger.js';
import { loadUserConfig, clearConfigCache } from './config/userConfig.js';
import { clearDefaultModelsCache, restoreHistoriesFromDb } from './agy/agyCli.js';
import { clearModelOrderCache } from './core/modelRegistry.js';
import { startHealthServer, stopHealthServer } from './utils/healthServer.js';
import { initExchangeRate } from './utils/exchangeRate.js';
import { closeDb } from './db/index.js';

export type { ChannelReply, DaemonSession, SessionOptions, MessageFormatter } from './core/types.js';
export { SessionManager } from './core/session.js';
export { processMessage } from './core/messageLoop.js';
export { listAvailableSessions, resumeSession } from './core/resume.js';

/**
 * Startup configuration options for starting the Telegram daemon process.
 */
interface DaemonOptions extends TelegramBotOptions {
  token: string;
}

/**
 * Initializes and starts the Telegram daemon bot process with signal handlers (SIGTERM / SIGINT) for graceful shutdown.
 *
 * @param options - Daemon startup configuration including bot token, model, whitelist, and proxy settings.
 */
export async function startTelegramDaemon(
  options: DaemonOptions,
): Promise<void> {
  if (!options.token) {
    throw new Error(
      'Telegram bot token is required. Set it in config.json (telegramBotToken) or pass --token.',
    );
  }

  // Global safety net: log unhandled promise rejections instead of crashing.
  // For uncaught exceptions, log and exit (the systemd unit restarts the daemon)
  // rather than keep running in a state Node may have corrupted.
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    // Hard fallback so the process never hangs in a half-closed state.
    const forceTimer = setTimeout(() => {
      logger.error('[shutdown] Timed out waiting for graceful shutdown — forcing exit');
      process.exit(1);
    }, 15000);
    forceTimer.unref?.();

    try {
      stopHealthServer();
    } catch (e) {
      logger.warn(`[shutdown] Error stopping health server: ${e}`);
    }
    try {
      await bot.stop();
    } catch (e) {
      logger.error(`[shutdown] Error stopping bot (children were force-killed): ${e}`);
    }
    // Close the SQLite connection cleanly (flushes WAL checkpoint).
    try {
      closeDb();
    } catch (e) {
      logger.warn(`[shutdown] Error closing database: ${e}`);
    }
    // Flush buffered log writes before the process exits.
    try {
      await flushLogs();
    } catch (e) {
      logger.warn(`[shutdown] Error flushing logs: ${e}`);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err: Error) => {
    logger.error(`[uncaughtException] ${err.stack || err.message}`);
    logger.error('[uncaughtException] Node state may be corrupted — triggering graceful shutdown (systemd will restart).');
    void shutdown().catch((shutdownErr) => {
      logger.error(`[uncaughtException] Graceful shutdown failed, forcing exit: ${shutdownErr}`);
      process.exit(1);
    });
  });

  const bot = new TelegramBot(options.token, options);

  // Start the optional health HTTP server if configured
  const config = loadUserConfig();
  if (config?.healthPort) {
    startHealthServer(config.healthPort);
  }

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  // SIGHUP — hot-reload config caches without restarting the daemon.
  // After editing config.json (or models.json), send kill -HUP <pid>.
  process.on('SIGHUP', () => {
    logger.info('[SIGHUP] Clearing all config caches (tuning, models, model order)...');
    clearConfigCache();
    clearDefaultModelsCache();
    clearModelOrderCache();
  });

  // Start the Telegram bot (runner-based polling via @grammyjs/runner)
  await bot.start();

  // Restore web2api/deepseek conversation histories from SQLite (survive restarts)
  restoreHistoriesFromDb();

  // Initialize exchange rate (fetch in background, use cached value from disk)
  initExchangeRate();
}

