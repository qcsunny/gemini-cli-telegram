import { logger } from '../../../utils/logger.js';

const BACKOFF_CLEANUP_INTERVAL = 300_000;

export const draftBackoffUntil = new Map<number, number>();
const draftBackoffMultiplier = new Map<number, number>();

let _backoffCleanupTimer: ReturnType<typeof setInterval> | undefined;

/** Start periodic cleanup of expired backoff entries. */
export function startBackoffCleanup(): void {
  if (_backoffCleanupTimer) return;
  _backoffCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, until] of draftBackoffUntil) {
      if (now >= until) {
        draftBackoffUntil.delete(chatId);
        draftBackoffMultiplier.delete(chatId);
      }
    }
  }, BACKOFF_CLEANUP_INTERVAL);
  _backoffCleanupTimer.unref();
}

export function record429Backoff(chatId: number, retryAfterSec?: number): void {
  const mult = Math.min((draftBackoffMultiplier.get(chatId) ?? 1) * 2, 8);
  draftBackoffMultiplier.set(chatId, mult);

  const baseWait = retryAfterSec ? retryAfterSec * 1000 : 1000;
  const waitMs = baseWait * mult + 100;
  const existingUntil = draftBackoffUntil.get(chatId) ?? 0;
  const nextUntil = Math.max(existingUntil, Date.now() + waitMs);
  draftBackoffUntil.set(chatId, nextUntil);
  logger.warn(`[429 BACKOFF] Dynamic rate-limit backoff set for chatId=${chatId}: wait ${waitMs}ms (mult=${mult})`);
}

export function reset429Backoff(chatId: number): void {
  draftBackoffMultiplier.delete(chatId);
  draftBackoffUntil.delete(chatId);
}

export function is429Error(err: any): boolean {
  if (!err) return false;
  if (err.error_code === 429 || err.status === 429) return true;
  if (err.parameters?.retry_after !== undefined) return true;
  if (err.payload?.parameters?.retry_after !== undefined) return true;
  const msg = String(err.message || err);
  return msg.includes('429') || msg.includes('Too Many Requests');
}

export function get429RetryAfter(err: any): number | undefined {
  if (typeof err?.parameters?.retry_after === 'number') return err.parameters.retry_after;
  if (typeof err?.payload?.parameters?.retry_after === 'number') return err.payload.parameters.retry_after;
  return undefined;
}
