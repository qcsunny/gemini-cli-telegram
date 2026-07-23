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
 * `onActivity` lets the caller report progress to reset the inactivity timer.
 *
 * Both timeouts are read from `config.json` → `tuning` (see userConfig.ts).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  modelLabel: string,
  onActivity?: () => void,
): Promise<{ result: T; resetInactivity: () => void }> {
  const { modelRunHardTimeoutMs: HARD_MS, modelRunInactivityMs: INACT_MS } = getTuningConfig();
  let hardTimer: NodeJS.Timeout | undefined;
  let inactTimer: NodeJS.Timeout | undefined;
  let reject: (reason?: any) => void;

  const fire = (msg: string) => {
    if (reject) reject(new Error(msg));
  };

  // Hard total cap — set once, never reset.
  hardTimer = setTimeout(() => {
    fire(`模型 \`${modelLabel}\` 单次运行超过 ${HARD_MS / 60000} 分钟被强制终止（疑似模型陷入死循环或上游挂起）。请稍后重试，或拆分问题。`);
  }, HARD_MS);

  // Inactivity timer — reset on activity.
  const armInactivity = () => {
    if (inactTimer) clearTimeout(inactTimer);
    inactTimer = setTimeout(() => {
      fire(`模型 \`${modelLabel}\` 在 ${INACT_MS / 60000} 分钟内无输出（疑似上游服务挂起）。请稍后重试，或切换到其它模型。`);
    }, INACT_MS);
  };
  armInactivity();

  const timeout: Promise<never> = new Promise((_reject) => {
    reject = _reject;
  });

  const activity = () => {
    if (onActivity) onActivity();
    armInactivity();
  };

  try {
    const result = await Promise.race([promise, timeout]);
    return { result, resetInactivity: activity };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (inactTimer) clearTimeout(inactTimer);
  }
}