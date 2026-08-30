/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file bot.ts
 * @description Main Telegram Bot server and adapter implementation.
 * Houses the `TelegramBot` class, grammY update handling, middleware pipeline
 * (whitelist authentication, sequentialization), stuck session watchdog, and
 * autopilot handlers.
 *
 * Sub-modules:
 *   bot/rateLimiter.ts   — HTTP 429 backoff functions
 *   bot/channelReply.ts  — buildChannelReply + rich message pipeline
 *   bot/withSession.ts   — session acquisition / typing indicator / cleanup
 *   media/               — media extraction, download, single & album handling
 */

import { Bot, Context, InputFile, type ApiClientOptions } from 'grammy';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { run, sequentialize } from '@grammyjs/runner';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { SessionManager } from '../../core/session.js';
import { processMessage } from '../../core/messageLoop.js';
import { createTelegramSendMedia, createTelegramSendMediaGroup } from './outbound.js';
import { isPrivateImageRequest, handlePrivateImageRequest } from './commands/privateImageHandler.js';
import { persistChatMessage } from './commands/sumHandler.js';
import type {
  ChannelReply,
  SessionOptions,
  DaemonSession,
  MultimodalInput,
} from '../../core/types.js';
import { registerCommands } from './commands.js';
import { telegramFormatter } from './formatter.js';
import { logger } from '../../utils/logger.js';
import { ICONS, formatWelcome, buildMainKeyboard, escapeHtml } from './ui.js';
import { messageCache } from '../../utils/messageCache.js';
import { CONFIG_PATH, getBackendUrl, loadUserConfig } from '../../config/userConfig.js';
import { buildChannelReply } from './bot/channelReply.js';
import { startBackoffCleanup, reset429Backoff } from './bot/rateLimiter.js';

import {
  withSession,
  resetStuckSession,
  MAX_MESSAGE_PROCESSING_MS,
} from './bot/withSession.js';
import {
  type TelegramMediaType,
  type TelegramMediaInfo,
  extractMediaInfo,
  extractMediaFromMessage,
  handleSingleMediaMessage,
  flushAlbumBuffer,
} from './media/mediaHandler.js';
import { downloadTelegramFile } from './media/mediaDownloader.js';
import type { MarketSegment } from '../../stock/service/dailyBriefing.js';

export { record429Backoff, reset429Backoff, is429Error, get429RetryAfter } from './bot/rateLimiter.js';
export { buildChannelReply } from './bot/channelReply.js';

// ── Constants ──

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const WATCHLIST_SEGMENTS: readonly MarketSegment[] = ['all', 'cn', 'hk', 'us', 'crypto'];

function parseMarketSegment(value: string | undefined): MarketSegment {
  return value && WATCHLIST_SEGMENTS.includes(value as MarketSegment)
    ? value as MarketSegment
    : 'all';
}

// Runner must subscribe to the same update types on every (re)start, otherwise
// an auto-restart after a dropped getUpdates connection would silently lose
// e.g. inline_query / callback_query handling.
const RUNNER_ALLOWED_UPDATES = {
  allowed_updates: [
    'message',
    'edited_message',
    'callback_query',
    'inline_query',
    'chosen_inline_result',
  ] as const,
};

// ── Types ──

export interface TelegramBotOptions {
  allowedUsers?: number[];
  model?: string;
  cwd?: string;
  proxy?: string;
}

// ── Sequentialize key ──

function getSequentialKey(ctx: Context): string | undefined {
  const chatId = ctx.chat?.id;
  if (!chatId) return undefined;
  if (ctx.callbackQuery) {
    return `callback:${chatId}`;
  }
  const text = ctx.message?.text ?? '';
  if (text.startsWith('/cancel') || text.startsWith('/new')) {
    return `control:${chatId}`;
  }
  return `chat:${chatId}`;
}

/**
 * Combine multiple AbortSignals into one (polyfill for AbortSignal.any).
 * The combined signal aborts when any input signal aborts. Listeners are
 * added with `{ once: true }` and removed by the returned cleanup so a
 * long-lived input signal (e.g. grammy's) never accumulates listeners.
 */
function combineSignals(
  ...signals: AbortSignal[]
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const listeners: Array<{ sig: AbortSignal; fn: () => void }> = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    const fn = () => ctrl.abort(s.reason);
    s.addEventListener('abort', fn, { once: true });
    listeners.push({ sig: s, fn });
  }
  const cleanup = () => {
    for (const { sig, fn } of listeners) {
      sig.removeEventListener('abort', fn);
    }
  };
  return { signal: ctrl.signal, cleanup };
}

export class TelegramBot {
  private bot: Bot;
  private runner: ReturnType<typeof run> | undefined;
  private sessionManager: SessionManager;
  private defaultOptions: SessionOptions;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private proxyAgent: ProxyAgent | undefined;
  private pollAgent: ProxyAgent | undefined;
  private albumBuffer: Map<
    string,
    {
      chatId: number;
      items: { mediaType: TelegramMediaType; info: TelegramMediaInfo; ctx: Context }[];
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private static readonly ALBUM_FLUSH_MS = 800;

  constructor(token: string, options: TelegramBotOptions = {}) {
    const clientConfig: ApiClientOptions = {};
    if (options.proxy) {
      this.proxyAgent = new ProxyAgent({
        uri: options.proxy,
        connections: 10,
      });
      this.pollAgent = new ProxyAgent({
        uri: options.proxy,
        connections: 2,
      });
      const inlineAgent = new ProxyAgent({
        uri: options.proxy,
        connections: 2,
      });
      clientConfig.baseFetchConfig = {
        compress: true,
      };
      clientConfig.fetch = async (url: unknown, init: unknown) => {
        const requestUrl = (() => {
          if (typeof url === 'string' || url instanceof URL) return url;
          if (typeof url === 'object' && url !== null && 'url' in url && typeof url.url === 'string') {
            return url.url;
          }
          throw new TypeError('Telegram API fetch received an invalid URL');
        })();
        const requestInit = (init && typeof init === 'object' ? init : {}) as UndiciRequestInit;
        const urlStr = requestUrl.toString();
        const isGetUpdates = urlStr.includes('/getUpdates');
        const isInlineAnswer = urlStr.includes('/answerInlineQuery');

        // Long-poll getUpdates: dedicated agent so it never blocks the main pool
        if (isGetUpdates) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort('pollAgent timeout (60s)'), 60000);
          const combined = requestInit.signal
            ? combineSignals(ctrl.signal, requestInit.signal)
            : undefined;
          try {
            const signal = combined ? combined.signal : ctrl.signal;
            const r = await undiciFetch(requestUrl, { ...requestInit, dispatcher: this.pollAgent, signal });
            clearTimeout(timer);
            combined?.cleanup();
            return r;
          } catch (e: unknown) {
            clearTimeout(timer);
            combined?.cleanup();
            logger.warn(`[pollAgent] getUpdates connection reset or timeout: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
        }

        // answerInlineQuery: dedicated agent + fast retry with 4s timeout
        // (Telegram's inline answer hard limit is ~10s; 4s×2 = 8s stays inside it)
        if (isInlineAnswer) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            try {
              return await undiciFetch(requestUrl, {
                ...requestInit,
                dispatcher: inlineAgent,
                signal: ctrl.signal,
              });
            } catch (e: unknown) {
              clearTimeout(timer);
              if (attempt === 1) throw e;
            }
          }
        }

        // Normal API calls: keep grammy's signal, add 25s safety timeout
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          let combined: ReturnType<typeof combineSignals> | undefined;
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 25000);
            combined = requestInit.signal
              ? combineSignals(ctrl.signal, requestInit.signal)
              : undefined;
            const signal = combined ? combined.signal : ctrl.signal;
            const res = await undiciFetch(requestUrl, {
              ...requestInit,
              dispatcher: this.proxyAgent,
              signal,
            });
            clearTimeout(timer);
            combined?.cleanup();
            return res;
          } catch (e: unknown) {
            combined?.cleanup();
            if (requestInit.signal?.aborted) throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
        throw lastErr;
      };
    }
    this.bot = new Bot(token, { client: clientConfig });
    this.sessionManager = new SessionManager(
      (chatId) => createTelegramSendMedia(this.bot.api, chatId, token, options.proxy),
      (chatId) => createTelegramSendMediaGroup(this.bot.api, chatId, token, options.proxy),
    );
    this.defaultOptions = {
      cwd: options.cwd || process.cwd(),
      model: options.model,
      proxy: options.proxy,
    };
    this.setupMiddleware(options.allowedUsers);
    registerCommands(
      this.bot,
      this.sessionManager,
      this.defaultOptions,
      async (session, ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        const parseMode = session.settings?.telegram?.parseMode || 'RichText';
        await this.handleAutopilot(session, buildChannelReply(ctx, chatId, parseMode, session), ctx);
      },
      options.allowedUsers,
    );
    this.setupMessageHandler();
    this.setupScheduler();
  }

  private setupScheduler(): void {
    const scheduler = this.sessionManager.getChatScheduler();
    scheduler.initialize(async (task) => {
      const chatId = task.chatId;
      const threadId = task.threadId;
      logger.info(`Executing scheduled task ${task.id} for chat ${chatId}${threadId ? ` topic ${threadId}` : ''}`);

      try {
        // Route scheduled delivery through the same rich-block pipeline as the
        // private-chat message loop (sendRichMessage native blocks). A synthetic
        // ctx carries the api client + topic thread so buildChannelReply works
        // without a live update.
        const threadCtx = {
          api: this.bot.api,
          chat: { id: chatId },
          message: threadId ? { message_thread_id: threadId } : undefined,
          update: { message: threadId ? { message_thread_id: threadId } : undefined },
          reply: (text: string, other?: Record<string, unknown>) =>
            this.bot.api.sendMessage(chatId, text, { message_thread_id: threadId, ...(other || {}) }),
          replyWithDocument: (document: string | InputFile, other?: Record<string, unknown>) =>
            this.bot.api.sendDocument(chatId, document, { message_thread_id: threadId, ...(other || {}) }),
        } as unknown as Context;
        const scheduledReply = buildChannelReply(threadCtx, chatId, 'RichText');

        // Check if the scheduled task is a watchlist command.
        // If so, execute the command directly using the watchlist handler.
        if (task.message.startsWith('/watchlist') || task.message.startsWith('/wl')) {
          const rawText = task.message.trim();
          const parts = rawText.split(/\s+/).slice(1);
          const subCmd = parts[0]?.toLowerCase();
          if (subCmd === 'report' || subCmd === 'briefing') {
            const segArg = (parts[1]?.toLowerCase() || 'all');
            const segment = parseMarketSegment(segArg);
            const userConfig = loadUserConfig();
            const allowedUsers = userConfig?.allowedUsers || [];
            const userId = chatId > 0 ? chatId : (allowedUsers[0] || 0);

            logger.info(`Routing scheduled task message to watchlist report handler: segment=${segment}, userId=${userId}`);
            const { handleReportGeneration } = await import('./commands/watchlistHandler.js');
            await handleReportGeneration(threadCtx, userId, segment);
            return;
          }
        }

        const session = await this.sessionManager.getOrCreate(chatId, this.defaultOptions, threadId);
        if (session.busy) {
          const msg = `Session busy for chat ${chatId}, skipping scheduled task ${task.id}`;
          logger.warn(msg);
          throw new Error('Session is currently busy with another operation.');
        }

        session.busy = true;
        try {
          await processMessage(
            session,
            { text: task.message },
            scheduledReply,
            telegramFormatter,
          );
        } finally {
          session.busy = false;
        }
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        logger.error(`Scheduled task execution failed: ${errStr}`);
        if (errStr.includes('message thread not found') || errStr.includes('TOPIC_CLOSED') || errStr.includes('TOPIC_DELETED')) {
          logger.warn(`[scheduler] Task ${task.id} thread ${task.threadId} not found, resetting threadId for future executions`);
          task.threadId = undefined;
          void scheduler.updateTaskThreadId(task.id, undefined).catch(() => {});
        }
        try {
          await this.bot.api.sendMessage(chatId, `${ICONS.error} Scheduled task failed: ${errStr}`);
        } catch (notifyErr) {
          logger.warn(`Failed to notify chat ${chatId} about scheduled task failure: ${notifyErr}`);
        }
      }
    }).catch(e => logger.error(`Failed to initialize scheduler: ${e}`));
  }

  async start(): Promise<void> {
    logger.info('Starting Telegram bot...');
    startBackoffCleanup();

    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Start the bot with welcome menu' },
      { command: 'new', description: 'Start a fresh session' },
      { command: 'model', description: 'Switch model (starts new session)' },
      { command: 'status', description: 'Show session statistics' },
      { command: 'settings', description: 'Configure chat settings & parse modes' },
      { command: 'save', description: 'Save formatted response to answer save dir' },
      { command: 'resume', description: 'List or resume a previous session' },
      { command: 'cancel', description: 'Cancel current operation' },
      { command: 'projects', description: 'Browse and select projects' },
      { command: 'schedule', description: 'Schedule a message' },
      { command: 'autopilot', description: 'Auto-reply until goal achieved' },
      { command: 'invest', description: 'Value investing multi-dimension analysis & compare' },
      { command: 'stock', description: 'Query real-time stock & crypto quotes' },
      { command: 'watchlist', description: 'Stock watchlist & daily AI market review briefing' },
      { command: 'read', description: 'Smart summary for ArXiv/GitHub/WeChat/Zhihu/Twitter/Web links' },
      { command: 'sum', description: 'Summarize recent chat messages' },
      { command: 'addfolder', description: 'Add a folder for read+write access' },
      { command: 'id', description: 'Show current session ID' },
      { command: 'help', description: 'Show help message' },
    ]).catch(e => {
      logger.warn(`Failed to set Telegram bot commands during startup: ${e}`);
    });

    logger.info('Telegram bot started. Listening for messages...');

    this.runStartupChecks();
    this.startHealthCheck();

    // Clean up temp media files left over from previous crashes.
    // Only delete files older than 1 hour to avoid removing ones in active use.
    const tempDir = path.join(os.tmpdir(), 'gemini-cli-telegram-media');
    fs.readdir(tempDir).then(async (files) => {
      const now = Date.now();
      for (const file of files) {
        try {
          const filePath = path.join(tempDir, file);
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > 3_600_000) {
            await fs.unlink(filePath).catch(() => {});
          }
        } catch { /* ignore */ }
      }
      logger.info(`[startup] Cleaned up stale temp media files in ${tempDir}`);
    }).catch(() => { /* tempDir may not exist yet — ignore */ });

    // Use @grammyjs/runner for concurrent update processing.
    // This allows /cancel to run even while a message handler is busy.
    this.runner = run(this.bot, {
      runner: {
        fetch: {
          timeout: 60,
          ...RUNNER_ALLOWED_UPDATES,
        },
        silent: true,
      },
    });

    // runner.task() resolves when the runner stops (via runner.stop())
    // Catch errors so 409 Conflict doesn't crash the process via unhandled rejection.
    const runnerTask = this.runner?.task();
    runnerTask?.catch((e) => {
      logger.error(`Runner stopped with error: ${e}`);
    });
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot...');
    this.stopHealthCheck();
    await this.sessionManager.destroyAll();
    await this.bot.stop();
    logger.info('Telegram bot stopped.');
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      void this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    // Never keep the event loop alive just for the health check (test hygiene).
    this.healthCheckInterval.unref?.();
    logger.debug('Health check started');
  }

  /**
   * One-time startup diagnostics: checks config files and backend reachability.
   * Logs warnings on failure but does NOT prevent startup (best-effort).
   */
  private runStartupChecks(): void {
    // ── Config files ──

    try {
      fssync.accessSync(CONFIG_PATH, fssync.constants.R_OK);
      JSON.parse(fssync.readFileSync(CONFIG_PATH, 'utf-8'));
      logger.info('[boot] config.json           OK');
    } catch (e) {
      logger.warn(`[boot] config.json           FAILED — ${e instanceof Error ? e.message : e}`);
    }

    // ── Backend reachability ──
    // Probe the backend's /health endpoint, not its base URL: both backends
    // answer 404 on "/" (only proves a process is listening), while /health
    // actually reports service state.
    // healthPath 可覆盖：HelloGML(GLM) 没有 /health，它的无鉴权探针是 /ping
    const probeBackend = (label: string, baseUrl: string, healthPath = '/health') => {
      let healthUrl: string;
      try {
        healthUrl = new URL(healthPath, baseUrl).toString();
      } catch {
        healthUrl = baseUrl;
      }
      const req = http.get(healthUrl, { timeout: 3000 }, (res) => {
        if (res.statusCode && res.statusCode < 400) {
          logger.info(`[boot] ${label}  OK (HTTP ${res.statusCode})`);
        } else {
          logger.warn(`[boot] ${label}  DEGRADED — ${healthPath} returned HTTP ${res.statusCode}.`);
        }
        res.resume();
      });
      req.on('error', (e) => {
        logger.warn(`[boot] ${label}  UNREACHABLE — ${e.message}. Model routes that depend on this backend will fail until the service starts.`);
      });
      req.on('timeout', () => {
        req.destroy();
        logger.warn(`[boot] ${label}  TIMEOUT — no response in 3s.`);
      });
    };

    const web2apiUrl = getBackendUrl('web2api');
    if (web2apiUrl) {
      probeBackend('Web2API', web2apiUrl);
    } else {
      logger.info('[boot] Web2API              SKIPPED (not configured)');
    }

    const deepseekUrl = getBackendUrl('deepseek');
    if (deepseekUrl) {
      probeBackend('DeepSeek', deepseekUrl);
    } else {
      logger.info('[boot] DeepSeek             SKIPPED (not configured)');
    }

    const glmUrl = getBackendUrl('glm');
    if (glmUrl) {
      probeBackend('GLM', glmUrl, '/ping');
    } else {
      logger.info('[boot] GLM                  SKIPPED (not configured)');
    }

    // Qwen2API@0eb31e4 起有免鉴权 /health（账号池聚合，全灭回 503）
    const qwenUrl = getBackendUrl('qwen');
    if (qwenUrl) {
      probeBackend('Qwen', qwenUrl, '/health');
    } else {
      logger.info('[boot] Qwen                 SKIPPED (not configured)');
    }

    const mimoUrl = getBackendUrl('mimo');
    if (mimoUrl) {
      probeBackend('MiMo', mimoUrl, '/health');
    } else {
      logger.info('[boot] MiMo                 SKIPPED (not configured)');
    }
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.debug('Health check stopped');
    }
  }

  private async performHealthCheck(): Promise<void> {
    try {
      if (!this.runner?.isRunning()) {
        logger.warn('Runner appears to have stopped. Stopping old runner, waiting 5s, then restarting socket without clearing session history...');
        // Stop old runner to release getUpdates connection. `stop()` is async —
        // a bare try/catch would not catch its rejection.
        await this.runner?.stop().catch((err: unknown) => {
          logger.warn(`Failed to stop stalled runner: ${err}`);
        });
        await new Promise((r) => setTimeout(r, 5000));
        try {
          this.runner = run(this.bot, {
            runner: {
              fetch: { timeout: 60, ...RUNNER_ALLOWED_UPDATES },
              silent: false,
            },
          });
          // Catch runner errors to prevent unhandled rejection
          const newTask = this.runner?.task();
          newTask?.catch((e) => {
            logger.error(`Runner stopped with error: ${e}`);
          });
          logger.info('Runner restarted successfully');
        } catch (e) {
          logger.error(`Failed to restart runner: ${e}`);
        }
      }

      const sessions = (this.sessionManager as unknown as { sessions?: Map<number, DaemonSession> }).sessions;
      if (sessions) {
        for (const [, session] of sessions) {
          if (session.busy) {
            const busySince = session._busySince;
            if (busySince && Date.now() - busySince > MAX_MESSAGE_PROCESSING_MS) {
              resetStuckSession(session, 'Health check: session stuck');
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Health check failed: ${e}`);
    }
  }

  private setupMiddleware(allowedUsers?: number[]): void {
    // ── Middleware pipeline (executed in order for each incoming update) ──
    //
    // 1. Diagnostic logging — logs update latency (time from Telegram send to
    //    bot receipt) and per-update processing duration.
    // 2. Sequentialize — ensures messages within the same chat are processed
    //    serially (no race conditions on session state), while /cancel bypasses
    //    the queue so the user can always abort.
    // 3. Whitelist auth — rejects messages from users not in the allowedUsers
    //    list. Without this, any Telegram user could abuse the bot's compute.
    //
    // After these guards, the message handler (setupMessageHandler) runs.

    // RAW callback_query interceptor — fires BEFORE any middleware/auth.
    // Used to diagnose whether Telegram delivers callbacks from non-started users.
    this.bot.on('callback_query', async (ctx, next) => {
      const cq = ctx.callbackQuery;
      logger.info(
        `[RAW_CALLBACK] userId=${ctx.from?.id} data="${cq.data ?? '(none)'}" ` +
        `inline_message_id=${cq.inline_message_id ?? '(none)'} chat_instance=${cq.chat_instance}`
      );
      await next();
    });

    // Diagnostic logging middleware to track update latency
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      const updateId = ctx.update.update_id;
      const message = ctx.message || ctx.editedMessage || ctx.callbackQuery?.message;
      const msgDate = message?.date ? message.date * 1000 : null;
      const updateType = ctx.inlineQuery ? 'inline_query' : ctx.chosenInlineResult ? 'chosen_inline_result' : ctx.message ? 'message' : 'other';
      logger.info(`[Update ${updateId}] Received update (${updateType}). fromId=${ctx.from?.id} Message date: ${msgDate ? new Date(msgDate).toISOString() : 'N/A'}`);
      
      try {
        await next();
      } finally {
        const duration = Date.now() - start;
        logger.info(`[Update ${updateId}] Processed in ${duration}ms`);
      }
    });

    // Global persistence middleware — captures all text/media messages for chat summary
    // before the whitelist middleware blocks unauthorized users.
    this.bot.use(async (ctx, next) => {
      if (ctx.message) {
        persistChatMessage(ctx.message);

        // Trigger typing indicator immediately if this message targets the bot,
        // so the user sees "bot is typing..." before queueing or file downloads.
        try {
          const text = ctx.message.text || ctx.message.caption;
          if (text && ctx.chat) {
            let shouldRespond = false;
            if (ctx.chat.type === 'private') {
              shouldRespond = !text.startsWith('/');
            } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
              const botUsername = ctx.me?.username ?? this.bot.botInfo?.username;
              const botId = ctx.me?.id ?? this.bot.botInfo?.id;
              const isMentioned = botUsername ? text.includes(`@${botUsername}`) : false;
              const isReplyToBot = botId !== undefined && ctx.message.reply_to_message?.from?.id === botId;
              if ((isMentioned || isReplyToBot) && !text.startsWith('/')) {
                shouldRespond = true;
              }
            }
            if (shouldRespond) {
              ctx.replyWithChatAction('typing').catch(() => {});
            }
          }
        } catch (err) {
          logger.warn(`Failed to trigger pre-queue typing action: ${err}`);
        }
      }
      await next();
    });

    // Sequentialize: messages in the same chat run serially,
    // but /cancel gets its own key so it bypasses the queue.
    this.bot.use(sequentialize(getSequentialKey));

    if (!allowedUsers || allowedUsers.length === 0) {
      if (process.env['NODE_ENV'] !== 'test') {
        throw new Error('allowedUsers whitelist is empty or not configured. For security, the bot cannot start.');
      }
      logger.warn('allowedUsers whitelist is empty (Test environment only). Whitelist check bypassed.');
      return;
    }

    const allowedSet = new Set(allowedUsers);
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const callbackData = ctx.callbackQuery?.data;

        // Allow read-only inline page flipping for everyone (final result pagination only)
        if (callbackData && (
          callbackData.startsWith('inline_page:') ||
          callbackData === 'inline_noop' ||
          callbackData === 'inline_thinking'
        )) {
          const inMsgId = ctx.callbackQuery?.inline_message_id ?? '(no inline_message_id)';
          const isAllowed = !!userId && allowedSet.has(userId);
          logger.info(`[Auth] BYPASS inline pagination: userId=${userId} allowed=${isAllowed} data="${callbackData}" inline_message_id=${inMsgId}`);
          await next();
          return;
        }

        if (!userId || !allowedSet.has(userId)) {
          logger.warn(`Unauthorized access attempt from user ${userId}`);
          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
              text: '⚠️ Unauthorized: your Telegram ID is not on the allowed whitelist.',
              show_alert: true,
            }).catch(() => {});
            return;
          }
          if (ctx.chat) {
            await ctx.reply(
              `${ICONS.error} Unauthorized. Your user ID is not in the allowed list.`,
            );
          }
          return;
        }
        await next();
      });
    logger.info(
      `Access restricted to ${allowedUsers.length} user(s): ${allowedUsers.join(', ')}`,
    );
  }

  private setupMessageHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      // Persist non-command messages to the local chat_messages table so that
      // /sum can summarize recent chat history (Bot API cannot fetch history).
      persistChatMessage(ctx.message);

      let promptText = text;

      // In group chats, only respond if the bot is mentioned or replied to
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        const botUsername = ctx.me?.username ?? this.bot.botInfo?.username;
        const botId = ctx.me?.id ?? this.bot.botInfo?.id;
        const isMentioned = botUsername ? text.includes(`@${botUsername}`) : false;
        const isReplyToBot = botId !== undefined && ctx.message.reply_to_message?.from?.id === botId;

        if (!isMentioned && !isReplyToBot) {
          return;
        }

        // Clean up the mention from prompt text to avoid polluting the AI prompt
        if (isMentioned && botUsername) {
          const mentionRegex = new RegExp(`@${botUsername}\\b`, 'gi');
          promptText = text.replace(mentionRegex, '').trim();
          // Mutate ctx.message.text so downstream helper functions see the clean text
          ctx.message.text = promptText;
        }
      }

      if (isPrivateImageRequest(promptText)) {
        await handlePrivateImageRequest(ctx, this.sessionManager, this.defaultOptions);
        return;
      }
      if (promptText.startsWith('/')) return;
      // Send a welcome message for first-time users in private chat
      const chatId = ctx.chat?.id;
      if (chatId && ctx.chat?.type === 'private') {
        const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
        const session = this.sessionManager.getSession(chatId, threadId);
        if (!session) {
          // First message - show welcome with keyboard
          const userName = ctx.from?.first_name;
          await ctx.reply(formatWelcome(userName), {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
        }
      }

      // Extract quoted text (劃词局部引用) or reply_to_message text for Context Enrichment.
      // Prefer the bot's original Markdown from messageCache: bot replies are sent as rich
      // messages whose content lives in rich_message.blocks (not .text/.caption).
      const quoteText = ctx.message.quote?.text;
      const replyToMessage = ctx.message.reply_to_message;
      const replyMsgText = replyToMessage
        ? (messageCache.get(replyToMessage.message_id) ?? replyToMessage.text ?? replyToMessage.caption)
        : undefined;
      const refText = quoteText ?? replyMsgText;

      if (refText && refText.trim()) {
        const cleanRef = refText.trim().slice(0, 1500);
        promptText = `> [Quoted context]: ${cleanRef.replace(/\n/g, '\n> ')}\n\n${promptText}`;
        logger.info(`[ReplyContext] Augmented prompt with quoted/reply text (len=${cleanRef.length}) for chatId=${chatId}`);
      }

      // Check if the replied message contains a media file (photo/video/etc.)
      const repliedMedia = extractMediaFromMessage(replyToMessage);
      let tempFilePath: string | undefined;

      try {
        const input: MultimodalInput = { text: promptText };
        if (repliedMedia) {
          logger.info(`[ReplyMedia] Replying to media type=${repliedMedia.type} in chatId=${chatId}`);
          tempFilePath = await downloadTelegramFile(ctx, repliedMedia.fileId, this.proxyAgent);
          input.media = [
            {
              type: repliedMedia.type,
              path: tempFilePath!,
              mimeType: repliedMedia.mimeType,
              fileName: repliedMedia.fileName,
            },
          ];
        }

        await this.processUserMessage(ctx, input, ctx.message.message_id);
      } finally {
        if (tempFilePath) {
          await fs.unlink(tempFilePath).catch((e) =>
            logger.warn(`Failed to clean up temp file ${tempFilePath}: ${e}`),
          );
        }
      }
    });

    this.bot.on('message:photo', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleAlbumOrSingle(ctx, 'photo');
    });

    this.bot.on('message:voice', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleMediaMessage(ctx, 'voice');
    });

    this.bot.on('message:audio', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleMediaMessage(ctx, 'audio');
    });

    this.bot.on('message:video', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleAlbumOrSingle(ctx, 'video');
    });

    this.bot.on('message:document', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleAlbumOrSingle(ctx, 'document');
    });

    this.bot.on('message:sticker', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleMediaMessage(ctx, 'sticker');
    });

    this.bot.on('message:animation', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleMediaMessage(ctx, 'animation');
    });

    this.bot.on('message:video_note', async (ctx) => {
      persistChatMessage(ctx.message);
      await this.handleMediaMessage(ctx, 'video_note');
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      logger.error(
        err.error,
        `Bot error in middleware (chatId: ${ctx.chat?.id}, updateId: ${ctx.update.update_id})`,
      );
    });
  }

  private async processUserMessage(
    ctx: Context,
    input: MultimodalInput,
    replyToMessageId?: number,
  ): Promise<void> {
    await withSession(
      this.sessionManager,
      ctx,
      this.defaultOptions,
      async (session, channelReply) => {
        await processMessage(
          session,
          input,
          channelReply,
          telegramFormatter,
        );
        reset429Backoff(Number(session.chatId));

        // Handle autopilot / self-reply until
        await this.handleAutopilot(session, channelReply, ctx);
      },
      replyToMessageId,
    );
  }

  private async handleAutopilot(
    session: DaemonSession,
    channelReply: ChannelReply,
    ctx: Context,
  ): Promise<void> {
    while (session.autopilot?.active) {
      const autopilot = session.autopilot;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      // Increment iteration
      autopilot.currentIteration++;

      // Check timeout condition
      const startTime = autopilot.startTime || Date.now();
      const timeoutMs = autopilot.timeoutMs || 30 * 60 * 1000;
      if (Date.now() - startTime >= timeoutMs) {
        await channelReply.send(`${ICONS.warning} <b>Autopilot Timed Out</b>\nExceeded maximum execution time limit (30 minutes). Pausing autopilot.`);
        autopilot.active = false;
        return;
      }

      // Build the self-reply prompt
      const selfReplyText = [
        `<system>`,
        `You are in autopilot mode. Current Goal: "${autopilot.goal}"`,
        `Step Count: ${autopilot.currentIteration}`,
        `Instructions:`,
        `1. Provide full, detailed answers and complete output for this step. Do NOT truncate or abbreviate your response.`,
        `2. If you have completely fulfilled the overall goal, provide your full report/answer first, then output "AUTOPILOT_COMPLETE: <summary>" on a new line at the very end.`,
        `3. If blocked or unable to proceed, output "AUTOPILOT_STOP: <reason>" on a new line at the end.`,
        `4. Otherwise, state your findings and continue to the next step.`,
        `</system>`,
      ].join('\n');

      // Small delay between iterations
      await new Promise((r) => setTimeout(r, 2000));

      // Check if user cancelled during delay
      if (!session.autopilot?.active) return;

      try {
        // Record current cache state before iteration
        const prevContext = messageCache.getLastReplyContextForChat(chatId);

        await processMessage(
          session,
          { text: selfReplyText },
          channelReply,
          telegramFormatter,
        );

        // Fetch fresh context after this iteration
        const currentContext = messageCache.getLastReplyContextForChat(chatId);
        if (currentContext && currentContext !== prevContext) {
          const fullText = currentContext.answerMarkdown;
          if (fullText.includes('AUTOPILOT_COMPLETE') || fullText.includes('AUTOPILOT_STOP')) {
            const isComplete = fullText.includes('AUTOPILOT_COMPLETE');
            const signalTag = isComplete ? 'AUTOPILOT_COMPLETE' : 'AUTOPILOT_STOP';
            const summaryMatch = fullText.split(signalTag)[1]?.trim().split('\n')[0] || 'Task finished.';

            autopilot.active = false;
            // Send additional completion banner AFTER the full AI response has already been displayed
            await channelReply.send(
              isComplete
                ? `${ICONS.success} <b>Autopilot Completed Goal</b>\n\n<b>Summary:</b> <i>${escapeHtml(summaryMatch)}</i>`
                : `${ICONS.warning} <b>Autopilot Stopped</b>\n\n<b>Reason:</b> <i>${escapeHtml(summaryMatch)}</i>`,
            );
            return;
          }
        }
      } catch (e) {
        logger.error(`Autopilot iteration failed: ${e}`);
        autopilot.active = false;
        await channelReply.send(`${ICONS.error} <b>Autopilot stopped</b> — error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
  }

  private async handleAlbumOrSingle(
    ctx: Context,
    mediaType: TelegramMediaType,
  ): Promise<void> {
    const groupId = ctx.message?.media_group_id;
    if (!groupId) {
      await this.handleMediaMessage(ctx, mediaType);
      return;
    }

    const info = extractMediaInfo(ctx, mediaType);
    if (!info) {
      await ctx.reply(`${ICONS.error} Could not retrieve ${mediaType} file info.`);
      return;
    }

    const existing = this.albumBuffer.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push({ mediaType, info, ctx });
      existing.timer = setTimeout(() => {
        void this.flushAlbum(groupId);
      }, TelegramBot.ALBUM_FLUSH_MS);
    } else {
      this.albumBuffer.set(groupId, {
        chatId: ctx.chat?.id ?? 0,
        items: [{ mediaType, info, ctx }],
        timer: setTimeout(() => {
          void this.flushAlbum(groupId);
        }, TelegramBot.ALBUM_FLUSH_MS),
      });
    }
  }

  private async flushAlbum(groupId: string): Promise<void> {
    await flushAlbumBuffer(
      this.albumBuffer,
      groupId,
      this.sessionManager,
      this.defaultOptions,
      this.proxyAgent,
    );
  }

  private async handleMediaMessage(
    ctx: Context,
    mediaType: TelegramMediaType,
  ): Promise<void> {
    await handleSingleMediaMessage(
      ctx,
      mediaType,
      this.sessionManager,
      this.defaultOptions,
      this.proxyAgent,
    );
  }
}
