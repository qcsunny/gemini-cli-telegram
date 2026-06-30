/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * agyCli.ts — thin subprocess wrapper around the `agy` CLI binary.
 *
 * Usage pattern:
 *   First message  → runAgyPrint({ prompt, cwd, onChunk, signal })
 *                    Returns the new conversation UUID (or '' on error)
 *   Follow-up      → runAgyPrint({ prompt, cwd, conversationId, onChunk, signal })
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../utils/logger.js';

// ─── Web2API (local Gemini via gemini-web2api) ────────────────────────────────
const WEB2API_BASE_URL = 'http://127.0.0.1:8081/v1';
const WEB2API_API_KEY  = 'sk-gemini-local';

/** Map from display name → actual web2api model ID */
const WEB2API_MODEL_MAP: Record<string, string> = {
  'Web2API: Gemini 3.5 Flash':              'gemini-3.5-flash',
  'Web2API: Gemini 3.5 Flash Thinking':     'gemini-3.5-flash-thinking',
  'Web2API: Gemini 3.5 Flash Thinking Lite':'gemini-3.5-flash-thinking-lite',
  'Web2API: Gemini 3.1 Pro':                'gemini-3.1-pro',
  'Web2API: Gemini Flash Lite':             'gemini-flash-lite',
  'Web2API: Gemini Auto':                   'gemini-auto',
};

/** Returns true if the model name should be routed to web2api */
export function isWeb2ApiModel(model: string): boolean {
  return model in WEB2API_MODEL_MAP;
}

// ── Web2API in-memory conversation history ───────────────────────────────────
// Web2API is a stateless service: we must replay the full message history on
// every request. We maintain that history in memory, keyed by conversationId.
interface Web2ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}
const web2apiHistories = new Map<string, Web2ApiMessage[]>();

/**
 * Generate a stable pseudo-UUID for a Web2API session keyed by the project cwd.
 * Format: "web2api-<first-16-chars-of-base64-cwd>"
 */
function makeWeb2ApiConvId(cwd: string): string {
  // Simple deterministic ID — not cryptographically secure, just needs to be stable per cwd.
  const encoded = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `web2api-${encoded}`;
}

/** Clear the Web2API history for a given conversationId (called on /new). */
export function clearWeb2ApiHistory(conversationId: string): void {
  web2apiHistories.delete(conversationId);
}

/**
 * Call web2api with streaming, forwarding chunks via onChunk.
 * Maintains multi-turn conversation history in memory.
 * Returns AgyRunResult with a stable web2api conversationId.
 */
export async function runWeb2Api(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, cwd, conversationId: existingConvId, model = '', onChunk, signal } = opts;
  const modelId = WEB2API_MODEL_MAP[model] ?? 'gemini-3.5-flash';

  // Resolve or create the conversation ID
  const convId = existingConvId || makeWeb2ApiConvId(cwd);

  // Build message history: retrieve existing turns + append new user message
  const history: Web2ApiMessage[] = web2apiHistories.get(convId) ?? [];
  history.push({ role: 'user', content: prompt });

  const body = JSON.stringify({
    model: modelId,
    stream: true,
    messages: history,
  });

  const url = new URL(`${WEB2API_BASE_URL}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WEB2API_API_KEY}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    let outputBuf = '';
    const req = http.request(reqOptions, (res) => {
      const decoder = new StringDecoder('utf-8');
      let buf = '';

      res.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              outputBuf += delta;
              if (onChunk) onChunk(delta);
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        // Persist the assistant reply in history for next turn
        if (outputBuf) {
          history.push({ role: 'assistant', content: outputBuf });
          // Cap history at 40 messages (20 turns) to avoid memory growth
          const MAX_MESSAGES = 40;
          const trimmed = history.length > MAX_MESSAGES ? history.slice(history.length - MAX_MESSAGES) : history;
          web2apiHistories.set(convId, trimmed);
        }
        resolve({ conversationId: convId, output: outputBuf, exitCode: 0, stderr: '' });
      });

      res.on('error', reject);
    });

    req.on('error', reject);

    signal?.addEventListener('abort', () => {
      logger.debug('[web2api] Aborting request');
      req.destroy();
      resolve({ conversationId: convId, output: outputBuf, exitCode: 1, stderr: 'Aborted' });
    });

    req.write(body);
    req.end();
  });
}

/** Path to the agy binary — prefer explicit env var, then search PATH, then common fallbacks. */
export function getAgyPath(): string {
  if (process.env['AGY_PATH']) {
    return process.env['AGY_PATH'];
  }
  // Attempt to resolve via PATH at runtime (sync, called rarely)
  try {
    const resolved = execFileSync('which', ['agy'], { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch {
    // fall through to defaults
  }
  // Common install locations as fallback (ordered by likelihood)
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const candidate of candidates) {
    try {
      fssync.accessSync(candidate, fssync.constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable — try next
    }
  }
  // Last resort — rely on PATH resolution at spawn time
  return 'agy';
}

/** Directory where agy stores conversation SQLite files. */
export function getConversationsDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
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
}

/**
 * Snapshot the set of conversation UUIDs currently on disk.
 */
async function snapshotConversations(): Promise<Set<string>> {
  try {
    const files = await fs.readdir(getConversationsDir());
    return new Set(
      files
        .filter(f => f.endsWith('.db') && !f.endsWith('-shm') && !f.endsWith('-wal'))
        .map(f => f.replace(/\.db$/, '')),
    );
  } catch {
    return new Set();
  }
}

/**
 * Run `agy --print <prompt>` (optionally continuing a conversation).
 * Streams stdout to onChunk in real time; resolves when the process exits.
 *
 * Returns an AgyRunResult with the conversation UUID and full output.
 */
export async function runAgyPrint(opts: AgyRunOptions): Promise<AgyRunResult> {
  // Route web2api models directly to the local HTTP service
  if (opts.model && isWeb2ApiModel(opts.model)) {
    logger.info(`[agyCli] Routing to web2api: model=${opts.model}`);
    return runWeb2Api(opts);
  }

  const { prompt, cwd, conversationId, onChunk, signal, extraDirs, model, proxy } = opts;
  const agy = getAgyPath();

  // Build arg list
  const args: string[] = ['--print', prompt];

  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  if (model) {
    args.push('--model', model);
  }

  for (const dir of extraDirs ?? []) {
    args.push('--add-dir', dir);
  }

  // Snapshot conversations before the call so we can detect the new one
  const before = conversationId ? new Set<string>() : await snapshotConversations();

  logger.debug(`[agyCli] Spawning: ${agy} ${args.slice(0, 3).join(' ')} … (cwd=${cwd})`);

  return new Promise((resolve, reject) => {
    const cleanEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1' };
    delete cleanEnv['ANTIGRAVITY_AGENT'];
    delete cleanEnv['ANTIGRAVITY_LS_ADDRESS'];
    delete cleanEnv['ANTIGRAVITY_CONVERSATION_ID'];
    delete cleanEnv['ANTIGRAVITY_PROJECT_ID'];
    delete cleanEnv['ANTIGRAVITY_TRAJECTORY_ID'];

    if (proxy) {
      cleanEnv['HTTP_PROXY'] = proxy;
      cleanEnv['HTTPS_PROXY'] = proxy;
      cleanEnv['http_proxy'] = proxy;
      cleanEnv['https_proxy'] = proxy;
    }

    const child = spawn(agy, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv as NodeJS.ProcessEnv,
    });

    if (opts.onSpawn && child.pid !== undefined) {
      opts.onSpawn(child.pid);
    }

    let outputBuf = '';
    let errBuf = '';

    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (text) {
        outputBuf += text;
        if (onChunk) onChunk(text);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errBuf += stderrDecoder.write(chunk);
    });

    // Kill agy when the AbortController fires
    signal?.addEventListener('abort', () => {
      logger.debug('[agyCli] Aborting — sending SIGINT to agy process');
      child.kill('SIGINT');
    });

    child.on('error', err => {
      logger.error(`[agyCli] Spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', async (code) => {
      // Flush decoders
      const finalStdout = stdoutDecoder.end();
      if (finalStdout) {
        outputBuf += finalStdout;
        if (onChunk) onChunk(finalStdout);
      }
      errBuf += stderrDecoder.end();

      const exitCode = code ?? 1;
      logger.debug(`[agyCli] Process exited with code ${exitCode}. stderr: ${errBuf.slice(0, 200)}`);

      let resolvedConvId = conversationId ?? '';

      // If this was a new conversation, detect the new .db file
      if (!conversationId) {
        try {
          const after = await snapshotConversations();
          const newIds = [...after].filter(id => !before.has(id));
          if (newIds.length === 1) {
            resolvedConvId = newIds[0];
            logger.info(`[agyCli] New conversation UUID: ${resolvedConvId}`);
          } else if (newIds.length > 1) {
            // Multiple new files: pick the most recently modified
            const withStats = await Promise.all(
              newIds.map(async id => {
                const stat = await fs.stat(path.join(getConversationsDir(), `${id}.db`));
                return { id, mtime: stat.mtime.getTime() };
              }),
            );
            withStats.sort((a, b) => b.mtime - a.mtime);
            resolvedConvId = withStats[0].id;
            logger.info(`[agyCli] Picked newest conversation UUID: ${resolvedConvId}`);
          } else {
            logger.warn('[agyCli] Could not detect new conversation UUID from filesystem diff');
          }
        } catch (e) {
          logger.warn(`[agyCli] Conversation UUID detection failed: ${e}`);
        }
      }

      resolve({ conversationId: resolvedConvId, output: outputBuf, exitCode, stderr: errBuf });
    });
  });
}

export const AVAILABLE_MODELS = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
  'Web2API: Gemini 3.5 Flash',
  'Web2API: Gemini 3.5 Flash Thinking',
  'Web2API: Gemini 3.5 Flash Thinking Lite',
  'Web2API: Gemini 3.1 Pro',
  'Web2API: Gemini Flash Lite',
  'Web2API: Gemini Auto',
];

export async function getAvailableModels(): Promise<string[]> {
  return AVAILABLE_MODELS;
}

