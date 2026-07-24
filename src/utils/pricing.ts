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
  /** Cache hit multiplier relative to input rate (e.g. 0.1 = 10% of input rate) */
  cacheMultiplier?: number;
  /** How thinking/reasoning tokens are billed: 'none' | 'output-rate' | custom multiplier */
  thinkingMultiplier?: number | 'output-rate' | 'none';
  /** Alternative rates when single request input exceeds 200K tokens — all input/output use these */
  longContextRates?: { inputRate: number; outputRate: number };
}

/**
 * Pricing matrix matching model name patterns to their input/output rates.
 */
const PRICING_MATRIX: { pattern: RegExp; rates: PricingInfo }[] = [
  {
    // DeepSeek V4 Pro: $0.435 / $0.003625 / $0.87
    pattern: /deepseek.*pro/i,
    rates: { inputRate: 0.435, outputRate: 0.87, cacheMultiplier: 0.008333, thinkingMultiplier: 'none' }
  },
  {
    // DeepSeek V4 Flash: $0.14 / $0.0028 / $0.28
    pattern: /deepseek.*flash/i,
    rates: { inputRate: 0.14, outputRate: 0.28, cacheMultiplier: 0.02, thinkingMultiplier: 'none' }
  },
  {
    // DeepSeek R1
    pattern: /deepseek.*r1/i,
    rates: { inputRate: 0.55, outputRate: 2.19, cacheMultiplier: 0.25, thinkingMultiplier: 'none' }
  },
  {
    // Claude Opus 4.x: $5 / $0.50 / $25
    pattern: /opus/i,
    rates: { inputRate: 5.00, outputRate: 25.00, cacheMultiplier: 0.1, thinkingMultiplier: 'output-rate' }
  },
  {
    // Claude Sonnet 4.x: $3 / $0.30 / $15
    pattern: /sonnet|claude.*5/i,
    rates: { inputRate: 3.00, outputRate: 15.00, cacheMultiplier: 0.1, thinkingMultiplier: 'output-rate' }
  },
  {
    // GPT-OSS 120B: $0.60 / $0.06 / $2.40
    pattern: /gpt-oss|oss/i,
    rates: { inputRate: 0.60, outputRate: 2.40, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  },
  {
    // Gemini 3.6 Flash: $1.50 / $0.15 / $7.50
    pattern: /3\.6\s*flash/i,
    rates: { inputRate: 1.50, outputRate: 7.50, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  },
  {
    // Gemini 3.5 Flash: $1.50 / $0.15 / $9.00
    pattern: /3\.5\s*flash/i,
    rates: { inputRate: 1.50, outputRate: 9.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  },
  {
    // Gemini 3.1 Pro — ≤200K: $2/$12; >200K: $4/$18
    pattern: /3\.1\s*pro/i,
    rates: {
      inputRate: 2.00, outputRate: 12.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none',
      longContextRates: { inputRate: 4.00, outputRate: 18.00 }
    }
  },
  {
    // Gemini 3.5 Flash-Lite: $0.25 / $0.03 / $1.50
    pattern: /3\.5\s*flash-lite|flash-lite/i,
    rates: { inputRate: 0.25, outputRate: 1.50, cacheMultiplier: 0.12, thinkingMultiplier: 'none' }
  },
  {
    // Gemini 3.x Flash (generic fallback)
    pattern: /3\s*flash/i,
    rates: { inputRate: 0.50, outputRate: 3.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  },
  // --- Generics / Fallbacks ---
  {
    // General Pro keyword
    pattern: /pro/i,
    rates: { inputRate: 2.00, outputRate: 12.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  },
  {
    // General Flash / Auto keyword
    pattern: /flash|auto/i,
    rates: { inputRate: 1.50, outputRate: 9.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none' }
  }
];

// Fallback pricing rates (Gemini 3.5 Flash)
const DEFAULT_RATES: PricingInfo = { inputRate: 1.50, outputRate: 9.00, cacheMultiplier: 0.1, thinkingMultiplier: 'none' };

/**
 * Heuristically estimate token usage for Gemini/multilingual text.
 * - Count CJK (Chinese, Japanese, Korean) characters.
 * - Strip CJK to isolate Western words and split by whitespace.
 * - Estimate: CJK characters count * 1.5 + English words count * 1.3.
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

  // Updated: CJK ratio 0.8→1.5 based on actual Gemini tokenizer behavior
  const estimate = cjkCount * 1.5 + englishWordsCount * 1.3;

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
 * Calculate input, output, cached, and thinking costs based on model pricing.
 * - Cache hits are discounted per provider (Claude 10%, Gemini 25%)
 * - Thinking/reasoning tokens billed per provider setting (Claude at output rate)
 */
function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  thinkingTokens = 0
): { inputCost: number; outputCost: number; thinkingCost: number; totalCost: number } {
  let rates = DEFAULT_RATES;

  for (const entry of PRICING_MATRIX) {
    if (entry.pattern.test(modelName)) {
      rates = entry.rates;
      break;
    }
  }

  // Provider-specific cache multiplier (default 10% for Google Gemini, 10% for Anthropic Claude)
  const cacheMult = rates.cacheMultiplier ?? 0.10;

  // Check if single request exceeds 200K input tokens → use long-context rates
  const isLongContext = rates.longContextRates !== undefined && inputTokens > 200_000;
  const effectiveInputRate = isLongContext ? rates.longContextRates!.inputRate : rates.inputRate;
  const effectiveOutputRate = isLongContext ? rates.longContextRates!.outputRate : rates.outputRate;

  // Cache rate uses the effective input rate (long-context cache reads are priced higher)
  const cachedRate = effectiveInputRate * cacheMult;

  // Input cost: uncached input at full rate + cache hits at discounted rate
  const inputCost = (inputTokens / 1_000_000) * effectiveInputRate + (cachedTokens / 1_000_000) * cachedRate;
  
  // Output cost — switches with tier
  const outputCost = (outputTokens / 1_000_000) * effectiveOutputRate;
  
  // Thinking/reasoning cost — billed per provider policy
  let thinkingCost = 0;
  if (thinkingTokens > 0 && rates.thinkingMultiplier !== 'none') {
    const thinkingRate = rates.thinkingMultiplier === 'output-rate' 
      ? rates.outputRate 
      : rates.outputRate * Number(rates.thinkingMultiplier);
    thinkingCost = (thinkingTokens / 1_000_000) * thinkingRate;
  }

  const totalCost = inputCost + outputCost + thinkingCost;

  return { inputCost, outputCost, thinkingCost, totalCost };
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
    const { totalCost } = calculateCost(modelName, input, output, cached, thinking);
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
