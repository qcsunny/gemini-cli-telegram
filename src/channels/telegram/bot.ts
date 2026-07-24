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
 */

import { Bot, Context } from 'grammy';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { run, sequentialize } from '@grammyjs/runner';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import { SessionManager } from '../../core/session.js';
import { processMessage } from '../../core/messageLoop.js';
import { createTelegramSendMedia } from './outbound.js';
import type {
  ChannelReply,
  SessionOptions,
  DaemonSession,
  MultimodalInput,
  StructuredMessage,
} from '../../core/types.js';
import { registerCommands } from './commands.js';
import { telegramFormatter, markdownToHtml } from './formatter.js';
import { logger } from '../../utils/logger.js';
import { ICONS, formatWelcome, buildMainKeyboard, escapeHtml } from './ui.js';
import { messageCache } from '../../utils/messageCache.js';
import { CONFIG_PATH, getBackendUrl } from '../../config/userConfig.js';
import { buildChannelReply } from './bot/channelReply.js';
import { startBackoffCleanup } from './bot/rateLimiter.js';

const TYPING_KEEPALIVE_MS = 3000;

export { record429Backoff, reset429Backoff, is429Error, get429RetryAfter, startBackoffCleanup } from './bot/rateLimiter.js';
export { buildChannelReply } from './bot/channelReply.js';

// ── Constants ──

const TYPING_TTL_MS = 3_600_000;
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_MS = 1000;
const MAX_MESSAGE_PROCESSING_MS = 960_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

// ── Helper: getHtmlPayload (used by TelegramBot.setupScheduler) ──

function getHtmlPayload(originalText: string | StructuredMessage, isStreaming = false): string {
  if (typeof originalText === 'string' && originalText.startsWith('___RAW_HTML___')) {
    return originalText.substring('___RAW_HTML___'.length);
  }
  return markdownToHtml(originalText, isStreaming);
}

// ── Types ──

export interface TelegramBotOptions {
  allowedUsers?: number[];
  model?: string;
  cwd?: string;
  proxy?: string;
}

// ── Sequentialize key ──

function getSequentialKey(ctx: any): string | undefined {
  if (ctx.callbackQuery) {
    return undefined;
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return undefined;
  const text = ctx.message?.text ?? '';
  if (text.startsWith('/cancel')) {
    return `control:${chatId}`;
  }
  return `chat:${chatId}`;
}

/**
 * Gracefully kill any hung child process and reset the busy state of a stuck session.
 */
function resetStuckSession(session: DaemonSession, reason: string): void {
  logger.warn(`Resetting stuck session (childPid=${session.childPid ?? 'none'}): ${reason}`);
  if (session.childPid !== undefined) {
    try {
      process.kill(session.childPid, 'SIGKILL');
      logger.info(`Stuck session cleanup: sent SIGKILL to agy pid ${session.childPid}`);
    } catch (killErr) {
      logger.warn(`Stuck session cleanup: failed to kill pid ${session.childPid}: ${killErr}`);
    }
  }
  session.abortController.abort(reason);
  session.abortController = new AbortController();
  session.busy = false;
  session._busySince = undefined;
  session.childPid = undefined;
}

/**
 * Wrap a handler with session acquisition, typing indicator, and cleanup.
 */
async function withSession(
  sessionManager: SessionManager,
  ctx: Context,
  defaultOptions: SessionOptions,
  handler: (session: DaemonSession, channelReply: ChannelReply) => Promise<void>,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  let session;
  try {
    session = await sessionManager.getOrCreate(chatId, defaultOptions);
  } catch (e) {
    logger.error(`Failed to create session for chat ${chatId}: ${e}`);
    await ctx.reply(`${ICONS.error} Failed to initialize session: ${e}`);
    return;
  }

  // Check if session appears stuck (busy for too long)
  if (session.busy) {
    const now = Date.now();
    const busySince = session._busySince;
    if (busySince && now - busySince > MAX_MESSAGE_PROCESSING_MS) {
      resetStuckSession(session, 'Session timeout (stuck)');
      try {
        await ctx.reply(`${ICONS.warning} Previous operation timed out and was cancelled. Please try again.`);
      } catch { /* ignore */ }
      return;
    }
    
    await ctx.reply(
      `${ICONS.warning} Still processing your previous message. Use /cancel to abort it.`,
    );
    return;
  }

  // Ensure we have a fresh abort controller if the previous one was aborted
  if (session.abortController.signal.aborted) {
    logger.debug(`Session for chat ${chatId} had an aborted signal. Resetting abort controller.`);
    session.abortController = new AbortController();
  }

  session.busy = true;
  (session as { _busySince?: number })._busySince = Date.now();

  // Reset circuit breaker for rich drafts on each new user-initiated session interaction
  if (session.draftsDisabled || (session.consecutiveDraftFailures && session.consecutiveDraftFailures > 0)) {
    logger.info(`Resetting drafts circuit breaker for chat ${chatId} as a new user message session has started.`);
    session.draftsDisabled = false;
    session.consecutiveDraftFailures = 0;
  }

  session.typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, TYPING_KEEPALIVE_MS);
  ctx.replyWithChatAction('typing').catch(() => {});

  const typingTtl = setTimeout(() => {
    logger.warn(
      `Chat ${chatId}: typing TTL exceeded (${TYPING_TTL_MS}ms), auto-clearing`,
    );
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = undefined;
    }
  }, TYPING_TTL_MS);

  const parseMode = session.settings?.telegram?.parseMode || 'RichText';
  try {
    await handler(session, buildChannelReply(ctx, chatId, parseMode, session));
  } catch (e) {
    logger.error(`Error in handler for chat ${chatId}: ${e}`);
    try {
      await ctx.reply(
        `${ICONS.error} <b>Operation failed:</b>\n<i>${e instanceof Error ? e.message : String(e)}</i>`,
        { parse_mode: 'HTML' }
      );
    } catch {
      // ignore reply failures
    }
  } finally {
    clearTimeout(typingTtl);
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = undefined;
    }
    session.busy = false;
    (session as { _busySince?: number })._busySince = undefined;
  }
}

/**
 * Download a file from Telegram with retry + exponential backoff.
 * Uses ctx.api.token instead of env var so --token flag works.
 */
async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  proxyAgent?: ProxyAgent,
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram file_path not found.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await undiciFetch(fileUrl, {
        dispatcher: proxyAgent,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const tempDir = path.join(os.tmpdir(), 'gemini-cli-telegram-media');
      await fs.mkdir(tempDir, { recursive: true });

      // Use unique filename to avoid collisions from concurrent downloads
      const ext = path.extname(file.file_path) || '';
      const localFilePath = path.join(
        tempDir,
        `${crypto.randomUUID()}${ext}`,
      );

      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(localFilePath, Buffer.from(arrayBuffer));

      return localFilePath;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        const delay = DOWNLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `File download attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(
    `Failed to download file after ${DOWNLOAD_MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}

/** Supported Telegram media types for extraction. */
type TelegramMediaType = 'photo' | 'voice' | 'audio' | 'video' | 'document';

/** Extracted info from a Telegram media message. */
interface TelegramMediaInfo {
  fileId: string;
  mimeType: string;
  caption?: string;
  fileName?: string;
}

/**
 * Extract file ID, MIME type, and optional file name from a Telegram media message.
 */
function extractMediaInfo(
  ctx: Context,
  mediaType: TelegramMediaType,
): TelegramMediaInfo | undefined {
  const msg = ctx.message as {
    caption?: string;
    photo?: { file_id: string }[];
    voice?: { file_id: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string; file_name?: string };
    video?: { file_id: string; mime_type?: string; file_name?: string };
    document?: { file_id: string; mime_type?: string; file_name?: string };
  } | undefined;
  if (!msg) return undefined;
  const caption = msg.caption;

  if (mediaType === 'photo') {
    const photos = msg.photo;
    if (!photos || photos.length === 0) return undefined;
    const photo = photos[photos.length - 1];
    if (!photo) return undefined;
    return { fileId: photo.file_id, mimeType: 'image/jpeg', caption };
  } else if (mediaType === 'voice') {
    const voice = msg.voice;
    if (!voice) return undefined;
    return { fileId: voice.file_id, mimeType: voice.mime_type || 'audio/ogg', caption };
  } else if (mediaType === 'audio') {
    const audio = msg.audio;
    if (!audio) return undefined;
    return { fileId: audio.file_id, mimeType: audio.mime_type || 'audio/mpeg', caption, fileName: audio.file_name };
  } else if (mediaType === 'video') {
    const video = msg.video;
    if (!video) return undefined;
    return { fileId: video.file_id, mimeType: video.mime_type || 'video/mp4', caption, fileName: video.file_name };
  } else if (mediaType === 'document') {
    const doc = msg.document;
    if (!doc) return undefined;
    return { fileId: doc.file_id, mimeType: doc.mime_type || 'application/octet-stream', caption, fileName: doc.file_name };
  }
  return undefined;
}

export class TelegramBot {
  private bot: Bot;
  private runner: ReturnType<typeof run> | undefined;
  private sessionManager: SessionManager;
  private defaultOptions: SessionOptions;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private proxyAgent: ProxyAgent | undefined;

  constructor(token: string, options: TelegramBotOptions = {}) {
    const clientConfig: any = {};
    if (options.proxy) {
      this.proxyAgent = new ProxyAgent(options.proxy);
      clientConfig.baseFetchConfig = {
        dispatcher: this.proxyAgent,
        compress: true,
      };
      clientConfig.fetch = async (url: any, init: any) => {
        const cleanInit = init ? { ...init } : {};
        delete cleanInit.signal;
        // Retry transient proxy/network failures so a dropped long-poll
        // connection recovers instead of stalling update delivery.
        let lastErr: any;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await undiciFetch(url, {
              ...cleanInit,
              dispatcher: this.proxyAgent,
            });
          } catch (e: any) {
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
    );
    this.setupMessageHandler();
    this.setupScheduler();
  }

  private setupScheduler(): void {
    const scheduler = this.sessionManager.getChatScheduler();
    scheduler.initialize(async (task) => {
      const chatId = task.chatId;
      logger.info(`Executing scheduled task ${task.id} for chat ${chatId}`);

      try {
        const safeEdit = async (messageId: number, text: string, html = true) => {
          try {
            const final = text.startsWith('___RAW_HTML___') ? text.substring('___RAW_HTML___'.length) : text;
            await this.bot.api.editMessageText(chatId, messageId, final, html ? { parse_mode: 'HTML' } : {});
          } catch (e: any) {
            if (!e?.description?.includes('message is not modified')) {
              logger.warn(`Scheduler failed to edit message ${messageId}: ${e}`);
            }
          }
        };

        // Build a custom ChannelReply for scheduled messages
        const scheduledReply: ChannelReply = {
          send: async (text: string): Promise<number> => {
            const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
            return msg.message_id;
          },
          edit: async (messageId: number, newText: string): Promise<void> => {
            await safeEdit(messageId, newText, true);
          },
          sendPlain: async (text: string): Promise<number> => {
            const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
            return msg.message_id;
          },
          editPlain: async (messageId: number, newText: string): Promise<void> => {
            await safeEdit(messageId, newText, false);
          },
          sendDocument: async (filePath: string, caption?: string): Promise<void> => {
            await this.bot.api.sendMessage(chatId, caption || 'Document: ' + filePath);
          },
          delete: async (messageId: number): Promise<void> => {
            await this.bot.api.deleteMessage(chatId, messageId);
          },
          sendRich: async (text: string | StructuredMessage): Promise<number> => {
            return await scheduledReply.send(typeof text === 'string' ? text : getHtmlPayload(text));
          },
          sendRichDraft: async (text: string | StructuredMessage): Promise<number> => {
            return await scheduledReply.send(typeof text === 'string' ? text : getHtmlPayload(text));
          },
          editRich: async (messageId: number, newText: string | StructuredMessage): Promise<void> => {
            await scheduledReply.edit(messageId, typeof newText === 'string' ? newText : getHtmlPayload(newText));
          },
          editRichDraft: async (draftId: number, newText: string | StructuredMessage): Promise<void> => {
            await scheduledReply.edit(draftId, typeof newText === 'string' ? newText : getHtmlPayload(newText));
          },
        };

        const session = await this.sessionManager.getOrCreate(chatId, this.defaultOptions);
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
        logger.error(`Scheduled task execution failed: ${e}`);
        try {
          await this.bot.api.sendMessage(chatId, `${ICONS.error} Scheduled task failed: ${e instanceof Error ? e.message : String(e)}`);
        } catch { /* ignore */ }
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
      { command: 'save', description: 'Save formatted response to inbox' },
      { command: 'resume', description: 'List or resume a previous session' },
      { command: 'cancel', description: 'Cancel current operation' },
      { command: 'projects', description: 'Browse and select projects' },
      { command: 'schedule', description: 'Schedule a message' },
      { command: 'autopilot', description: 'Auto-reply until goal achieved' },
      { command: 'addfolder', description: 'Add a folder for read+write access' },
      { command: 'id', description: 'Show current session ID' },
      { command: 'help', description: 'Show help message' },
    ]);

    logger.info('Telegram bot started. Listening for messages...');

    this.runStartupChecks();
    this.startHealthCheck();

    // Use @grammyjs/runner for concurrent update processing.
    // This allows /cancel to run even while a message handler is busy.
    this.runner = run(this.bot, {
      runner: {
        // Shorter long-poll timeout so the proxy can't silently kill an idle
        // 30s connection (which caused updates to pile up and redeliver late).
        fetch: { timeout: 10 },
        silent: true,
      },
    });

    // runner.task() resolves when the runner stops (via runner.stop())
    await this.runner.task();
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot...');
    this.stopHealthCheck();
    await this.sessionManager.destroyAll();
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
    logger.info('Telegram bot stopped.');
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      void this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
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
    const probeBackend = (label: string, url: string) => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        logger.info(`[boot] ${label}  OK (HTTP ${res.statusCode})`);
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
        logger.warn('Runner appears to have stopped. Attempting restart...');
        try {
          this.runner = run(this.bot, {
            runner: {
              fetch: { timeout: 30 },
              silent: true,
            },
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

    // Diagnostic logging middleware to track update latency
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      const updateId = ctx.update.update_id;
      const message = ctx.message || ctx.editedMessage || ctx.callbackQuery?.message;
      const msgDate = message?.date ? message.date * 1000 : null;
      const dateDiff = msgDate ? (start - msgDate) / 1000 : null;
      
      logger.info(`[Update ${updateId}] Received update. Message date: ${msgDate ? new Date(msgDate).toISOString() : 'N/A'}. Delay from sending: ${dateDiff !== null ? dateDiff.toFixed(2) + 's' : 'N/A'}`);
      
      try {
        await next();
      } finally {
        const duration = Date.now() - start;
        logger.info(`[Update ${updateId}] Processed in ${duration}ms`);
      }
    });

    // Sequentialize: messages in the same chat run serially,
    // but /cancel gets its own key so it bypasses the queue.
    this.bot.use(sequentialize(getSequentialKey));

    if (allowedUsers && allowedUsers.length > 0) {
      const allowedSet = new Set(allowedUsers);
      this.bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId || !allowedSet.has(userId)) {
          logger.warn(`Unauthorized access attempt from user ${userId}`);
          await ctx.reply(
            `${ICONS.error} Unauthorized. Your user ID is not in the allowed list.`,
          );
          return;
        }
        await next();
      });
      logger.info(
        `Access restricted to ${allowedUsers.length} user(s): ${allowedUsers.join(', ')}`,
      );
    } else {
      logger.warn(
        'No allowed users configured. Bot is accessible to everyone.',
      );
    }
  }

  private setupMessageHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) return;

      // Send a welcome message for first-time users
      const chatId = ctx.chat?.id;
      if (chatId) {
        const session = this.sessionManager.getSession(chatId);
        if (!session) {
          // First message - show welcome with keyboard
          const userName = ctx.from?.first_name;
          await ctx.reply(formatWelcome(userName), {
            parse_mode: 'HTML',
            reply_markup: buildMainKeyboard(),
          });
        }
      }

      await this.processUserMessage(ctx, { text });
    });

    this.bot.on('message:photo', async (ctx) => {
      await this.handleMediaMessage(ctx, 'photo');
    });

    this.bot.on('message:voice', async (ctx) => {
      await this.handleMediaMessage(ctx, 'voice');
    });

    this.bot.on('message:audio', async (ctx) => {
      await this.handleMediaMessage(ctx, 'audio');
    });

    this.bot.on('message:video', async (ctx) => {
      await this.handleMediaMessage(ctx, 'video');
    });

    this.bot.on('message:document', async (ctx) => {
      await this.handleMediaMessage(ctx, 'document');
    });

    this.bot.catch((err) => {
      logger.error(`Bot error: ${err.message}`);
    });
  }

  private async processUserMessage(
    ctx: Context,
    input: MultimodalInput,
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

        // Handle autopilot / self-reply until
        await this.handleAutopilot(session, channelReply, ctx);
      },
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
        const prevContext = messageCache.getLastReplyContext();

        await processMessage(
          session,
          { text: selfReplyText },
          channelReply,
          telegramFormatter,
        );

        // Fetch fresh context after this iteration
        const currentContext = messageCache.getLastReplyContext();
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

  private async handleMediaMessage(
    ctx: Context,
    mediaType: TelegramMediaType,
  ): Promise<void> {
    const info = extractMediaInfo(ctx, mediaType);
    if (!info) {
      await ctx.reply(`${ICONS.error} Could not retrieve ${mediaType} file info.`);
      return;
    }

    let tempFilePath: string | undefined;

    await withSession(
      this.sessionManager,
      ctx,
      this.defaultOptions,
      async (session, channelReply) => {
        tempFilePath = await downloadTelegramFile(ctx, info.fileId, this.proxyAgent);

        const multimodalInput: MultimodalInput = {
          text: info.caption,
          media: [
            {
              type: mediaType,
              path: tempFilePath,
              mimeType: info.mimeType,
              fileName: info.fileName,
            },
          ],
        };

        try {
          await processMessage(
            session,
            multimodalInput,
            channelReply,
            telegramFormatter,
          );
        } finally {
          if (tempFilePath) {
            await fs
              .unlink(tempFilePath)
              .catch((e) =>
                logger.warn(`Failed to delete temp file: ${e}`),
              );
          }
        }
      },
    );
  }
}
