/**
 * @file commands.ts
 * @description Telegram bot slash command registry. Thin facade that delegates
 * to domain-specific handler modules.
 */

import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../core/session.js';
import type { SessionOptions, DaemonSession } from '../../core/types.js';
import { registerSessionHandlers } from './commands/sessionHandlers.js';
import { registerConfigHandlers } from './commands/configHandlers.js';
import { registerContentHandlers } from './commands/contentHandlers.js';
import { registerAutomationHandlers } from './commands/automationHandlers.js';
import { registerProjectHandlers } from './commands/projectHandlers.js';
import { registerCallbackRouter } from './commands/callbackRouter.js';
import { registerInlineHandler } from './commands/inlineHandler.js';
import { registerPrivateTaskHandlers } from './commands/privateTaskHandler.js';
import { registerSettingsHandler } from './commands/settingsHandler.js';
import { registerSumHandler } from './commands/sumHandler.js';

/**
 * Register Telegram slash command handlers on the bot.
 */
export function registerCommands(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  triggerAutopilot?: (session: DaemonSession, ctx: Context) => Promise<void>,
  allowedUsers?: number[],
): void {
  registerSessionHandlers(bot, sessionManager, defaultOptions);
  registerConfigHandlers(bot, sessionManager, defaultOptions);
  registerContentHandlers(bot, sessionManager, defaultOptions);
  registerAutomationHandlers(bot, sessionManager, defaultOptions, triggerAutopilot);
  registerProjectHandlers(bot, sessionManager, defaultOptions);
  registerSettingsHandler(bot, sessionManager, defaultOptions);
  registerCallbackRouter(bot, sessionManager, defaultOptions);
  registerInlineHandler(bot, sessionManager, defaultOptions, { allowedUsers });
  registerPrivateTaskHandlers(bot, sessionManager, defaultOptions);
  registerSumHandler(bot, sessionManager, defaultOptions);
}
