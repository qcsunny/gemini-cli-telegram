/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file watchlistHandler.ts
 * @description Telegram command and callback handler for stock watchlists, sector-based briefings, and scheduled market reviews.
 */

import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { addToWatchlist, removeFromWatchlist } from '../../../stock/service/watchlist.js';
import {
  generateDailyBriefing,
  collectWatchlistMarketData,
  formatWatchlistSnapshotTable,
  type MarketSegment,
} from '../../../stock/service/dailyBriefing.js';
import { buildChannelReply } from '../bot/channelReply.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';
import type { ChatScheduler } from '../../../core/scheduler.js';

export function buildWatchlistKeyboard(symbols: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Row 1: Action triggers
  kb.text('📊 全市场复盘', 'wl_report:all')
    .text('🇨🇳 A股复盘', 'wl_report:cn')
    .text('🇺🇸 美股复盘', 'wl_report:us')
    .row();

  // Row 2: Subscriptions
  kb.text('🇨🇳 订阅A股(15:30)', 'wl_sub:15:30:cn')
    .text('🇭🇰 订阅港股(16:30)', 'wl_sub:16:30:hk')
    .row();

  // Row 3: US Market Subscriptions
  kb.text('🇺🇸 订阅美股盘前(21:00)', 'wl_sub:21:00:us')
    .text('☀️ 订阅美股晨报(08:00)', 'wl_sub:08:00:us')
    .row();

  // Row 4: Refresh & list
  kb.text('🔄 刷新实时行情', 'wl_action:refresh')
    .text('📋 我的定时订阅', 'wl_action:list_sub')
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

export async function renderWatchlistCard(
  userId: number,
  segment: MarketSegment = 'all'
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { symbols, watchlistQuotes } = await collectWatchlistMarketData(userId, segment);

  if (symbols.length === 0) {
    const emptyText =
      `⭐ **您的自选股监控池为空**\n\n` +
      `您可以随时通过命令添加关注的股票/ETF：\n` +
      `• 添加个股：\`/watchlist add NVDA, AAPL, 600519\`\n` +
      `• 删除个股：\`/watchlist del NVDA\`\n` +
      `• 分板块复盘：\`/watchlist report [cn | hk | us | all]\`\n` +
      `• 分板块订阅：\`/watchlist subscribe 15:30 cn\` 或 \`/watchlist subscribe 08:00 us\``;
    return { text: emptyText, keyboard: new InlineKeyboard() };
  }

  const snapshot = formatWatchlistSnapshotTable(watchlistQuotes);
  const text =
    `⭐ **我的自选股实时监控池 (${symbols.length} 只标的)**\n\n` +
    `${snapshot}\n\n` +
    `_点击下方按钮即可一键出具指定板块 AI 深度复盘报告或设置分板块自动推送。_`;

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

    // /watchlist del <symbols...>
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

    // /watchlist report [segment]
    if (subCmd === 'report' || subCmd === 'briefing') {
      const segArg = (parts[1]?.toLowerCase() || 'all') as MarketSegment;
      const segment: MarketSegment = ['cn', 'hk', 'us', 'crypto', 'all'].includes(segArg) ? segArg : 'all';
      await handleReportGeneration(ctx, userId, segment);
      return;
    }

    // /watchlist subscribe [HH:MM] [segment]
    if (subCmd === 'subscribe' || subCmd === 'sub') {
      const timeStr = parts[1] || '15:30';
      const segArg = (parts[2]?.toLowerCase() || 'all') as MarketSegment;
      const segment: MarketSegment = ['cn', 'hk', 'us', 'crypto', 'all'].includes(segArg) ? segArg : 'all';
      await handleSubscription(ctx, userId, timeStr, segment, scheduler);
      return;
    }

    // /watchlist subscriptions / list
    if (subCmd === 'subscriptions' || subCmd === 'subs' || subCmd === 'tasks') {
      await handleListSubscriptions(ctx, userId, scheduler);
      return;
    }

    // Default: Show Watchlist Card
    const { text, keyboard } = await renderWatchlistCard(userId);
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  });

  // 2. Callback queries for inline keyboard
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith('wl_')) {
      return next();
    }
    const userId = ctx.from?.id;
    if (!userId) return;

    if (data === 'wl_action:refresh') {
      await ctx.answerCallbackQuery('正在刷新自选股实时行情...').catch(() => {});
      const { text, keyboard } = await renderWatchlistCard(userId);
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
      return;
    }

    if (data === 'wl_action:list_sub') {
      await ctx.answerCallbackQuery().catch(() => {});
      await handleListSubscriptions(ctx, userId, scheduler);
      return;
    }

    if (data.startsWith('wl_report:')) {
      const segment = data.replace('wl_report:', '').trim() as MarketSegment;
      await ctx.answerCallbackQuery(`正在生成 ${segment.toUpperCase()} 复盘报告...`).catch(() => {});
      await handleReportGeneration(ctx, userId, segment);
      return;
    }

    if (data.startsWith('wl_sub:')) {
      // Format: wl_sub:HH:MM:segment
      const parts = data.replace('wl_sub:', '').split(':');
      const timeStr = `${parts[0]}:${parts[1]}`;
      const segment = (parts[2] || 'all') as MarketSegment;
      await handleSubscription(ctx, userId, timeStr, segment, scheduler);
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

async function handleReportGeneration(
  ctx: Context,
  userId: number,
  segment: MarketSegment = 'all'
): Promise<void> {
  const reply = buildChannelReply(ctx, ctx.chat?.id ?? userId, 'RichText');
  const segmentLabel = segment === 'cn' ? '🇨🇳 A股' : segment === 'hk' ? '🇭🇰 港股' : segment === 'us' ? '🇺🇸 美股' : '🌐 全市场';
  const msgId = await reply.send(`${ICONS.clock} 正在聚合【${segmentLabel}】自选股与大盘行情，AI 买方分析师正在全力出具复盘报告...`);

  try {
    const briefing = await generateDailyBriefing(userId, {
      segment,
      onChunk: (chunk) => {
        if (reply.editRichDraft) {
          reply.editRichDraft(msgId, chunk).catch(() => {});
        } else {
          reply.edit(msgId, chunk).catch(() => {});
        }
      },
    });

    await reply.edit(msgId, briefing.markdown);
  } catch (err) {
    logger.error(`[WatchlistHandler] Failed to generate daily briefing for user ${userId}: ${err}`);
    await reply.edit(msgId, `❌ 生成复盘简报失败：${err}`);
  }
}

async function handleSubscription(
  ctx: Context,
  userId: number,
  timeStr: string,
  segment: MarketSegment = 'all',
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

  const formattedTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  const segmentLabel = segment === 'cn' ? '🇨🇳 A股市场' : segment === 'hk' ? '🇭🇰 港股市场' : segment === 'us' ? '🇺🇸 美股市场' : '🌐 全市场自选';

  const task = await scheduler.addTask(
    chatId,
    `/watchlist report ${segment}`,
    'recurring',
    formattedTime,
    24 * 60, // Every 24 hours
    threadId
  );

  const confirmMsg =
    `🎉 **${segmentLabel} 定时 AI 复盘推送订阅成功！**\n\n` +
    `• **推送时段**：每天 ${formattedTime} (北京时间 CST)\n` +
    `• **订阅板块**：${segmentLabel}\n` +
    `• **任务 ID**：\`${task.id.slice(0, 8)}\`\n\n` +
    `系统将在每个交易日的设定时间准时将该板块深度复盘推送到本聊天！\n` +
    `_随时可通过 \`/watchlist subscriptions\` 查看或管理已订阅列表。_`;

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery('订阅成功！').catch(() => {});
    await ctx.reply(confirmMsg, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(confirmMsg, { parse_mode: 'Markdown' });
  }
}

async function handleListSubscriptions(
  ctx: Context,
  userId: number,
  scheduler?: ChatScheduler
): Promise<void> {
  const chatId = ctx.chat?.id ?? userId;
  if (!scheduler) {
    await ctx.reply('⚠️ 定时调度服务未初始化。');
    return;
  }

  const tasks = scheduler.listTasks(chatId).filter(t => t.message.startsWith('/watchlist'));

  if (tasks.length === 0) {
    await ctx.reply(
      `📋 **暂无活跃的自选股定时复盘订阅**\n\n` +
      `您可以通过以下指令一键订阅：\n` +
      `• 🇨🇳 A股盘后：\`/watchlist subscribe 15:30 cn\`\n` +
      `• 🇭🇰 港股盘后：\`/watchlist subscribe 16:30 hk\`\n` +
      `• 🇺🇸 美股盘前：\`/watchlist subscribe 21:00 us\`\n` +
      `• ☀️ 美股晨报：\`/watchlist subscribe 08:00 us\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const taskList = tasks.map((t, idx) => {
    const nextRunDate = new Date(t.nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `**${idx + 1}.** 任务指令: \`${t.message}\`\n  └ 每天 \`${t.schedule}\` · 下次执行: ${nextRunDate} · ID: \`${t.id.slice(0, 8)}\``;
  }).join('\n\n');

  await ctx.reply(
    `📋 **当前已订阅的自选股 AI 复盘任务 (${tasks.length} 个)**\n\n` +
    `${taskList}\n\n` +
    `_如需取消某项任务，使用 \`/schedule cancel <ID>\` 即可。_`,
    { parse_mode: 'Markdown' }
  );
}
