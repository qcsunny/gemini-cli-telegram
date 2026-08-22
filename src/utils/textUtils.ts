/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file textUtils.ts
 * @description Shared text manipulation utilities.
 * Centralizes regex patterns that were previously duplicated across modules.
 */

/**
 * Strips literal `<thought>`, `<think>`, and `<thinking>` XML tags
 * (both paired and orphaned) from a string, returning the clean body text.
 *
 * This regex set was previously duplicated in 3 locations:
 *   - `channelReply.ts` (local function)
 *   - `messageLoop.ts` (flushBlocks + answerBuffer cleanup)
 *   - `messageCache.ts` (extractThoughtAndContent)
 *
 * All callers should import this single source of truth.
 */
export function stripThoughtTags(s: string): string {
  return s
    .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?thought[^>]*>/gi, '')
    .replace(/<\/?thinking[^>]*>/gi, '')
    .replace(/<\/?think[^>]*>/gi, '')
    .trim();
}

/**
 * Extracts a `<thought>`, `<think>` or `<thinking>` block from a string,
 * returning the thought content and the body with tags stripped.
 */
export function extractSimpleThought(text: string): { thought: string; content: string } {
  const match =
    text.match(/<thought[^>]*>([\s\S]*?)<\/thought>/i) ||
    text.match(/<thinking[^>]*>([\s\S]*?)<\/thinking>/i) ||
    text.match(/<think[^>]*>([\s\S]*?)<\/think>/i);
  if (match) {
    return { thought: match[1].trim(), content: stripThoughtTags(text) };
  }
  return { thought: '', content: text };
}
