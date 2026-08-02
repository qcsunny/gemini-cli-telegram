import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getCumulativeUsageByChat } from '../../../agy/messageStore.js';
import { calculateCost } from '../../../utils/pricing.js';
import { ICONS, escapeHtml } from '../ui.js';

/**
 * Aggregate token usage across all stored conversations for this chat.
 * Derive a cumulative estimated cost from the whole billing so far using the
 * price matrix (billing is not back-filled historically, so this is an
 * estimate for display purposes).
 */
export function registerUsageHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  bot.command('usage', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const session = sessionManager.getSession(chatId);
      const modelForCost = session?.config?.getModel?.() ?? defaultOptions.model ?? 'Gemini 3.5 Flash (Medium)';
      const usage = getCumulativeUsageByChat(chatId);

      const { totalCost, currency } = calculateCost(
        modelForCost,
        usage.input,
        usage.output,
        usage.cached,
        usage.thinking,
      );
      const sym = currency === 'CNY' ? '¥' : '$';

      const lines = [
        `${ICONS.stats} <b>Token Usage</b> (cumulative)`,
        ``,
        `Model: <code>${escapeHtml(modelForCost)}</code>`,
        ``,
        `📥 Input: <code>${usage.input.toLocaleString()}</code>`,
        `📤 Output: <code>${usage.output.toLocaleString()}</code>`,
        `🗃 Cached: <code>${usage.cached.toLocaleString()}</code>`,
        `🧠 Thinking: <code>${usage.thinking.toLocaleString()}</code>`,
        ``,
        `💵 Est. Cost: <b>${sym}${totalCost.toFixed(6)}</b>`,
      ];

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (e) {
      logger.error(`Error in /usage for chat ${chatId}: ${e}`);
      await ctx.reply(`${ICONS.error} <b>Usage lookup failed:</b> ${e instanceof Error ? e.message : String(e)}`, {
        parse_mode: 'HTML',
      });
    }
  });
}