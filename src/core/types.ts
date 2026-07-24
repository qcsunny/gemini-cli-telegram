/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file types.ts
 * @description Central type definitions and interface declarations for the core daemon engine.
 * Defines channel-agnostic abstractions for session state, multimodal inputs, rich message replies,
 * workspace metadata, and formatting contracts.
 */

import type { SendMediaFn } from '../channels/telegram/outbound.js';

export type { SendMediaFn, MediaType } from '../channels/telegram/outbound.js';

/**
 * Multimodal input payload combining text prompt and attached media parts.
 */
export interface MultimodalInput {
  text?: string;
  media?: MediaPart[];
}

/**
 * Downloaded media attachment details for prompt input processing.
 */
export interface MediaPart {
  type: 'photo' | 'voice' | 'audio' | 'video' | 'document';
  path: string; // Local path to the downloaded file
  mimeType?: string; // Optional: detected mime type
  fileName?: string; // Original file name (for documents)
}

/**
 * Structured LLM output object containing body content, reasoning steps, execution timing, and footer metrics.
 */
export interface StructuredMessage {
  content: string;
  thought?: string;
  geminiTime?: string;
  geminiTokens?: string;
  footerText?: string;
}

/**
 * Channel-agnostic reply interface.
 * Each channel (Telegram, Discord, etc.) implements this to bridge
 * the core message loop to its own messaging API.
 */
export interface ChannelReply {
  send(text: string): Promise<number>;
  edit(messageId: number, text: string): Promise<number | void>;
  sendPlain(text: string): Promise<number>;
  editPlain(messageId: number, text: string): Promise<void>;
  sendDocument(path: string, caption?: string): Promise<void>;
  delete(messageId: number): Promise<void>;
  // Optional Rich Message API helper methods
  sendRich?(text: string | StructuredMessage): Promise<number>;
  sendRichDraft?(text: string | StructuredMessage): Promise<number>;
  editRich?(messageId: number, text: string | StructuredMessage): Promise<number | void>;
  editRichDraft?(draftId: number, text: string | StructuredMessage, isStreaming?: boolean): Promise<void>;
  sendRichDraftBlocks?(draftId: number, blocks: unknown[]): Promise<number>;
  editRichBlocks?(messageId: number, blocks: unknown[]): Promise<number | void>;
}

/**
 * Project info for workspace selection
 */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  description?: string;
  lastUsed?: Date;
}

/**
 * Thinking step for reasoning process
 */
export interface ThinkingStep {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'analysis' | 'complete';
  content: string;
  timestamp: Date;
  toolName?: string;
  status?: 'pending' | 'running' | 'success' | 'error';
}

/**
 * Compatibility config object attached to each DaemonSession.
 * Provides backward-compatible accessors for legacy command handlers.
 */
export interface SessionConfig {
  getModel: () => string;
  setModel: (modelName: string, quiet?: boolean) => void;
  getTargetDir: () => string;
  getWorkspaceContext: () => { addDirectory: (dir: string) => void };
  storage: {
    getProjectTempDir: () => string;
  };
}

/**
 * Autopilot configuration for self-reply mode
 */
export interface AutopilotConfig {
  /** Goal/condition to achieve */
  goal: string;
  /** Maximum number of self-replies */
  maxIterations: number;
  /** Current iteration count */
  currentIteration: number;
  /** Whether autopilot is active */
  active: boolean;
  /** Stop keywords that should end autopilot */
  stopKeywords: string[];
  /** Timestamp when autopilot started (ms) */
  startTime?: number;
  /** Maximum execution time allowed (ms) */
  timeoutMs?: number;
}

/**
 * Settings block for telegram chat (such as parseMode)
 */
export interface TelegramSettings {
  parseMode?: 'HTML' | 'MarkdownV2' | 'RichText';
}

export interface SessionSettings {
  telegram?: TelegramSettings;
}

/**
 * Channel-agnostic session — one per conversation/chat.
 */
export interface DaemonSession {
  sessionId: string;
  chatId?: number;
  conversationId?: string; // Local agy conversation UUID
  model?: string;          // Selected model override
  proxy?: string;          // Configured proxy server
  abortController: AbortController;
  busy: boolean;
  turnCount: number;
  createdAt: Date;
  /** Current project/workspace */
  currentProject?: ProjectInfo;
  /** Settings (e.g. format parseMode) */
  settings?: SessionSettings;
  /** Thinking steps for current operation */
  thinkingSteps: ThinkingStep[];
  /** Active typing indicator interval, if any. Cleared on cancel/completion. */
  typingInterval?: ReturnType<typeof setInterval>;
  /** Outbound media send function for tool-initiated file delivery. */
  sendMedia?: SendMediaFn;
  /** Autopilot / self-reply until configuration */
  autopilot?: AutopilotConfig;
  config?: SessionConfig;
  /** PID of the currently running agy child process (set by agyCli onSpawn, cleared on close). */
  childPid?: number;
  /** Timestamp (ms) when session.busy was set to true — used by health check for stuck detection. */
  _busySince?: number;
  /** Circuit breaker for Rich Draft functionality. */
  draftsDisabled?: boolean;
  /** Consecutive failures count for sending rich drafts. */
  consecutiveDraftFailures?: number;
}

/**
 * Options for creating a new session.
 */
export interface SessionOptions {
  cwd?: string;
  model?: string;
  project?: ProjectInfo;
  proxy?: string;
}

/**
 * Channel-specific formatter for message size limits.
 */
export interface MessageFormatter {
  chunkText(text: string): string[];
  truncateForEdit(text: string): string;
  truncateForStream(text: string): string;
  findSafeCutPoint(markdown: string, maxLen: number): number;
}
