/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import { getTuningConfig } from '../../config/userConfig.js';

/**
 * Combine multiple AbortSignals into one. The combined signal aborts when any
 * input signal aborts. Listeners are added with `{ once: true }` and removed
 * by the returned cleanup so a long-lived session signal never accumulates
 * per-attempt listeners.
 */
function combineSignals(
  ...signals: Array<AbortSignal | undefined>
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

/**
 * Overall guard for a single model run. Two independent timers race the run:
 *  - a HARD total cap (never reset), and
 *  - an INACTIVITY timer that resets on each streamed chunk/event.
 *
 * `runFn` receives two callbacks:
 *  - `resetInactivity` — call on each stream event to reset the inactivity timer.
 *  - `signal` — an AbortSignal that aborts when EITHER the session signal aborts
 *    (user cancel) OR this attempt times out.
 *
 * On timeout the attempt signal is aborted, killing the child process — but the
 * SESSION-level signal is left untouched, so the caller can still retry /
 * downgrade to the next model (the abort only clears this attempt's child).
 *
 * Both timeouts are read from `config.json` → `tuning` (see userConfig.ts).
 */
export async function withTimeout<T>(
  runFn: (resetInactivity: () => void, signal: AbortSignal) => Promise<T>,
  modelLabel: string,
  sessionSignal?: AbortSignal,
): Promise<T> {
  const { modelRunHardTimeoutMs: HARD_MS, modelRunInactivityMs: INACT_MS } = getTuningConfig();
  let hardTimer: NodeJS.Timeout | undefined;
  let inactTimer: NodeJS.Timeout | undefined;
  let reject: (reason?: any) => void;

  // Per-attempt abort controller: aborted on timeout so the child process is
  // killed WITHOUT touching the session-level signal (user-cancel semantics).
  const attemptController = new AbortController();
  const { signal: runSignal, cleanup } = combineSignals(sessionSignal, attemptController.signal);

  const fire = (msg: string) => {
    attemptController.abort();
    if (reject) reject(Object.assign(new Error(msg), { isTimeout: true }));
  };

  // Hard total cap — set once, never reset.
  hardTimer = setTimeout(() => {
    fire(`Model \`${modelLabel}\` was force-terminated after running for more than ${HARD_MS / 60000} minutes in a single run (possibly stuck in a loop or the upstream hung). Please try again later or split the question.`);
  }, HARD_MS);

  // Inactivity timer — reset on activity.
  const armInactivity = () => {
    if (inactTimer) clearTimeout(inactTimer);
    inactTimer = setTimeout(() => {
      fire(`Model \`${modelLabel}\` produced no output within ${INACT_MS / 60000} minutes (the upstream service may be hung). Please try again later or switch to another model.`);
    }, INACT_MS);
  };
  armInactivity();

  const timeout: Promise<never> = new Promise((_, _reject) => {
    reject = _reject;
  });

  const resetInactivity = () => {
    armInactivity();
  };

  try {
    const promise = runFn(resetInactivity, runSignal);
    return await Promise.race([promise, timeout]);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (inactTimer) clearTimeout(inactTimer);
    cleanup();
  }
}
