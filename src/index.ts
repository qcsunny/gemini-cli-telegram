/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TelegramBot,
  type TelegramBotOptions,
} from './channels/telegram/bot.js';
import { logger } from './utils/logger.js';

export type { ChannelReply, DaemonSession, SessionOptions, MessageFormatter } from './core/types.js';
export { SessionManager } from './core/session.js';
export { processMessage } from './core/messageLoop.js';
export { listAvailableSessions, resumeSession } from './core/resume.js';

export interface DaemonOptions extends TelegramBotOptions {
  token: string;
}

export async function startTelegramDaemon(
  options: DaemonOptions,
): Promise<void> {
  if (!options.token) {
    throw new Error(
      'Telegram bot token is required. Set TELEGRAM_BOT_TOKEN or pass --token.',
    );
  }

  const bot = new TelegramBot(options.token, options);

  const shutdown = async () => {
    logger.info('Shutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  await bot.start();
}

