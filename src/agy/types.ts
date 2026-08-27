/**
 * @file types.ts
 * @description Shared type definitions for the agy module.
 */

/** Incremental streaming event emitted by a backend runner during a model turn. */
export interface AgyStreamEvent {
  type: 'thought' | 'text' | 'done';
  content?: string;
}

/** Options passed to every backend runner (runOpenCode, runClaudeCli, etc.).
 *  Callers populate this from the message-loop; backends destructure the
 *  fields they need and ignore the rest. */
export interface AgyRunOptions {
  /** The user prompt text. */
  prompt: string;
  /** Working directory for agy (project context). */
  cwd: string;
  /** If set, passes --conversation <id> to continue an existing session. */
  conversationId?: string;
  /** Called with each incremental chunk of output text. */
  onChunk?: (chunk: string) => void;
  /** Called with structured streaming events. May return a Promise so the
   *  caller can serialize long-running handlers (e.g. tail re-chunking) with
   *  the subsequent 'done' event. */
  onEvent?: (event: AgyStreamEvent) => void | Promise<void>;
  /** Called on any streamed progress; used by the caller to reset an inactivity timer. */
  onActivity?: () => void;
  /** Called when the agy child process is successfully spawned. */
  onSpawn?: (pid: number) => void;
  /** AbortSignal — kills the agy process when aborted. */
  signal?: AbortSignal;
  /** Extra directories to add (via --add-dir). */
  extraDirs?: string[];
  /** Files to attach directly to a backend that supports file inputs (e.g. OpenCode --file). */
  extraFiles?: string[];
  /** Model override */
  model?: string;
  /** Proxy server override */
  proxy?: string;
  /** agy --print-timeout override (e.g. "30m"); defaults to agy's 5m */
  printTimeout?: string;
  /** Allow the model to use tools (file read / web fetch / shell). Each
   *  backend maps this flag to its own permission-bypass flag:
   *    - agy:        --dangerously-skip-permissions           (agyCli.ts)
   *    - claude CLI: --dangerously-skip-permissions           (backends/claude.ts)
   *    - codex:      --dangerously-bypass-approvals-and-sandbox (backends/codex.ts)
   *    - opencode:   --auto                                   (backends/opencode.ts)
   *    - deepseek / web2api: HTTP prompt, no CLI flag (handled server-side)
*  Enabled whenever the caller passes it: the chat loop does so via the
 *  `tuning.autoApproveTools` toggle (default true), and the trusted inline
 *  /invest path sets it explicitly so the model can fetch extra data the
 *  pre-scored script could not get. */
  allowTools?: boolean;
}

/** Standardised result returned by every backend runner after a model turn
 *  completes (success or failure). */
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
  /** Media files produced by the run (e.g. images from gemini-image, audio from
   *  gemini-music, HTML documents from gemini-canvas). The caller is responsible
   *  for sending these via `session.sendMedia()` and cleaning up the temp files. */
  mediaFiles?: { path: string; type: 'photo' | 'audio' | 'document'; caption?: string }[];
}

/** A single step within an agy conversation transcript. Parsed from the
 *  protobuf step table (src/agy/protobuf.ts) and used for rendering the
 *  Thinking Process panel and calculating token usage. */
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
