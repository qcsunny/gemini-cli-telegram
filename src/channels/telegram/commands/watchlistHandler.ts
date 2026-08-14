/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file watchlistHandler.ts
 * @description Telegram command and callback handler for stock watchlists and daily AI briefings.
 */

import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { addToWatchlist, removeFromWatchlist, getUserWatchlist } from '../../../stock/service/watchlist.js';
import { generateDailyBriefing, collectWatchlistMarketData, formatWatchlistSnapshotTable } from '../../../stock/service/dailyBriefing.js';
import { buildChannelReply } from '../bot/channelReply.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';
import type { ChatScheduler } from '../../../core/scheduler.js';

export function buildWatchlistKeyboard(symbols: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Row 1: Action triggers
  kb.text('📊 生成 AI 深度复盘', 'wl_action:report')
    .text('🔄 刷新行情', 'wl_action:refresh')
    .row();

  // Row 2: Manage and schedule
  kb.text('⏰ 订阅每日复盘 (15:30)', 'wl_action:sub_1530')
    .text('🌙 订阅美股盘前 (21:00)', 'wl_action:sub_2100')
    .row();

  // Individual symbol remove buttons (2 per row)
  for (let i = 0; i < symbols.length; i += 2) {
    const s1 = symbols[i];
    const s2 = symbols[i + 1];
    kb.text(`🗑 移除 ${s1}`, `wl_del:${s1}`);
    if (s2) {
      kb.text(`🗑 移除 ${s2}`, `wl_del:${s2}`);
    }
    kb.row();
  }

  return kb;
}

export async function renderWatchlistCard(userId: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { symbols, watchlistQuotes } = await collectWatchlistMarketData(userId);

  if (symbols.length === 0) {
    const emptyText =
      `⭐ **您的自选股监控池为空**\n\n` +
      `您可以随时通过命令添加关注的股票/ETF：\n` +
      `• 添加个股：\`/watchlist add NVDA, AAPL, 600519\`\n` +
      `• 删除个股：\`/watchlist del NVDA\`\n` +
      `• 生成复盘：\`/watchlist report\`\n` +
      `• 定时推送：\`/watchlist subscribe 15:30\``;
    return { text: emptyText, keyboard: new InlineKeyboard() };
  }

  const snapshot = formatWatchlistSnapshotTable(watchlistQuotes);
  const text =
    `⭐ **我的自选股实时监控池 (${symbols.length} 只标的)**\n\n` +
    `${snapshot}\n\n` +
    `_点击下方按钮即可一键出具 AI 深度复盘报告或设置每日自动推送。_`;

  return { text, keyboard: buildWatchlistKeyboard(symbols) };
}

export function registerWatchlistCommands(bot: Bot, scheduler?: ChatScheduler): void {
  // 1. /watchlist command
  bot.command(['watchlist', 'wl'], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const rawText = ctx.message?.text?.trim() || '';
    const parts = rawText.split(/\s+/).slice(1);
    const subCmd = parts[0]?.toLowerCase();

    // /watchlist add <symbols...>
    if (subCmd === 'add') {
      const symbolsToAdd = parts.slice(1).join(' ').split(/[,，\s]+/).filter(Boolean);
      if (symbolsToAdd.length === 0) {
        await ctx.reply('⚠️ 请指定要添加的股票代码，例如：`/watchlist add AAPL,NVDA,600519`', { parse_mode: 'Markdown' });
        return;
      }
      for (const sym of symbolsToAdd) {
        await addToWatchlist(userId, sym);
      }
      const { text, keyboard } = await renderWatchlistCard(userId);
      await ctx.reply(`✅ 成功添加 **${symbolsToAdd.join(', ')}** 至自选列表！\n\n${text}`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return;
    }

    // /watchlist del <symbols...> / remove
    if (subCmd === 'del' || subCmd === 'rm' || subCmd === 'delete' || subCmd === 'remove') {
      const symbolsToDel = parts.slice(1).join(' ').split(/[,，\s]+/).filter(Boolean);
      if (symbolsToDel.length === 0) {
        await ctx.reply('⚠️ 请指定要移除的股票代码，例如：`/watchlist del NVDA`', { parse_mode: 'Markdown' });
        return;
      }
      for (const sym of symbolsToDel) {
        await removeFromWatchlist(userId, sym);
      }
      const { text, keyboard } = await renderWatchlistCard(userId);
      await ctx.reply(`🗑 已将 **${symbolsToDel.join(', ')}** 移出自选列表。\n\n${text}`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return;
    }

    // /watchlist report (Generate AI Daily Briefing on demand)
    if (subCmd === 'report' || subCmd === 'briefing') {
      await handleReportGeneration(ctx, userId);
      return;
    }

    // /watchlist subscribe [HH:MM]
    if (subCmd === 'subscribe' || subCmd === 'sub') {
      const timeStr = parts[1] || '15:30';
      await handleSubscription(ctx, userId, timeStr, scheduler);
      return;
    }

    // Default: Show Watchlist Card
    const { text, keyboard } = await renderWatchlistCard(userId);
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  });

  // 2. Callback queries for inline keyboard
  bot.callbackQuery(/^wl_/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    if (!userId) return;

    if (data === 'wl_action:refresh') {
      await ctx.answerCallbackQuery('正在刷新自选股实时行情...').catch(() => {});
      const { text, keyboard } = await renderWatchlistCard(userId);
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
      return;
    }

    if (data === 'wl_action:report') {
      await ctx.answerCallbackQuery('正在生成 AI 深度复盘报告...').catch(() => {});
      await handleReportGeneration(ctx, userId);
      return;
    }

    if (data === 'wl_action:sub_1530') {
      await handleSubscription(ctx, userId, '15:30', scheduler);
      return;
    }

    if (data === 'wl_action:sub_2100') {
      await handleSubscription(ctx, userId, '21:00', scheduler);
      return;
    }

    if (data.startsWith('wl_del:')) {
      const sym = data.replace('wl_del:', '').trim();
      await removeFromWatchlist(userId, sym);
      await ctx.answerCallbackQuery(`已移除 ${sym}`).catch(() => {});
      const { text, keyboard } = await renderWatchlistCard(userId);
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
      return;
    }

    if (data.startsWith('wl_add:')) {
      const sym = data.replace('wl_add:', '').trim();
      await addToWatchlist(userId, sym);
      await ctx.answerCallbackQuery(`⭐ 已添加 ${sym} 至自选股！`).catch(() => {});
      return;
    }
  });
}

async function handleReportGeneration(ctx: Context, userId: number): Promise<void> {
  const reply = buildChannelReply(ctx, ctx.chat?.id ?? userId, 'RichText');
  await reply.sendRichMessage(`${ICONS.working} 正在聚合自选股与大盘行情，AI 买方分析师正在全力生成复盘简报...`);

  try {
    const briefing = await generateDailyBriefing(userId, {
      onChunk: (chunk) => {
        reply.streamRichMessage(chunk).catch(() => {});
      },
    });

    await reply.editRichMessage(briefing.markdown);
  } catch (err) {
    logger.error(`[WatchlistHandler] Failed to generate daily briefing for user ${userId}: ${err}`);
    await reply.editRichMessage(`❌ 生成复盘简报失败：${err}`);
  }
}

async function handleSubscription(
  ctx: Context,
  userId: number,
  timeStr: string,
  scheduler?: ChatScheduler
): Promise<void> {
  const chatId = ctx.chat?.id ?? userId;
  const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;

  if (!scheduler) {
    await ctx.reply('⚠️ 定时调度服务未初始化。');
    return;
  }

  // Parse HH:MM
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!match) {
    await ctx.reply('⚠️ 时间格式错误，请使用 24 小时制，如：`15:30` 或 `21:00`', { parse_mode: 'Markdown' });
    return;
  }

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await ctx.reply('⚠️ 无效的时间范围。');
    return;
  }

  // Calculate next run timestamp today or tomorrow
  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  const taskId = scheduler.addTask({
    chatId,
    threadId,
    message: `/watchlist report`,
    type: 'recurring',
    schedule: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
    intervalMinutes: 24 * 60, // Every 24 hours
    nextRun: next.getTime(),
  });

  const confirmMsg =
    `🎉 **每日自选股 AI 复盘推送订阅成功！**\n\n` +
    `• **推送时间**：每天 ${timeStr} (上海时间)\n` +
    `• **首次触发**：${next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n` +
    `• **任务 ID**：\`${taskId.slice(0, 8)}\`\n\n` +
    `系统将在每个交易日准时为您送达自选股深度复盘简报！`;

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery('订阅成功！').catch(() => {});
    await ctx.reply(confirmMsg, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(confirmMsg, { parse_mode: 'Markdown' });
  }
}
