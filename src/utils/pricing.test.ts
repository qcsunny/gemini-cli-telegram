/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { formatFooterMarker } from './pricing.js';

describe('Pricing and Token Estimation', () => {
  describe('formatFooterMarker', () => {
    it('should format footer marker string correctly', () => {
      const marker = formatFooterMarker('Claude Sonnet 4.6 (Thinking)', 'hello', 'world');
      expect(marker).toBe('[footer: Claude Sonnet 4.6 (Thinking) (Estimated / 预估) | 2 | 2 | $0.000036]');
    });

    it('should include thinking cost when usage has thinking tokens', () => {
      // Claude Sonnet 4.6: input=$3/MTok, output=$15/MTok, thinking billed at output rate
      const marker = formatFooterMarker(
        'Claude Sonnet 4.6 (Thinking)',
        'test prompt',
        'test response',
        { input: 1000, output: 1000, cached: 0, thinking: 500 }
      );
      // inputCost = (1000/1M)*3 = 0.003
      // outputCost = (1000/1M)*15 = 0.015
      // thinkingCost = (500/1M)*15 = 0.0075
      // total = 0.0255
      expect(marker).toContain('$0.025500');
      expect(marker).toContain('| 1000 | 1000 |');
      expect(marker).toContain('| 0 | 500]');
    });

    it('should apply correct cache discount per provider', () => {
      // Claude: cacheMultiplier=0.1 (10% of input rate)
      const claudeMarker = formatFooterMarker(
        'Claude Sonnet 4.6 (Thinking)',
        'test',
        'response',
        { input: 1000, output: 1000, cached: 1000, thinking: 0 }
      );
      // inputCost = (1000/1M)*3 + (1000/1M)*(3*0.1) = 0.003 + 0.0003 = 0.0033
      // outputCost = (1000/1M)*15 = 0.015
      // total = 0.0183
      expect(claudeMarker).toContain('$0.018300');

      // Gemini: cacheMultiplier=0.25 (25% of input rate)
      const geminiMarker = formatFooterMarker(
        'Gemini 3.6 Flash (High)',
        'test',
        'response',
        { input: 1000, output: 1000, cached: 1000, thinking: 0 }
      );
      // inputCost = (1000/1M)*1.5 + (1000/1M)*(1.5*0.25) = 0.0015 + 0.000375 = 0.001875
      // outputCost = (1000/1M)*7.5 = 0.0075
      // total = 0.009375
      expect(geminiMarker).toContain('$0.009375');
    });

    it('should estimate CJK tokens with updated ratio', () => {
      // CJK characters estimated at 1.5 tokens each
      const chineseText = '你好世界测试'; // 6 CJK chars
      const marker = formatFooterMarker('Gemini 3.6 Flash', chineseText, '');
      // estimate = 6 * 1.5 = 9 tokens
      expect(marker).toContain('| 9 |');
    });

    it('should handle mixed CJK and English text', () => {
      // 3 CJK + 2 English words
      const mixedText = '你好啊 world test';
      const marker = formatFooterMarker('Gemini 3.6 Flash', mixedText, '');
      // estimate = 3 * 1.5 + 2 * 1.3 = 4.5 + 2.6 = 7.1 → ceil = 8
      expect(marker).toContain('| 8 |');
    });

    it('should not charge thinking tokens for models with thinkingMultiplier=none', () => {
      // DeepSeek V4 Pro: thinkingMultiplier='none'
      const marker = formatFooterMarker(
        'DeepSeek: Pro Thinking',
        'test',
        'response',
        { input: 1000, output: 1000, cached: 0, thinking: 500 }
      );
      // Only input + output costs, no thinking cost
      // inputCost = (1000/1M)*0.435 = 0.000435
      // outputCost = (1000/1M)*0.87 = 0.00087
      // total = 0.001305
      expect(marker).toContain('$0.001305');
    });

    it('should fallback to default rates for unknown models', () => {
      const marker = formatFooterMarker('Unknown Model X', 'test', 'response');
      // Default: inputRate=1.50, outputRate=9.00
      // estimateTokens("test") = 1 word * 1.3 = 1.3 → 2
      expect(marker).toContain('(Estimated / 预估)');
    });
  });
});
