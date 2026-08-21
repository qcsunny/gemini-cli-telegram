/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file pricing.test.ts
 * @description Exact-value tests for token estimation and billing math in pricing.ts.
 * Unlike the smoke assertions in utils.test.ts, these pin the exact rates so a
 * pricing-table typo (which directly burns money) cannot slip through.
 *
 * Model ids mirror config.json's modelsConfig.routing entries: Gemini tiers are
 * version-agnostic (Pro / Flash / Flash-Lite), OpenCode free models bill at $0.
 */

import { describe, it, expect, vi } from 'vitest';

// Deterministic USD/CNY rate — avoids touching the on-disk exchange-rate cache.
vi.mock('./exchangeRate.js', () => ({
  getCachedUsdToCnyRate: () => 7,
  initExchangeRate: () => {},
}));

import { estimateTokens, calculateCost, formatFooterMarker, parseFooterMarker } from './pricing.js';

describe('estimateTokens', () => {
  it('returns 0 for empty or whitespace-only text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t ')).toBe(0);
  });

  it('counts English words at 1.3 tokens each (ceil)', () => {
    // 2 words * 1.3 = 2.6 → 3
    expect(estimateTokens('Hello world')).toBe(3);
    // 10 words * 1.3 = 13
    expect(estimateTokens('one two three four five six seven eight nine ten')).toBe(13);
  });

  it('counts CJK characters at 1.5 tokens each (ceil)', () => {
    // 4 chars * 1.5 = 6
    expect(estimateTokens('你好世界')).toBe(6);
    // Hiragana falls in the CJK range: 2 * 1.5 = 3
    expect(estimateTokens('かな')).toBe(3);
  });

  it('separates fused CJK/English boundaries with a space', () => {
    // "Hello你好" must count as 1 English word + 2 CJK chars, not one fused blob.
    // 1 * 1.3 + 2 * 1.5 = 4.3 → 5
    expect(estimateTokens('Hello你好')).toBe(5);
  });

  it('clamps a single non-empty character to exactly 1 token', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('你')).toBe(1);
  });
});

describe('calculateCost — Gemini three product tiers (version-agnostic)', () => {
  it('bills Flash tier at $1.50/M input and $9.00/M output — by model id AND display name', () => {
    for (const name of ['gemini-3.7-flash', 'Gemini 3.7 Flash', 'gemini-auto']) {
      const c = calculateCost(name, 1_000_000, 1_000_000, 0, 0);
      expect(c.inputCost).toBeCloseTo(1.5, 10);
      expect(c.outputCost).toBeCloseTo(9.0, 10);
      expect(c.currency).toBe('USD');
    }
  });

  it('bills Pro tier at $2/$12 with 10% cache discount — by model id AND display name', () => {
    // Input kept below the 200K long-context threshold on purpose.
    for (const name of ['gemini-3.1-pro', 'Gemini 3.1 Pro']) {
      const c = calculateCost(name, 100_000, 1_000_000, 50_000, 0);
      expect(c.inputCost).toBeCloseTo(0.2 + 0.01, 10); // 100K full + 50K cached at $0.2/M
      expect(c.outputCost).toBeCloseTo(12, 10);
    }
  });

  it('matches Flash-Lite before the generic flash rule (id and display name)', () => {
    for (const name of ['gemini-3.5-flash-lite', 'Web2API Gemini 3.5 Flash Lite']) {
      const c = calculateCost(name, 1_000_000, 1_000_000, 0, 0);
      expect(c.inputCost).toBeCloseTo(0.25, 10);
      expect(c.outputCost).toBeCloseTo(1.5, 10);
    }
  });

  it('discounts Flash-Lite cached tokens at 12%', () => {
    const c = calculateCost('gemini-3.5-flash-lite', 0, 0, 1_000_000, 0);
    expect(c.inputCost).toBeCloseTo(0.03, 10); // 0.25 * 0.12
  });

  it('REGRESSION: hyphenated model ids must reach the Pro long-context tier', () => {
    // The old /\s*/-only patterns never matched "gemini-3.1-pro" (hyphen!),
    // silently falling back to generic rates and never applying $4/$18.
    const atBoundary = calculateCost('gemini-3.1-pro', 200_000, 0, 0, 0);
    expect(atBoundary.inputCost).toBeCloseTo((200_000 / 1e6) * 2.0, 10);

    const justAbove = calculateCost('gemini-3.1-pro', 200_001, 0, 0, 0);
    expect(justAbove.inputCost).toBeCloseTo((200_001 / 1e6) * 4.0, 10);
  });

  it('switches output to the long-context rate too when input exceeds 200K', () => {
    const c = calculateCost('gemini-3.1-pro', 300_000, 1_000_000, 0, 0);
    expect(c.outputCost).toBeCloseTo(18.0, 10);
  });
});

describe('calculateCost — OpenCode built-in free models', () => {
  it('bills every "*free*" model id at exactly $0', () => {
    const freeIds = [
      'opencode/deepseek-v4-flash-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
      'opencode/hy3-free',
      'opencode/laguna-s-2.1-free',
      'opencode/mimo-v2.5-free',
      'opencode/ling-3.0-tiny-free',
      'opencode/longcat-2.0-free',
      'openrouter/openrouter/free',
      'opencode/big-pickle',
    ];
    for (const id of freeIds) {
      const c = calculateCost(id, 1_000_000, 1_000_000, 500_000, 100_000);
      expect(c.totalCost).toBe(0);
      expect(c.currency).toBe('USD');
    }
  });

  it('keeps paid opencode/hetzner models on real rates (free rule must not over-match)', () => {
    // deepseek-v4-flash (paid) still bills; only the -free variant is zeroed.
    const paid = calculateCost('opencode/deepseek-v4-flash', 1_000_000, 0, 0, 0);
    expect(paid.totalCost).toBeGreaterThan(0);
  });
});

describe('calculateCost — other providers', () => {
  it('bills Claude Opus at $5/$25 with 10% cache discount', () => {
    const c = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000, 500_000, 0);
    expect(c.inputCost).toBeCloseTo(5 + 0.25, 10);
    expect(c.outputCost).toBeCloseTo(25, 10);
  });

  it('converts DeepSeek V4 Pro costs to CNY using the cached USD/CNY rate', () => {
    // Mocked rate = 7. deepseek-v4-pro: $0.435/M in, $0.87/M out.
    const c = calculateCost('deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0);
    expect(c.currency).toBe('CNY');
    expect(c.inputCost).toBeCloseTo(0.435 * 7, 10);
    expect(c.outputCost).toBeCloseTo(0.87 * 7, 10);
  });

  it('never adds a separate thinking charge (output already includes thinking)', () => {
    const without = calculateCost('claude-opus-4-6', 1000, 1000, 0, 0);
    const withThinking = calculateCost('claude-opus-4-6', 1000, 1000, 0, 999_999);
    expect(withThinking.totalCost).toBe(without.totalCost);
    expect(withThinking.thinkingCost).toBe(0);
  });

  it('falls back to Gemini Flash default rates for unknown models', () => {
    const c = calculateCost('totally-unknown-model', 1_000_000, 1_000_000, 0, 0);
    expect(c.inputCost).toBeCloseTo(1.5, 10);
    expect(c.outputCost).toBeCloseTo(9.0, 10);
  });
});

describe('formatFooterMarker / parseFooterMarker round-trip', () => {
  it('embeds official usage numbers verbatim', () => {
    const marker = formatFooterMarker('gemini-3.7-flash', 'ignored', 'ignored', {
      input: 1234,
      output: 567,
      cached: 89,
      thinking: 12,
    });
    // gemini-3.7-flash: 1234*1.5e-6 + 89*0.15e-6 + 567*9e-6 = 0.006967
    expect(marker).toBe('[footer: gemini-3.7-flash | 1234 | 567 | $0.006967 | 89 | 12]');
  });

  it('marks estimated footers and uses heuristic token counts', () => {
    const marker = formatFooterMarker('gemini-3.7-flash', 'Hello world', '');
    expect(marker).toContain('(Estimated)');
    expect(marker).toContain('| 3 |'); // "Hello world" → 3 tokens
  });

  it('renders a zero cost for free models', () => {
    const marker = formatFooterMarker('opencode/hy3-free', 'ignored', 'ignored', {
      input: 9999,
      output: 8888,
      cached: 0,
      thinking: 0,
    });
    expect(marker).toContain('$0.000000');
  });

  it('parses back into display fragments including cached and reasoning', () => {
    const parts = parseFooterMarker('[footer: Claude Opus 4.6 | 1000 | 500 | $0.010000 | 200 | 50]');
    expect(parts[0]).toBe('Claude Opus'); // version stripped by displayModelName
    expect(parts[1]).toBe('In: 1200 (Cached: 200) · Out: 500 (Reasoning: 50)');
    expect(parts[2]).toBe('Cost: $0.010000');
  });

  it('omits zero-value cached/reasoning annotations', () => {
    const parts = parseFooterMarker('[footer: gemini-3.7-flash | 100 | 50 | $0.001000 | 0 | 0]');
    expect(parts[1]).toBe('In: 100 · Out: 50');
  });

  it('returns an empty list for malformed markers', () => {
    expect(parseFooterMarker('no marker here')).toEqual([]);
    expect(parseFooterMarker('[footer: only-model | 1 | 2]')).toEqual([]);
  });
});
