/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface PricingInfo {
  inputRate: number;  // Cost per 1,000,000 tokens
  outputRate: number; // Cost per 1,000,000 tokens
}

// Pricing matrix based on active models
const PRICING_MATRIX: { pattern: RegExp; rates: PricingInfo }[] = [
  {
    // Claude Opus 4.6 (Thinking)
    pattern: /opus/i,
    rates: { inputRate: 15.00, outputRate: 75.00 }
  },
  {
    // Claude Sonnet 4.6 (Thinking)
    pattern: /sonnet/i,
    rates: { inputRate: 3.00, outputRate: 15.00 }
  },
  {
    // GPT-OSS 120B (Medium)
    pattern: /gpt-oss|oss/i,
    rates: { inputRate: 2.50, outputRate: 10.00 }
  },
  {
    // Web2API: Gemini Flash Lite
    pattern: /flash\s*lite/i,
    rates: { inputRate: 0.0375, outputRate: 0.15 }
  },
  {
    // Gemini 3.1 Pro (Low/High) and Web2API: Gemini 3.1 Pro
    pattern: /3\.1\s*pro|pro/i,
    rates: { inputRate: 1.25, outputRate: 5.00 }
  },
  {
    // Gemini 3.5 Flash and Web2API: Gemini 3.5 Flash / Gemini Auto
    pattern: /3\.5\s*flash|flash|auto/i,
    rates: { inputRate: 0.075, outputRate: 0.30 }
  }
];

// Fallback pricing rates (Gemini 3.5 Flash)
const DEFAULT_RATES: PricingInfo = { inputRate: 0.075, outputRate: 0.30 };

/**
 * Heuristically estimate token usage for Gemini/multilingual text.
 * - Count CJK (Chinese, Japanese, Korean) characters.
 * - Strip CJK to isolate Western words and split by whitespace.
 * - Estimate: CJK characters count * 0.8 + English words count * 1.3.
 * - Return at least 1 token if input text is non-empty.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  // CJK characters range: Japanese Hiragana, Katakana, CJK Unified Ideographs, Hangul Syllables, Hangul Jamo, compatibility Jamo
  const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g;

  const cjkMatches = text.match(cjkRegex);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Replace CJK characters with a space to avoid fusing adjacent English words
  const westernText = text.replace(cjkRegex, ' ');
  const englishWords = westernText.trim().split(/\s+/).filter(Boolean);
  const englishWordsCount = englishWords.length;

  const estimate = cjkCount * 0.8 + englishWordsCount * 1.3;

  let finalTokens = Math.ceil(estimate);
  if (text.trim().length === 1 && finalTokens > 1) {
    finalTokens = 1;
  }
  return finalTokens === 0 ? 1 : finalTokens;
}

/**
 * Calculate input, output, and total costs based on model lookup and token counts.
 * Lookup is case-insensitive and partial.
 */
export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number
): { inputCost: number; outputCost: number; totalCost: number } {
  let rates = DEFAULT_RATES;

  for (const entry of PRICING_MATRIX) {
    if (entry.pattern.test(modelName)) {
      rates = entry.rates;
      break;
    }
  }

  const inputCost = (inputTokens / 1_000_000) * rates.inputRate;
  const outputCost = (outputTokens / 1_000_000) * rates.outputRate;
  const totalCost = inputCost + outputCost;

  return { inputCost, outputCost, totalCost };
}

/**
 * Combines estimation and pricing to return a marker string for the footer:
 * [footer: modelName | inputTokens | outputTokens | formattedCost]
 * where cost is formatted to 6 decimal places.
 */
export function formatFooterMarker(
  modelName: string,
  inputPrompt: string,
  outputText: string
): string {
  const inputTokens = estimateTokens(inputPrompt);
  const outputTokens = estimateTokens(outputText);
  const { totalCost } = calculateCost(modelName, inputTokens, outputTokens);

  return `[footer: ${modelName} | ${inputTokens} | ${outputTokens} | $${totalCost.toFixed(6)}]`;
}
