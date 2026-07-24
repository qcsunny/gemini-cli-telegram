/**
 * @file conversationManager.ts
 * @description In-memory conversation history management for web2api, deepseek, and gemini-direct backends.
 * These services are stateless, so we must replay the full message history on every request.
 */

import { restoreAllHistories } from './messageStore.js';

const MAX_HISTORY_ENTRIES = 100;

export interface Web2ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export const web2apiHistories = new Map<string, Web2ApiMessage[]>();
export const deepseekHistories = new Map<string, Web2ApiMessage[]>();
export const geminiDirectHistories = new Map<string, any[]>();

export function trimHistoryMaps(): void {
  for (const map of [web2apiHistories, deepseekHistories, geminiDirectHistories]) {
    if (map.size <= MAX_HISTORY_ENTRIES) continue;
    const keys = [...map.keys()];
    const toDelete = keys.slice(0, map.size - MAX_HISTORY_ENTRIES);
    for (const k of toDelete) map.delete(k);
  }
}

export function makeWeb2ApiConvId(): string {
  return `web2api-${globalThis.crypto.randomUUID()}`;
}

export function makeDeepSeekConvId(): string {
  return `deepseek-${globalThis.crypto.randomUUID()}`;
}

/** Restore web2api/deepseek/gemini-direct conversation histories from SQLite on startup. */
export function restoreHistoriesFromDb(): void {
  restoreAllHistories(web2apiHistories, deepseekHistories, geminiDirectHistories);
}

export function clearDeepSeekHistory(conversationId: string): void {
  deepseekHistories.delete(conversationId);
}

/** Clear the Web2API history for a given conversationId (called on /new). */
export function clearWeb2ApiHistory(conversationId: string): void {
  web2apiHistories.delete(conversationId);
}

/** Clear the gemini-direct history for a given conversationId (called on /new). */
export function clearGeminiDirectHistory(conversationId: string): void {
  geminiDirectHistories.delete(conversationId);
}
