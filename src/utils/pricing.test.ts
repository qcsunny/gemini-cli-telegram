/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, calculateCost, formatFooterMarker } from './pricing.js';

describe('Pricing and Token Estimation', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should return 1 for a single character or minimal input', () => {
      expect(estimateTokens('a')).toBe(1);
    });

    it('should estimate English text correctly', () => {
      // "hello world" has 2 English words.
      // English words count = 2.
      // 2 * 1.3 = 2.6.
      // If we round/ceil, let's see. If we use Math.round(2.6), it is 3. If we use Math.ceil(2.6), it is 3.
      expect(estimateTokens('hello world')).toBe(3);
    });

    it('should estimate CJK text correctly', () => {
      // "你好" has 2 CJK characters.
      // 2 * 0.8 = 1.6.
      // Math.ceil(1.6) = 2, or Math.round(1.6) = 2.
      expect(estimateTokens('你好')).toBe(2);
    });

    it('should estimate multilingual text correctly', () => {
      // "hello你好" has 1 English word ("hello") and 2 CJK characters ("你好").
      // English words: 1 * 1.3 = 1.3
      // CJK characters: 2 * 0.8 = 1.6
      // Total = 2.9
      // Ceil = 3.
      expect(estimateTokens('hello你好')).toBe(3);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost for Gemini 3.5 Flash', () => {
      // Input: $1.50 / 1M tokens, Output: $9.00 / 1M tokens
      // For 1,000,000 input and 2,000,000 output:
      // inputCost = 1.50, outputCost = 18.00, totalCost = 19.50
      const cost = calculateCost('Gemini 3.5 Flash (High)', 1_000_000, 2_000_000);
      expect(cost.inputCost).toBeCloseTo(1.50, 8);
      expect(cost.outputCost).toBeCloseTo(18.00, 8);
      expect(cost.totalCost).toBeCloseTo(19.50, 8);
    });

    it('should handle partial case-insensitive matching for models', () => {
      const cost = calculateCost('gemini 3.1 pro', 1_000_000, 1_000_000);
      // Input: $2.00 / 1M, Output: $12.00 / 1M
      expect(cost.inputCost).toBeCloseTo(2.00, 8);
      expect(cost.outputCost).toBeCloseTo(12.00, 8);
      expect(cost.totalCost).toBeCloseTo(14.00, 8);
    });

    it('should calculate cost for DeepSeek Pro and Flash', () => {
      // DeepSeek Pro: Input: $0.435 / 1M, Output: $0.87 / 1M
      const proCost = calculateCost('DeepSeek: Pro Thinking', 1_000_000, 1_000_000);
      expect(proCost.inputCost).toBeCloseTo(0.435, 8);
      expect(proCost.outputCost).toBeCloseTo(0.87, 8);
      expect(proCost.totalCost).toBeCloseTo(1.305, 8);

      // DeepSeek Flash: Input: $0.14 / 1M, Output: $0.28 / 1M
      const flashCost = calculateCost('DeepSeek: Flash', 1_000_000, 1_000_000);
      expect(flashCost.inputCost).toBeCloseTo(0.14, 8);
      expect(flashCost.outputCost).toBeCloseTo(0.28, 8);
      expect(flashCost.totalCost).toBeCloseTo(0.42, 8);
    });
  });

  describe('formatFooterMarker', () => {
    it('should format footer marker string correctly', () => {
      const marker = formatFooterMarker('Claude Sonnet 4.6 (Thinking)', 'hello', 'world');
      // "hello" -> 1 word * 1.3 = 1.3 -> 2 tokens
      // "world" -> 1 word * 1.3 = 1.3 -> 2 tokens
      // Claude Sonnet 4.6: Input: $3.00 / 1M, Output: $15.00 / 1M
      // inputCost = 2 * (3.00 / 1,000,000) = 0.000006
      // outputCost = 2 * (15.00 / 1,000,000) = 0.000030
      // totalCost = 0.000036
      // Expected footer format: [footer: Claude Sonnet 4.6 (Thinking) (Estimated / 预估) | 2 | 2 | $0.000036]
      expect(marker).toBe('[footer: Claude Sonnet 4.6 (Thinking) (Estimated / 预估) | 2 | 2 | $0.000036]');
    });
  });
});
