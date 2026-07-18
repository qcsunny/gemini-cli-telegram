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
    // DeepSeek V4 Pro
    pattern: /deepseek.*pro/i,
    rates: { inputRate: 0.435, outputRate: 0.87 }
  },
  {
    // DeepSeek V4 Flash
    pattern: /deepseek.*flash/i,
    rates: { inputRate: 0.14, outputRate: 0.28 }
  },
  {
    // Claude Opus (Thinking)
    pattern: /opus/i,
    rates: { inputRate: 15.00, outputRate: 75.00 }
  },
  {
    // Claude Sonnet (Thinking)
    pattern: /sonnet/i,
    rates: { inputRate: 3.00, outputRate: 15.00 }
  },
  {
    // GPT-OSS 120B (Medium)
    pattern: /gpt-oss|oss/i,
    rates: { inputRate: 2.50, outputRate: 10.00 }
  },
  {
    // Gemini 3.5 Flash
    pattern: /3\.5\s*flash/i,
    rates: { inputRate: 1.50, outputRate: 9.00 }
  },
  {
    // Gemini 3.1 Pro
    pattern: /3\.1\s*pro/i,
    rates: { inputRate: 2.00, outputRate: 12.00 }
  },
  {
    // Gemini 3.1 Flash-Lite
    pattern: /3\.1\s*flash-lite/i,
    rates: { inputRate: 0.25, outputRate: 1.50 }
  },
  {
    // Gemini 3 Flash
    pattern: /3\s*flash/i,
    rates: { inputRate: 0.50, outputRate: 3.00 }
  },
  {
    // Gemini 2.5 Pro
    pattern: /2\.5\s*pro/i,
    rates: { inputRate: 1.25, outputRate: 10.00 }
  },
  {
    // Gemini 2.5 Flash
    pattern: /2\.5\s*flash/i,
    rates: { inputRate: 0.30, outputRate: 2.50 }
  },
  {
    // Gemini 2.5 Flash-Lite
    pattern: /2\.5\s*flash-lite/i,
    rates: { inputRate: 0.10, outputRate: 0.40 }
  },
  // --- Generics / Fallbacks ---
  {
    // General Pro keyword
    pattern: /pro/i,
    rates: { inputRate: 2.00, outputRate: 12.00 }
  },
  {
    // General Flash / Auto keyword
    pattern: /flash|auto/i,
    rates: { inputRate: 1.50, outputRate: 9.00 }
  }
];

// Fallback pricing rates (Gemini 3.5 Flash)
const DEFAULT_RATES: PricingInfo = { inputRate: 1.50, outputRate: 9.00 };

/**
 * Heuristically estimate token usage for Gemini/multilingual text.
 * - Count CJK (Chinese, Japanese, Korean) characters.
 * - Strip CJK to isolate Western words and split by whitespace.
 * - Estimate: CJK characters count * 0.8 + English words count * 1.3.
 * - Return at least 1 token if input text is non-empty.
 */
export function estimateTokens(text: string): number {
  if (!text || !text.trim()) {
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

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  thinking: number;
}

/**
 * Calculate input, output, and total costs based on model lookup and token counts.
 * Lookup is case-insensitive and partial.
 * Supports cached tokens discount (Gemini caching discount is 25% of input rate).
 */
export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): { inputCost: number; outputCost: number; totalCost: number } {
  let rates = DEFAULT_RATES;

  for (const entry of PRICING_MATRIX) {
    if (entry.pattern.test(modelName)) {
      rates = entry.rates;
      break;
    }
  }

  const cachedRate = rates.inputRate * 0.25;
  const inputCost = (inputTokens / 1_000_000) * rates.inputRate + (cachedTokens / 1_000_000) * cachedRate;
  const outputCost = (outputTokens / 1_000_000) * rates.outputRate;
  const totalCost = inputCost + outputCost;

  return { inputCost, outputCost, totalCost };
}

/**
 * Combines estimation and pricing to return a marker string for the footer:
 * [footer: modelName | inputTokens | outputTokens | formattedCost]
 * or for official usage:
 * [footer: modelName | inputTokens | outputTokens | formattedCost | cached | thinking]
 */
export function formatFooterMarker(
  modelName: string,
  inputPrompt: string,
  outputText: string,
  usage?: TokenUsage
): string {
  if (usage) {
    const { input, output, cached, thinking } = usage;
    const { totalCost } = calculateCost(modelName, input, output, cached);
    return `[footer: ${modelName} | ${input} | ${output} | $${totalCost.toFixed(6)} | ${cached} | ${thinking}]`;
  } else {
    const inputTokens = estimateTokens(inputPrompt);
    const outputTokens = estimateTokens(outputText);
    const { totalCost } = calculateCost(modelName, inputTokens, outputTokens);
    return `[footer: ${modelName} (Estimated / 预估) | ${inputTokens} | ${outputTokens} | $${totalCost.toFixed(6)}]`;
  }
}
