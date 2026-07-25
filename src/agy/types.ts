/**
 * @file types.ts
 * @description Shared type definitions for the agy module.
 */

export interface AgyStreamEvent {
  type: 'thought' | 'text' | 'done';
  content?: string;
}

export interface AgyRunOptions {
  /** The user prompt text. */
  prompt: string;
  /** Working directory for agy (project context). */
  cwd: string;
  /** If set, passes --conversation <id> to continue an existing session. */
  conversationId?: string;
  /** Called with each incremental chunk of output text. */
  onChunk?: (chunk: string) => void;
  /** Called with structured streaming events */
  onEvent?: (event: AgyStreamEvent) => void;
  /** Called on any streamed progress; used by the caller to reset an inactivity timer. */
  onActivity?: () => void;
  /** Called when the agy child process is successfully spawned. */
  onSpawn?: (pid: number) => void;
  /** AbortSignal — kills the agy process when aborted. */
  signal?: AbortSignal;
  /** Extra directories to add (via --add-dir). */
  extraDirs?: string[];
  /** Model override */
  model?: string;
  /** Proxy server override */
  proxy?: string;
}

export interface AgyRunResult {
  /** The conversation UUID (new or existing). */
  conversationId: string;
  /** Full concatenated stdout from the run. */
  output: string;
  /** Exit code — 0 means success. */
  exitCode: number;
  /** Optional stderr content */
  stderr?: string;
  /** Signal that killed the process, if any */
  signal?: string;
  /** Execution duration in ms */
  durationMs?: number;
  /** Whether the process was aborted/timed out */
  isTimeout?: boolean;
  /** Optional token usage details */
  usage?: {
    input: number;
    output: number;
    cached: number;
    thinking: number;
  };
  /** Gemini model thinking time in seconds (backend-specific) */
  thinkingTime?: string;
  /** Gemini model thinking token count (backend-specific) */
  thinkingTokens?: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'observation' | 'title' | 'unknown';
  content: string;
  stepType: number;
  idx: number;
  status: number;
  stepFormat: number;
  hasSubtrajectory: boolean;
  /** Decoded token usage from metadata field 9, if present. */
  usage?: {
    input: number;
    output: number;
    cached: number;
    thinking: number;
  } | null;
  /** Full decoded metadata fields for debugging. */
  metadata?: Record<string, unknown> | null;
  /** Raw blob columns for debugging. Protobuf blobs decoded via extractTextFromProto; plain text read directly. */
  errorDetails: string | null;
  permissions: string | null;
  taskDetails: string | null;
  renderInfo: string | null;
}
