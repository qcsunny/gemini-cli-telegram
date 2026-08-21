/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file draftThrottle.ts
 * @description Adaptive per-chat draft-update pacing with 429 backoff.
 * Extracted from channelReply.ts: the throttle state machine that starts
 * optimistic (250ms), expands x2 on 429 (floored by retry-after, capped at
 * 4s), recovers x0.85 on clean success, and de-dups meaningless micro-edits.
 */

import { logger } from '../../../utils/logger.js';
import { draftBackoffUntil, recordBackoffSuccess } from './rateLimiter.js';

interface DraftThrottleState {
  currentMs: number;
  lastEditTime: number;
  lastSentLen: number;
  nextAllowedTime: number;
}
const draftThrottleStates = new Map<number, DraftThrottleState>();
const DRAFT_THROTTLE_MIN_MS = 250;
const DRAFT_THROTTLE_MAX_MS = 4000;

/** Drop per-chat draft pacing & 429 backoff state (called when a turn ends). */
export function clearDraftThrottleState(chatId: number): void {
  draftThrottleStates.delete(chatId);
  draftBackoffUntil.delete(chatId);
}

/**
 * Draft update pacing — adaptive version (ported from InlineQueue):
 *
 *  • Starts optimistic at DRAFT_THROTTLE_MIN_MS (250ms) for smooth typing.
 *  • On 429 the per-chat window expands (x2, floored by the server's
 *    retry-after) up to DRAFT_THROTTLE_MAX_MS, so a rate-limited chat slows
 *    itself down instead of throwing every edit and killing the stream.
 *  • On a clean success the window gradually recovers toward the minimum
 *    (x0.85), mirroring the inline path.
 *  • Skips the edit entirely when too soon AND the content grew by <15 chars
 *    (de-dup, avoids meaningless full re-edits of unchanged text).
 *  • The module-level 429 backoff (draftBackoffUntil) still overrides
 *    everything and force-waits until the retry-after window expires.
 *
 * Returns true when an edit should proceed, false when skipped (no-op).
 * A `draftThrottleMs: 0` option disables pacing entirely (tests).
 */
export async function throttleDraft(chatId: number, contentLen: number, disabled = false): Promise<boolean> {
  if (disabled) return true;
  const now = Date.now();
  let st = draftThrottleStates.get(chatId);
  if (!st) {
    st = { currentMs: DRAFT_THROTTLE_MIN_MS, lastEditTime: 0, lastSentLen: -1, nextAllowedTime: 0 };
    draftThrottleStates.set(chatId, st);
  }

  // Global 429 backoff (retry-after window) overrides everything. Sleep in
  // bounded slices so /cancel or shutdown can interrupt long waits.
  const backoffUntil = draftBackoffUntil.get(chatId) ?? 0;
  if (now < backoffUntil) {
    logger.info(`[429 BACKOFF] Throttling draft update for chatId=${chatId} due to active 429 backoff (${backoffUntil - now}ms left)`);
    await sleepInterruptibly(backoffUntil - now);
  }
  if (now < st!.nextAllowedTime) {
    await sleepInterruptibly(st!.nextAllowedTime - now);
  }

  const elapsed = now - st!.lastEditTime;
  const textDelta = Math.abs(contentLen - st!.lastSentLen);

  // Too soon AND barely changed → skip this edit entirely (no-op).
  if (elapsed < st!.currentMs && textDelta < 15) {
    const wait = Math.max(50, st!.currentMs - elapsed);
    await new Promise(r => setTimeout(r, wait));
    return false;
  }
  // Too soon but meaningful growth → still pace to the window, then edit.
  if (elapsed < st!.currentMs) {
    await new Promise(r => setTimeout(r, st!.currentMs - elapsed));
  }
  return true;
}

export function markDraftEditSuccess(chatId: number, contentLen: number): void {
  const st = draftThrottleStates.get(chatId);
  if (st) {
    st.lastEditTime = Date.now();
    st.lastSentLen = contentLen;
    // Gradually recover the throttle window toward the minimum on clean success.
    st.currentMs = Math.max(DRAFT_THROTTLE_MIN_MS, Math.floor(st.currentMs * 0.85));
  }
  // Decay the module-level 429 multiplier and cap remaining backoff on success
  // so one big 429 cannot freeze the chat for the whole turn.
  recordBackoffSuccess(chatId);
}

/**
 * Sleep in ≤1s slices so /cancel, shutdown or a later backoff reset can
 * interleave with the wait loop; the event loop gets a chance to process the
 * reset/cancel callbacks between slices instead of blocking for the full
 * backoff duration.
 */
async function sleepInterruptibly(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
}

export function markDraft429(chatId: number, retryAfterSec?: number): void {
  const st = draftThrottleStates.get(chatId);
  const backoffMs = (retryAfterSec ?? 1) * 1000;
  if (st) {
    st.nextAllowedTime = Date.now() + backoffMs;
    // Adaptively expand the throttle window on 429.
    st.currentMs = Math.min(DRAFT_THROTTLE_MAX_MS, Math.max(st.currentMs * 2, backoffMs));
  }
}

