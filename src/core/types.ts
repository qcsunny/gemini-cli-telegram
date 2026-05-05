/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  GeminiClient,
  Scheduler,
} from '@google/gemini-cli-core';
import type { SendMediaFn } from '../channels/telegram/outbound.js';

export type { SendMediaFn, MediaType } from '../channels/telegram/outbound.js';

export interface MultimodalInput {
  text?: string;
  media?: MediaPart[];
}

export interface MediaPart {
  type: 'photo' | 'voice' | 'audio' | 'video' | 'document';
  path: string; // Local path to the downloaded file
  mimeType?: string; // Optional: detected mime type
  fileName?: string; // Original file name (for documents)
}

/**
 * Channel-agnostic reply interface.
 * Each channel (Telegram, Discord, etc.) implements this to bridge
 * the core message loop to its own messaging API.
 */
export interface ChannelReply {
  send(text: string): Promise<number>;
  edit(messageId: number, text: string): Promise<void>;
  sendPlain(text: string): Promise<number>;
  editPlain(messageId: number, text: string): Promise<void>;
  sendDocument(path: string, caption?: string): Promise<void>;
  delete(messageId: number): Promise<void>;
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
}

/**
 * Channel-agnostic session — one per conversation/chat.
 */
export interface DaemonSession {
  sessionId: string;
  config: Config;
  geminiClient: GeminiClient;
  scheduler: Scheduler;
  abortController: AbortController;
  busy: boolean;
  turnCount: number;
  createdAt: Date;
  /** Current project/workspace */
  currentProject?: ProjectInfo;
  /** Thinking steps for current operation */
  thinkingSteps: ThinkingStep[];
  /** Active typing indicator interval, if any. Cleared on cancel/completion. */
  typingInterval?: ReturnType<typeof setInterval>;
  /** Outbound media send function for tool-initiated file delivery. */
  sendMedia?: SendMediaFn;
  /** Autopilot / self-reply until configuration */
  autopilot?: AutopilotConfig;
}

/**
 * Options for creating a new session.
 */
export interface SessionOptions {
  cwd?: string;
  model?: string;
  project?: ProjectInfo;
}

/**
 * Channel-specific formatter for message size limits.
 */
export interface MessageFormatter {
  chunkText(text: string): string[];
  truncateForEdit(text: string): string;
}
