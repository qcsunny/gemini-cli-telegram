/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import { getTuningConfig } from '../../config/userConfig.js';

/**
 * Overall guard for a single model run. Two independent timers race the run:
 *  - a HARD total cap (never reset), and
 *  - an INACTIVITY timer that resets on each streamed chunk/event.
 * `runFn` is passed a `resetInactivity` function that resets the inactivity timer.
 * `onTimeout` is called when either timer fires — use it to abort the child
 * process so it doesn't become an orphan and pollute the next attempt.
 *
 * Both timeouts are read from `config.json` → `tuning` (see userConfig.ts).
 */
export async function withTimeout<T>(
  runFn: (resetInactivity: () => void) => Promise<T>,
  modelLabel: string,
  onTimeout?: () => void,
): Promise<T> {
  const { modelRunHardTimeoutMs: HARD_MS, modelRunInactivityMs: INACT_MS } = getTuningConfig();
  let hardTimer: NodeJS.Timeout | undefined;
  let inactTimer: NodeJS.Timeout | undefined;
  let reject: (reason?: any) => void;

  const fire = (msg: string) => {
    onTimeout?.();
    if (reject) reject(new Error(msg));
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
    const promise = runFn(resetInactivity);
    return await Promise.race([promise, timeout]);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (inactTimer) clearTimeout(inactTimer);
  }
}