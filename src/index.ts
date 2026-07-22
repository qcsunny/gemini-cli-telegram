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

import {
  TelegramBot,
  type TelegramBotOptions,
} from './channels/telegram/bot.js';
import { logger } from './utils/logger.js';
import { loadUserConfig, clearConfigCache } from './config/userConfig.js';
import { clearDefaultModelsCache, restoreHistoriesFromDb } from './agy/agyCli.js';
import { clearModelOrderCache } from './core/messageLoop.js';
import { startHealthServer, stopHealthServer } from './utils/healthServer.js';

export type { ChannelReply, DaemonSession, SessionOptions, MessageFormatter } from './core/types.js';
export { SessionManager } from './core/session.js';
export { processMessage } from './core/messageLoop.js';
export { listAvailableSessions, resumeSession } from './core/resume.js';

/**
 * Startup configuration options for starting the Telegram daemon process.
 */
export interface DaemonOptions extends TelegramBotOptions {
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
      'Telegram bot token is required. Set TELEGRAM_BOT_TOKEN or pass --token.',
    );
  }

  const bot = new TelegramBot(options.token, options);

  // Start the optional health HTTP server if configured
  const config = loadUserConfig();
  if (config?.healthPort) {
    startHealthServer(config.healthPort);
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    stopHealthServer();
    await bot.stop();
    process.exit(0);
  };

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

  await bot.start();

  // Restore web2api/deepseek conversation histories from SQLite (survive restarts)
  restoreHistoriesFromDb();
}

