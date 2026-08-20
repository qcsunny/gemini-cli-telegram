/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file withSession.ts
 * @description Helper for wrapping Telegram handlers with session acquisition, typing indicator, and cleanup.
 */

import type { Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type {
  ChannelReply,
  SessionOptions,
  DaemonSession,
} from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { ICONS } from '../ui.js';
import { buildChannelReply, clearDraftThrottleState } from './channelReply.js';

/** How often to refresh the "typing…" chat action while a turn is active. */
const TYPING_KEEPALIVE_MS = 3000;
/** Hard ceiling after which the typing indicator is force-cleared. */
const TYPING_TTL_MS = 3_600_000;
/** After this long busy, a session is treated as stuck and reset. */
export const MAX_MESSAGE_PROCESSING_MS = 960_000;

/**
 * Clear a session that has been busy too long: abort any running child,
 * stop the typing indicator, and release the busy flag so the next message
 * can start cleanly.
 */
export function resetStuckSession(session: DaemonSession, reason: string): void {
  logger.warn(
    `Resetting stuck session ${session.sessionId} (busy for ${
      Date.now() - (session._busySince || 0)
    }ms): ${reason}`,
  );
  try {
    session.abortController.abort();
  } catch (e) {
    logger.warn(`Failed to abort stuck session: ${e}`);
  }
  if (session.typingInterval) {
    clearInterval(session.typingInterval);
    session.typingInterval = undefined;
  }
  session.busy = false;
  session._busySince = undefined;
  session.childPid = undefined;
}

/**
 * Wrap a handler with session acquisition, typing indicator, and cleanup.
 */
export async function withSession(
  sessionManager: SessionManager,
  ctx: Context,
  defaultOptions: SessionOptions,
  handler: (session: DaemonSession, channelReply: ChannelReply) => Promise<void>,
  replyToMessageId?: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;

  let session: DaemonSession;
  try {
    session = await sessionManager.getOrCreate(chatId, defaultOptions, threadId);
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
  session._busySince = Date.now();

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
  const reply = buildChannelReply(ctx, chatId, parseMode, session, replyToMessageId);

  try {
    await handler(session, reply);
  } catch (e: unknown) {
    logger.error(`Error in handler for chat ${chatId}: ${e}`);
    const apiError = typeof e === 'object' && e !== null ? e as { description?: unknown; error_code?: unknown } : undefined;
    const isBlocked = (typeof apiError?.description === 'string' && apiError.description.includes('bot was blocked by the user')) || apiError?.error_code === 403;
    if (isBlocked) {
      logger.warn(`Bot was blocked by user in chat ${chatId}. Cleaning up session.`);
      // Cleanup must not mask the original handler error, so swallow its own failure.
      await sessionManager.destroy(chatId, threadId).catch((err: unknown) => {
        logger.warn(`Session cleanup failed for chat ${chatId}: ${err}`);
      });
      return;
    }
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
    session._busySince = undefined;
    // Drop per-chat draft pacing/backoff state so the next turn starts fresh.
    clearDraftThrottleState(chatId);
  }
}
