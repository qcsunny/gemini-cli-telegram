/**
 * @file conversationManager.ts
 * @description In-memory conversation history management for every backend that
 * keeps no server-side session (web2api, deepseek, glm, qwen, opencode, claude,
 * codex).
 * These services are stateless, so we must replay the full message history on
 * every request.
 */

import { restoreAllHistories } from './messageStore.js';

interface Web2ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export const web2apiHistories = new Map<string, Web2ApiMessage[]>();
export const deepseekHistories = new Map<string, Web2ApiMessage[]>();
export const glmHistories = new Map<string, Web2ApiMessage[]>();
export const qwenHistories = new Map<string, Web2ApiMessage[]>();
export const mimoHistories = new Map<string, Web2ApiMessage[]>();

export const opencodeHistories = new Map<string, Web2ApiMessage[]>();
export const claudeHistories = new Map<string, Web2ApiMessage[]>();
export const codexHistories = new Map<string, Web2ApiMessage[]>();

export function clearOpenCodeHistory(conversationId: string): void {
  opencodeHistories.delete(conversationId);
}

export function clearClaudeHistory(conversationId: string): void {
  claudeHistories.delete(conversationId);
}

export function clearCodexHistory(conversationId: string): void {
  codexHistories.delete(conversationId);
}

export function makeWeb2ApiConvId(): string {
  return `web2api-${globalThis.crypto.randomUUID()}`;
}

export function makeDeepSeekConvId(): string {
  return `deepseek-${globalThis.crypto.randomUUID()}`;
}

export function makeGlmConvId(): string {
  return `glm-${globalThis.crypto.randomUUID()}`;
}

export function makeQwenConvId(): string {
  return `qwen-${globalThis.crypto.randomUUID()}`;
}

export function makeMimoConvId(): string {
  return `mimo-${globalThis.crypto.randomUUID()}`;
}

export function makeOpenCodeConvId(): string {
  return `opencode-${globalThis.crypto.randomUUID()}`;
}

export function makeClaudeConvId(): string {
  return `claude-${globalThis.crypto.randomUUID()}`;
}

export function makeCodexConvId(): string {
  return `codex-${globalThis.crypto.randomUUID()}`;
}

/** Register known conversation IDs from SQLite on startup (lazy loading). */
export function restoreHistoriesFromDb(): void {
  restoreAllHistories();
}

export function clearDeepSeekHistory(conversationId: string): void {
  deepseekHistories.delete(conversationId);
}

export function clearGlmHistory(conversationId: string): void {
  glmHistories.delete(conversationId);
}

export function clearQwenHistory(conversationId: string): void {
  qwenHistories.delete(conversationId);
}

export function clearMimoHistory(conversationId: string): void {
  mimoHistories.delete(conversationId);
}

/** Clear the Web2API history for a given conversationId (called on /new). */
export function clearWeb2ApiHistory(conversationId: string): void {
  web2apiHistories.delete(conversationId);
}
