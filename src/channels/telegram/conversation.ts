/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ConversationState = 
  | 'none'
  | 'awaiting_account_name'
  | 'awaiting_oauth_redirect';

export interface OAuthSessionContext {
  codeVerifier: string;
  state: string;
  authUrl: string;
}

export interface ConversationContext {
  state: ConversationState;
  data?: {
    accountName?: string;
    oauthCodeVerifier?: string;
    oauthState?: string;
  };
}

const CONVERSATION_FILE = path.join(os.homedir(), '.gemini-cli-telegram', 'conversation-state.json');

function loadConversations(): Record<number, ConversationContext> {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATION_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConversations(conversations: Record<number, ConversationContext>): void {
  try {
    fs.mkdirSync(path.dirname(CONVERSATION_FILE), { recursive: true });
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(conversations, null, 2));
  } catch (e) {
    console.error('[Conversation] Failed to save:', e);
  }
}

export function getConversationState(chatId: number): ConversationContext {
  const conversations = loadConversations();
  const state = conversations[chatId] || { state: 'none' };
  console.log('[Conversation] getConversationState:', chatId, JSON.stringify(state));
  return state;
}

export function setConversationState(chatId: number, context: ConversationContext): void {
  console.log('[Conversation] setConversationState:', chatId, JSON.stringify(context));
  const conversations = loadConversations();
  conversations[chatId] = context;
  saveConversations(conversations);
}

export function clearConversationState(chatId: number): void {
  const conversations = loadConversations();
  delete conversations[chatId];
  saveConversations(conversations);
}

export function startAccountCreation(chatId: number): void {
  setConversationState(chatId, {
    state: 'awaiting_account_name',
    data: {},
  });
}

export function finishAccountCreation(chatId: number): void {
  clearConversationState(chatId);
}

export function isAwaitingAccountName(chatId: number): boolean {
  return getConversationState(chatId).state === 'awaiting_account_name';
}

export function getAccountNameFromContext(chatId: number): string | null {
  return getConversationState(chatId).data?.accountName || null;
}

export function startOAuthRedirect(chatId: number, accountName: string, codeVerifier: string, state: string): void {
  setConversationState(chatId, {
    state: 'awaiting_oauth_redirect',
    data: { accountName, oauthCodeVerifier: codeVerifier, oauthState: state },
  });
}

export function isAwaitingOAuthRedirect(chatId: number): boolean {
  return getConversationState(chatId).state === 'awaiting_oauth_redirect';
}

export function getOAuthData(chatId: number): { accountName: string; codeVerifier: string; state: string } | null {
  const ctx = getConversationState(chatId);
  if (ctx.state === 'awaiting_oauth_redirect' && ctx.data?.accountName && ctx.data?.oauthCodeVerifier && ctx.data?.oauthState) {
    return { 
      accountName: ctx.data.accountName, 
      codeVerifier: ctx.data.oauthCodeVerifier,
      state: ctx.data.oauthState
    };
  }
  return null;
}