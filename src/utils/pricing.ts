/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file pricing.ts
 * @description Token usage estimation and model pricing calculator module.
 * Provides heuristic token count estimates for CJK and Western text, model rate lookups,
 * footer marker string formatting, and footer string parsing for rich messages.
 */

/**
 * Model pricing rates per 1,000,000 tokens in USD.
 */
interface PricingInfo {
  inputRate: number;  // Cost per 1,000,000 tokens
  outputRate: number; // Cost per 1,000,000 tokens
}

/**
 * Pricing matrix matching model name patterns to their input/output rates.
 */
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
    // DeepSeek R1
    pattern: /deepseek.*r1/i,
    rates: { inputRate: 0.55, outputRate: 2.19 }
  },
  {
    // Claude Opus (Thinking / 4.8 / 5)
    pattern: /opus/i,
    rates: { inputRate: 5.00, outputRate: 25.00 }
  },
  {
    // Claude Sonnet (Thinking / 3.5 / 5)
    pattern: /sonnet|claude.*5/i,
    rates: { inputRate: 3.00, outputRate: 15.00 }
  },
  {
    // GPT-OSS 120B (Medium)
    pattern: /gpt-oss|oss/i,
    rates: { inputRate: 2.50, outputRate: 10.00 }
  },
  {
    // Gemini 3.6 Flash
    pattern: /3\.6\s*flash/i,
    rates: { inputRate: 1.50, outputRate: 7.50 }
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
    // Gemini 3.5 Flash-Lite
    pattern: /3\.5\s*flash-lite|flash-lite/i,
    rates: { inputRate: 0.30, outputRate: 2.50 }
  },
  {
    // Gemini 3.x Flash (generic fallback for all 3.5/3.6 Flash variants)
    pattern: /3\s*flash/i,
    rates: { inputRate: 0.50, outputRate: 3.00 }
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
function estimateTokens(text: string): number {
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
function calculateCost(
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

/**
 * Parse the `[footer: ...]` marker produced by `formatFooterMarker` into a list
 * of human-readable stat fragments (e.g. "In: 1234", "Cost: $0.001234") for the
 * native 10.2 `footer` block. Returns an empty array when the marker is absent,
 * so callers can skip the footer block entirely.
 */
export function parseFooterMarker(marker: string): string[] {
  const m = marker.match(/\[footer:\s*(.*?)\s*\]/);
  if (!m) return [];
  const parts = m[1].split('|').map((p) => p.trim());
  if (parts.length < 4) return [];
  const [model, input, output, cost] = parts;
  const cached = parts[4];
  const thinking = parts[5];
  const out: string[] = [];
  if (model) out.push(model);
  if (input || output) {
    let s = `In: ${input ?? ''}`;
    if (cached && cached !== '0') s += ` (Cached: ${cached})`;
    s += ` · Out: ${output ?? ''}`;
    if (thinking && thinking !== '0') s += ` (Reasoning: ${thinking})`;
    out.push(s);
  }
  if (cost) out.push(`Cost: ${cost}`);
  return out;
}
