/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file modelFallbackChain.ts
 * @description Tier-aware model fallback chain walker (extracted from
 * messageLoop.ts): walks the capability-tier chain monotonically downward
 * (只降不升), tracks per-model retries and total attempts, detects channel
 * switches, and notifies the caller of every downgrade.
 */

import { logger } from '../../utils/logger.js';
import { buildTierAwareChain, getChannelModel } from '../modelRegistry.js';

export class ModelFallbackChain {
  readonly chain: string[];
  readonly maxAttempts: number;
  readonly skipModels = new Set<string>();
  failsForModel = 0;
  attempts = 0;

  private chainIdx = 0;
  private modelToUse: string;

  constructor(initialModel: string, retriesPerModel: number) {
    this.chain = buildTierAwareChain(initialModel, this.skipModels);
    this.maxAttempts = this.chain.length * retriesPerModel;
    this.modelToUse = this.chain[0];
  }

  get currentModel(): string {
    return this.modelToUse;
  }

  /**
   * Advance to the next model in the fallback chain. The chain walks
   * monotonically downward (tier-aware, 只降不升 — see buildTierAwareChain)
   * and TERMINATES once the last model is exhausted; it never wraps back
   * to the strongest model. Returns true if a next model was selected,
   * false if the chain is exhausted and the run should terminate.
   *
   * Also detects channel switches (e.g., agy → deepseek) and logs them
   * with a 🔀 emoji so the user sees the backend change in Telegram.
   * `onDowngrade` lets the caller notify the user and reset per-attempt state.
   */
  async advance(
    reason: string,
    onDowngrade: (reason: string, prevModel: string, nextModel: string, switchedChannel: boolean) => Promise<void>,
  ): Promise<boolean> {
    const prevModel = this.modelToUse;
    if (this.chainIdx + 1 >= this.chain.length) {
      logger.warn(`[messageLoop] Model "${prevModel}" failed (${reason}). Full fallback chain exhausted — terminating (attempt ${this.attempts}/${this.maxAttempts}).`);
      return false;
    }
    this.chainIdx++;
    this.modelToUse = this.chain[this.chainIdx];
    this.failsForModel = 0;
    // Detect whether the downgrade crosses a channel boundary
    // (agy ↔ deepseek ↔ web2api ↔ opencode ↔ claude ↔ codex).
    const prevCh = getChannelModel(prevModel);
    const nextCh = getChannelModel(this.modelToUse);
    const switchedChannel = !!(prevCh && nextCh && prevCh !== nextCh);
    const logTag = switchedChannel ? `[messageLoop] 🔀 Channel switch ${prevCh}→${nextCh}` : '[messageLoop]';
    logger.warn(`${logTag} Model "${prevModel}" failed (${reason}). Downgrading to "${this.modelToUse}" (attempt ${this.attempts}/${this.maxAttempts}).`);
    await onDowngrade(reason, prevModel, this.modelToUse, switchedChannel);
    return true;
  }
}