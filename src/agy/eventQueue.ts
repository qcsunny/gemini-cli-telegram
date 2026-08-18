/**
 * @file eventQueue.ts
 * @description Serialized, rejection-safe delivery of streaming events to an
 * `onEvent` handler.
 *
 * Every backend streams `thought` / `text` / `done` events to a caller-supplied
 * handler that **may be async** (`messageLoop`'s handler edits Telegram messages
 * and awaits its tail re-chunker). Calling it fire-and-forget breaks two things:
 *
 *   1. **Ordering** — a slow `text` handler can be overtaken by the `done` that
 *      follows it, so finalize's `isFinished` guard skips the last edits.
 *   2. **Crash safety** — a rejected handler becomes an unhandled rejection,
 *      which terminates the process by default on Node 20+.
 *
 * `createEventQueue` chains handler invocations so each one starts only after the
 * previous settles, and swallows (but logs) failures so one bad frame cannot kill
 * the stream. `drain()` lets a backend wait for the queue before resolving its
 * run — the `done` event must be fully processed before the run is considered
 * finished.
 */
import type { AgyRunOptions, AgyStreamEvent } from './types.js';
import { logger } from '../utils/logger.js';

export interface EventQueue {
  /** Enqueue an event. Never throws, never returns a promise. */
  emit(event: AgyStreamEvent): void;
  /** Resolves once every event enqueued so far has been handled. */
  drain(): Promise<void>;
}

export function createEventQueue(onEvent: AgyRunOptions['onEvent'], tag: string): EventQueue {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    emit(event: AgyStreamEvent): void {
      chain = chain
        .then(() => onEvent?.(event))
        .catch((err: unknown) => {
          logger.warn(`[${tag}] onEvent handler failed (continuing stream): ${err}`);
        });
    },
    async drain(): Promise<void> {
      await chain;
    },
  };
}
