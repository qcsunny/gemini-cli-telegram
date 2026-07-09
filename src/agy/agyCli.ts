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
import { loadUserConfig } from '../config/userConfig.js';


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

// ── Gemini Direct in-memory conversation history ─────────────────────────────
// Separate from web2apiHistories to avoid cross-contamination between routing paths.
const geminiDirectHistories = new Map<string, any[]>();

/**
 * Generate a random UUID for a Web2API session.
 */
function makeWeb2ApiConvId(): string {
  return `web2api-${globalThis.crypto.randomUUID()}`;
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
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal } = opts;
  const modelId = WEB2API_MODEL_MAP[model] ?? 'gemini-3.5-flash';

  // Resolve or create the conversation ID
  const convId = existingConvId || makeWeb2ApiConvId();

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
    let inReasoning = false;
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
            const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content ?? '';

            if (reasoning) {
              if (!inReasoning) {
                inReasoning = true;
                const startTag = '<thought>';
                outputBuf += startTag;
                if (onChunk) onChunk(startTag);
              }
              outputBuf += reasoning;
              if (onChunk) onChunk(reasoning);
              opts.onEvent?.({ type: 'thought', content: reasoning });
            }

            if (delta) {
              if (inReasoning) {
                inReasoning = false;
                const endTag = '</thought>\n\n';
                outputBuf += endTag;
                if (onChunk) onChunk(endTag);
              }
              outputBuf += delta;
              if (onChunk) onChunk(delta);
              opts.onEvent?.({ type: 'text', content: delta });
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        if (inReasoning) {
          inReasoning = false;
          const endTag = '</thought>';
          outputBuf += endTag;
          if (onChunk) onChunk(endTag);
        }
        opts.onEvent?.({ type: 'done' });
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

// ── Model Capabilities & Direct Gemini API ─────────────────────────────────────

export interface ModelCapabilities {
  supportsThinkingSummary: boolean;
}

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'Gemini 3.5 Flash (Medium)': { supportsThinkingSummary: true },
  'Gemini 3.5 Flash (High)': { supportsThinkingSummary: true },
  'Gemini 3.5 Flash (Low)': { supportsThinkingSummary: true },
  'Gemini 3.1 Pro (Low)': { supportsThinkingSummary: true },
  'Gemini 3.1 Pro (High)': { supportsThinkingSummary: true },
  'Web2API: Gemini 3.5 Flash Thinking': { supportsThinkingSummary: true },
  'Web2API: Gemini 3.5 Flash Thinking Lite': { supportsThinkingSummary: true },
  'Web2API: Gemini 3.1 Pro': { supportsThinkingSummary: true },
  'Web2API: Gemini 3.5 Flash': { supportsThinkingSummary: true },
};

export function getModelCapabilities(modelName?: string): ModelCapabilities {
  if (!modelName) {
    return { supportsThinkingSummary: false };
  }
  if (MODEL_CAPABILITIES[modelName]) {
    return MODEL_CAPABILITIES[modelName];
  }
  // Heuristic: Any model containing 'gemini' in its name is treated as supporting thinking summary.
  // This allows extensibility so future models require no Telegram layer modifications.
  const lower = modelName.toLowerCase();
  if (lower.includes('gemini')) {
    return { supportsThinkingSummary: true };
  }
  return { supportsThinkingSummary: false };
}

export function mapModelToGeminiId(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('gemini 3.5 flash') || lower.includes('gemini-2.5-flash') || lower.includes('gemini-2.0-flash')) {
    if (lower.includes('thinking')) {
      return 'gemini-2.0-flash-thinking-exp-01-21';
    }
    return 'gemini-2.0-flash';
  }
  if (lower.includes('gemini 3.1 pro') || lower.includes('gemini-2.5-pro') || lower.includes('gemini-2.0-pro')) {
    return 'gemini-2.0-pro-exp-02-05';
  }
  if (model.startsWith('gemini-')) {
    return model;
  }
  return 'gemini-2.0-flash';
}

export async function runGeminiDirect(opts: AgyRunOptions, apiKey: string): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal, proxy } = opts;
  const modelId = mapModelToGeminiId(model);
  const convId = existingConvId || `gemini-direct-${globalThis.crypto.randomUUID()}`;

  // Build history in memory
  const history: any[] = geminiDirectHistories.get(convId) ?? [];
  history.push({ role: 'user', parts: [{ text: prompt }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body = JSON.stringify({
    contents: history,
    generationConfig: {
      thinkingConfig: {
        includeThoughts: true
      }
    }
  });

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    signal,
  };

  if (proxy) {
    const { ProxyAgent } = await import('undici');
    const dispatcher = new ProxyAgent(proxy);
    (fetchOptions as any).dispatcher = dispatcher;
  }

  let outputBuf = '';
  let thoughtBuf = '';
  let contentBuf = '';
  let inThoughts = false;
  let thinkingTokens = 0;
  let thoughtStartTime = 0;
  let thoughtEndTime = 0;

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API returned ${response.status}: ${errText || response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Gemini API response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6).trim();
        if (!dataStr) continue;

          try {
            const parsed = JSON.parse(dataStr);

            // Extract usage metadata if returned
            const usage = parsed?.usageMetadata;
            if (usage && usage.thinkingTokenCount) {
              thinkingTokens = usage.thinkingTokenCount;
            }

            const parts = parsed?.candidates?.[0]?.content?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                const isThought = part.thought === true;
                const text = part.text || '';
                if (!text) continue;

                if (isThought) {
                  if (!thoughtStartTime) {
                    thoughtStartTime = Date.now();
                  }
                  if (!inThoughts) {
                    inThoughts = true;
                    const timeAttr = ' time="0.0"'; // updated when thoughts finish or generation finishes
                    const tokensAttr = thinkingTokens ? ` tokens="${thinkingTokens}"` : '';
                    onChunk?.(`<thought-gemini${timeAttr}${tokensAttr}>`);
                  }
                  thoughtBuf += text;
                  outputBuf += text;
                  onChunk?.(text);
                  opts.onEvent?.({ type: 'thought', content: text });
                } else {
                  if (thoughtStartTime && !thoughtEndTime) {
                    thoughtEndTime = Date.now();
                  }
                  if (inThoughts) {
                    inThoughts = false;
                    onChunk?.('</thought-gemini>\n\n');
                  }
                  contentBuf += text;
                  outputBuf += text;
                  onChunk?.(text);
                  opts.onEvent?.({ type: 'text', content: text });
                }
              }
            }
          } catch {
            // ignore incomplete SSE chunk lines
          }
      }
    }

    if (inThoughts) {
      inThoughts = false;
      onChunk?.('</thought-gemini>');
    }
    opts.onEvent?.({ type: 'done' });

    if (thoughtStartTime) {
      if (!thoughtEndTime) {
        thoughtEndTime = Date.now();
      }
      const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
      const timeAttr = `time="${durationSec}"`;
      const tokensAttr = thinkingTokens ? ` tokens="${thinkingTokens}"` : '';
      
      outputBuf = `<thought-gemini ${timeAttr}${tokensAttr}>${thoughtBuf}</thought-gemini>\n\n${contentBuf}`;
    } else {
      outputBuf = contentBuf;
    }

    // Save history in memory
    history.push({ role: 'model', parts: [{ text: outputBuf }] });
    const MAX_MESSAGES = 40;
    const trimmed = history.length > MAX_MESSAGES ? history.slice(history.length - MAX_MESSAGES) : history;
    geminiDirectHistories.set(convId, trimmed);

    const finalResult: AgyRunResult = {
      conversationId: convId,
      output: outputBuf,
      exitCode: 0,
      stderr: '',
    };

    if (thoughtStartTime) {
      (finalResult as any).thinkingTime = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
      (finalResult as any).thinkingTokens = thinkingTokens;
    }

    return finalResult;

  } catch (err: any) {
    logger.error(`[runGeminiDirect] Error: ${err.message || err}`);
    return {
      conversationId: convId,
      output: outputBuf,
      exitCode: 1,
      stderr: err.message || String(err),
    };
  }
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
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  // Last resort — rely on PATH resolution at spawn time
  return 'agy';
}

/**
 * Find the Antigravity project ID corresponding to a given folder path
 * by reading registered project configurations in global config (~/.gemini/config/projects/*.json).
 */
async function findAntigravityProjectId(projectPath: string): Promise<string | null> {
  try {
    const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
    const files = await fs.readdir(projectsDir).catch(() => [] as string[]);
    const targetPath = path.resolve(projectPath);
    
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'default-cli-project.json') continue;
      try {
        const filePath = path.join(projectsDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        
        if (parsed.id) {
          // 1. Direct path check
          if (parsed.name && path.resolve(parsed.name) === targetPath) {
            return parsed.id;
          }
          // 2. Folder URI check
          const resources = parsed.projectResources?.resources ?? [];
          for (const res of resources) {
            if (res.folderUri) {
              const cleanedUri = res.folderUri.replace(/^file:\/\//, '');
              if (path.resolve(cleanedUri) === targetPath) {
                return parsed.id;
              }
            }
          }
        }
      } catch {
        // ignore parsing/reading errors for individual projects
      }
    }
  } catch (e) {
    logger.warn(`[agyCli] Error finding Antigravity project ID: ${e}`);
  }
  return null;
}

/** Directory where agy stores conversation SQLite files. */
export function getConversationsDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

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

  // Route direct Gemini requests to Gemini API if geminiApiKey is present
  const config = loadUserConfig();
  if (config?.geminiApiKey && opts.model && (opts.model.toLowerCase().includes('gemini') || opts.model.startsWith('gemini-'))) {
    logger.info(`[agyCli] Routing directly to Gemini API: model=${opts.model}`);
    return runGeminiDirect(opts, config.geminiApiKey);
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

  // Resolve and inject the correct Antigravity Project ID for the workspace
  const agProjectId = await findAntigravityProjectId(cwd);

  if (agProjectId) {
    args.push('--project', agProjectId);
  }

  logger.debug(`[agyCli] Spawning: ${agy} ${args.slice(0, 3).join(' ')} … (cwd=${cwd})`);

  return new Promise((resolve, reject) => {
    const cleanEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1' };
    delete cleanEnv['ANTIGRAVITY_AGENT'];
    delete cleanEnv['ANTIGRAVITY_LS_ADDRESS'];
    delete cleanEnv['ANTIGRAVITY_CONVERSATION_ID'];
    delete cleanEnv['ANTIGRAVITY_PROJECT_ID'];
    delete cleanEnv['ANTIGRAVITY_TRAJECTORY_ID'];

    if (agProjectId) {
      logger.info(`[agyCli] Injecting ANTIGRAVITY_PROJECT_ID=${agProjectId} for cwd=${cwd}`);
      cleanEnv['ANTIGRAVITY_PROJECT_ID'] = agProjectId;
    }

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

    let accumulatedText = '';

    let chunkIndex = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      accumulatedText += text;
      outputBuf += text;
      chunkIndex++;

      const containsT = text.includes('<thought') || text.includes('</thought>') || text.includes('<thinking') || text.includes('</thinking>');
      logger.debug(`[STDOUT] chunk=${chunkIndex} len=${text.length} containsThought=${containsT} preview="${text.slice(0, 200).replace(/\n/g, '\\n')}"`);

      if (onChunk) onChunk(text);
      // Emit incremental streaming event per chunk so the UI updates in real time
      if (opts.onEvent) {
        opts.onEvent({ type: 'text', content: text });
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
        accumulatedText += finalStdout;
        outputBuf += finalStdout;
        if (onChunk) onChunk(finalStdout);
      }

      // Single parse of the complete accumulated output
      const { thought, content } = extractThoughtAndContent(accumulatedText);
      logger.debug(`[STDOUT-CLOSE] Final parse: thought.length=${thought.length}, content.length=${content.length}`);

      if (thought) {
        opts.onEvent?.({ type: 'thought', content: thought });
      }
      // NOTE: We do NOT re-emit 'text' here because per-chunk stdout events already
      // streamed every raw chunk into answerBuffer. The recovery path in messageLoop.ts
      // (extractThoughtAndContent) will strip <thought> blocks from answerBuffer after
      // streaming completes if thoughtBuffer is empty.
      opts.onEvent?.({ type: 'done' });
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

interface ParsedBlock {
  type: 'thought' | 'thought-gemini' | 'thinking' | 'bracket';
  startTagIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  endTagIndex: number;
  isClosed: boolean;
  time?: string;
  tokens?: string;
}

function cleanInnerText(rawText: string): string {
  let cleanedText = rawText;
  while (cleanedText && (
    cleanedText.startsWith('\ufeff') ||
    (cleanedText.charCodeAt(0) < 32 && 
     cleanedText.charCodeAt(0) !== 9 && 
     cleanedText.charCodeAt(0) !== 10 && 
     cleanedText.charCodeAt(0) !== 13)
  )) {
    cleanedText = cleanedText.slice(1);
  }
  return cleanedText;
}

function getEndTagLength(type: ParsedBlock['type']): number {
  switch (type) {
    case 'thought-gemini': return 17; // '</thought-gemini>'
    case 'thought': return 10;        // '</thought>'
    case 'thinking': return 11;       // '</thinking>'
    case 'bracket': return 1;          // ']'
  }
}

function startsWithIgnoreCase(str: string, index: number, prefix: string): boolean {
  if (index + prefix.length > str.length) return false;
  for (let k = 0; k < prefix.length; k++) {
    if (str[index + k].toLowerCase() !== prefix[k].toLowerCase()) {
      return false;
    }
  }
  return true;
}

function matchTag(str: string, index: number, prefix: string): boolean {
  if (!startsWithIgnoreCase(str, index, prefix)) return false;
  const nextCharIdx = index + prefix.length;
  if (nextCharIdx >= str.length) return true;
  const nextChar = str[nextCharIdx];
  return nextChar === '>' || nextChar === ' ' || nextChar === '\n' || nextChar === '\r' || nextChar === '\t';
}

export function extractThoughtBlocksAndSegments(text: string): {
  segments: { type: 'text' | 'thought'; value: string; block?: ParsedBlock }[];
  thought: string;
  content: string;
} {
  const blocks: ParsedBlock[] = [];
  let inCodeBlock = false;
  let inInlineCode = false;
  let hasSeenNonWhitespaceContent = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (char === '\n') {
      inInlineCode = false;
    }

    if (text.startsWith('```', i)) {
      inCodeBlock = !inCodeBlock;
      i += 3;
      hasSeenNonWhitespaceContent = true;
      continue;
    }
    if (char === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      i++;
      hasSeenNonWhitespaceContent = true;
      continue;
    }
    if (inCodeBlock || inInlineCode) {
      i++;
      hasSeenNonWhitespaceContent = true;
      continue;
    }

    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      i++;
      continue;
    }

    let matchedType: ParsedBlock['type'] | null = null;
    let matchedPrefix = '';
    let endTagStr = '';

    if (matchTag(text, i, '<thought-gemini')) {
      matchedType = 'thought-gemini';
      matchedPrefix = '<thought-gemini';
      endTagStr = '</thought-gemini>';
    } else if (matchTag(text, i, '<thought')) {
      matchedType = 'thought';
      matchedPrefix = '<thought';
      endTagStr = '</thought>';
    } else if (matchTag(text, i, '<thinking')) {
      matchedType = 'thinking';
      matchedPrefix = '<thinking';
      endTagStr = '</thinking>';
    } else if (startsWithIgnoreCase(text, i, '[thought:')) {
      matchedType = 'bracket';
      matchedPrefix = '[thought:';
      endTagStr = ']';
    }

    if (matchedType) {
      let startTagEnd = -1;
      let contentStart = -1;
      let time: string | undefined;
      let tokens: string | undefined;

      if (matchedType === 'bracket') {
        startTagEnd = i + matchedPrefix.length;
        contentStart = startTagEnd;
      } else {
        const gtIdx = text.indexOf('>', i);
        if (gtIdx !== -1) {
          startTagEnd = gtIdx + 1;
          contentStart = startTagEnd;

          if (matchedType === 'thought-gemini') {
            const startTagContent = text.slice(i + matchedPrefix.length, gtIdx);
            const timeMatch = startTagContent.match(/time=(?:"|')([^"']*?)(?:"|')/i);
            const tokensMatch = startTagContent.match(/tokens=(?:"|')([^"']*?)(?:"|')/i);
            if (timeMatch) time = timeMatch[1];
            if (tokensMatch) tokens = tokensMatch[1];
          }
        } else {
          startTagEnd = text.length;
          contentStart = text.length;
        }
      }

      let endTagIdx = -1;
      if (startTagEnd < text.length) {
        let tempCodeBlock = false;
        let tempInlineCode = false;
        let j = startTagEnd;
        while (j < text.length) {
          if (text[j] === '\n') {
            tempInlineCode = false;
          }
          if (text.startsWith('```', j)) {
            tempCodeBlock = !tempCodeBlock;
            j += 3;
            continue;
          }
          if (text[j] === '`' && !tempCodeBlock) {
            tempInlineCode = !tempInlineCode;
            j++;
            continue;
          }
          if (tempCodeBlock || tempInlineCode) {
            j++;
            continue;
          }
          if (startsWithIgnoreCase(text, j, endTagStr)) {
            endTagIdx = j;
            break;
          }
          j++;
        }
      }

      const isClosed = endTagIdx !== -1;

      if (isClosed || !hasSeenNonWhitespaceContent) {
        const contentEnd = isClosed ? endTagIdx : text.length;
        const endIndex = isClosed ? endTagIdx + endTagStr.length : text.length;
        blocks.push({
          type: matchedType,
          startTagIndex: i,
          contentStartIndex: contentStart,
          contentEndIndex: contentEnd,
          endTagIndex: endTagIdx,
          isClosed,
          time,
          tokens,
        });

        i = endIndex;
        continue;
      }
    }

    hasSeenNonWhitespaceContent = true;
    i++;
  }

  const thoughts: string[] = [];
  const segments: { type: 'text' | 'thought'; value: string; block?: ParsedBlock }[] = [];
  let cleanContent = '';
  let lastIdx = 0;

  for (const block of blocks) {
    const preText = text.slice(lastIdx, block.startTagIndex);
    if (preText) {
      segments.push({ type: 'text', value: preText });
      cleanContent += preText;
    }

    const rawInner = text.slice(block.contentStartIndex, block.contentEndIndex);
    const cleanedInner = cleanInnerText(rawInner);
    thoughts.push(cleanedInner);

    segments.push({
      type: 'thought',
      value: cleanedInner,
      block,
    });

    lastIdx = block.isClosed ? block.endTagIndex + getEndTagLength(block.type) : text.length;
  }

  const postText = text.slice(lastIdx);
  if (postText) {
    segments.push({ type: 'text', value: postText });
    cleanContent += postText;
  }

  return {
    segments,
    thought: thoughts.join('\n\n').trim(),
    content: cleanContent,
  };
}

export function extractThoughtAndContent(text: string): { 
  thought: string; 
  content: string; 
  geminiTime?: string; 
  geminiTokens?: string; 
} {
  const res = extractThoughtBlocksAndSegments(text);
  let geminiTime: string | undefined;
  let geminiTokens: string | undefined;
  for (const seg of res.segments) {
    if (seg.type === 'thought' && seg.block?.type === 'thought-gemini') {
      if (seg.block.time && !geminiTime) geminiTime = seg.block.time;
      if (seg.block.tokens && !geminiTokens) geminiTokens = seg.block.tokens;
    }
  }
  return {
    thought: res.thought,
    content: res.content,
    geminiTime,
    geminiTokens,
  };
}

