/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { ICONS, escapeHtml } from '../ui.js';

const PARSE_MODES = ['RichText', 'HTML', 'MarkdownV2'] as const;
type ParseMode = (typeof PARSE_MODES)[number];

const MODE_LABELS: Record<ParseMode, string> = {
  RichText: 'Rich Text（推荐）',
  HTML: 'HTML',
  MarkdownV2: 'MarkdownV2',
};

function readParseMode(mode: string | undefined | null): ParseMode {
  return (PARSE_MODES as readonly string[]).includes(mode as string)
    ? (mode as ParseMode)
    : 'RichText';
}

/** Build the /settings panel text from the live session. */
function buildSettingsText(
  sessionManager: SessionManager,
  chatId: number,
  defaultModel: string,
): string {
  const session = sessionManager.getSession(chatId);
  const parseMode = readParseMode(session?.settings?.telegram?.parseMode);
  const model = escapeHtml(session?.model || defaultModel);
  const project = session?.currentProject ? escapeHtml(session.currentProject.name) : '未选择';
  const turns = session?.turnCount ?? 0;

  return (
    `${ICONS.settings} <b>Setting Panel</b>\n\n` +
    `${ICONS.model} <b>Model:</b> <code>${model}</code>\n` +
    `${ICONS.project} <b>Workspace:</b> <code>${project}</code>\n` +
    `${ICONS.clock} <b>Turns:</b> ${turns}\n` +
    `${ICONS.terminal} <b>Output Format:</b> ${MODE_LABELS[parseMode]}\n\n` +
    `<i>调整后即时生效。</i>`
  );
}

function buildSettingsKeyboard(parseMode: ParseMode): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const mode of PARSE_MODES) {
    kb.text(
      `${mode === parseMode ? '● ' : '○ '}${MODE_LABELS[mode]}`,
      `settings:parseMode:${mode}`,
    );
    kb.row();
  }

  kb.text(`${ICONS.model} Choose Model`, 'settings:model')
    .text(`${ICONS.back} Main Menu`, '/start');
  return kb;
}

export function registerSettingsHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  // /settings command — open the panel.
  bot.command('settings', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const session = sessionManager.getSession(chatId);
    await ctx.reply(buildSettingsText(sessionManager, chatId, defaultOptions.model || 'default'), {
      parse_mode: 'HTML',
      reply_markup: buildSettingsKeyboard(readParseMode(session?.settings?.telegram?.parseMode)),
    }).catch((e) => logger.warn(`[settings] reply failed: ${e}`));
  });

  // Callback panel. Registered BEFORE callbackRouter (in registerCommands) so it
  // owns `settings:`-prefixed callbacks; everything else is passed through via
  // the middleware chain (this handler returns without answering otherwise).
  bot.on('callback_query:data', async (ctx: Context, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith('settings:')) {
      await next();
      return;
    }
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    // Answer immediately to dismiss loading, mirroring callbackRouter.
    ctx.answerCallbackQuery().catch(() => {});

    const session = sessionManager.getSession(chatId);

    // Cycle parse mode.
    if (data.startsWith('settings:parseMode:')) {
      const next = readParseMode(data.slice('settings:parseMode:'.length));
      if (session) {
        session.settings ??= {};
        session.settings.telegram ??= {};
        session.settings.telegram.parseMode = next;
        logger.info(`[settings] chatId=${chatId} parseMode -> ${next}`);
      }
      await ctx.editMessageText(buildSettingsText(sessionManager, chatId, defaultOptions.model || 'default'), {
        parse_mode: 'HTML',
        reply_markup: buildSettingsKeyboard(next),
      }).catch((err) => logger.warn(`[settings] edit failed: ${err}`));
      return;
    }

    // Link to the existing /model selector keyboard.
    if (data === 'settings:model') {
      await ctx.editMessageText(`${ICONS.model} <b>Select Model</b>\n\nUse /model to pick a model.`, {
        parse_mode: 'HTML',
      }).catch((err) => logger.warn(`[settings] edit failed: ${err}`));
      return;
    }
  });
}

