/**
 * @file agyCli.ts
 * @description Subprocess wrapper, proxy client, and execution router for model runs.
 * Supports:
 *  1. Native `agy` binary execution via child process spawning (`runAgyPrint`).
 *  2. Local Web2API proxy service (`runWeb2Api` at http://127.0.0.1:8081).
 *  3. Local DeepSeek API proxy (`runDeepSeek` at http://127.0.0.1:5001).
 *  4. Direct Gemini API connection (`runGeminiDirect` via Google AI REST SSE endpoints).
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../utils/logger.js';
import { loadUserConfig, getTuningConfig, getBackendUrl, getWeb2ApiKey } from '../config/userConfig.js';
import { saveMessage, restoreAllHistories } from './messageStore.js';
import Database from 'better-sqlite3';



interface ModelsConfig {
  defaultOrder: string[];
  routing: Record<string, string>;
}

let _parsedModels: ModelsConfig | null | undefined; // undefined = need reload, null = failed, object = cached

function loadModelsConfig(): ModelsConfig | null {
  if (_parsedModels !== undefined) return _parsedModels;
  try {
    const url = new URL('../config/models.json', import.meta.url);
    const content = fssync.readFileSync(url, 'utf-8');
    _parsedModels = JSON.parse(content) as ModelsConfig;
  } catch (e) {
    _parsedModels = null;
  }
  return _parsedModels;
}

/** Returns true if the model name has a routing entry pointing to web2api */
export function isWeb2ApiModel(model: string): boolean {
  const cfg = loadModelsConfig();
  if (!cfg) return false;
  return model in cfg.routing && model.startsWith('Web2API:');
}

// ─── DeepSeek API Proxy (local deepseek-api) ──────────────────────────────────
/** Returns true if the model name has a routing entry pointing to deepseek */
export function isDeepSeekModel(model: string): boolean {
  const cfg = loadModelsConfig();
  if (!cfg) return false;
  return model in cfg.routing && model.startsWith('DeepSeek:');
}

// ── Web2API in-memory conversation history ───────────────────────────────────
// Web2API is a stateless service: we must replay the full message history on
// every request. We maintain that history in memory, keyed by conversationId.
interface Web2ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}
const web2apiHistories = new Map<string, Web2ApiMessage[]>();

/** Restore web2api/deepseek/gemini-direct conversation histories from SQLite on startup. */
export function restoreHistoriesFromDb(): void {
  restoreAllHistories(web2apiHistories, deepseekHistories, geminiDirectHistories);
}

// ── Gemini Direct in-memory conversation history ─────────────────────────────
// Separate from web2apiHistories to avoid cross-contamination between routing paths.
const geminiDirectHistories = new Map<string, any[]>();

/**
 * Generate a random UUID for a Web2API session.
 */
function makeWeb2ApiConvId(): string {
  return `web2api-${globalThis.crypto.randomUUID()}`;
}

// ── DeepSeek in-memory conversation history ──────────────────────────────────
const deepseekHistories = new Map<string, Web2ApiMessage[]>();

function makeDeepSeekConvId(): string {
  return `deepseek-${globalThis.crypto.randomUUID()}`;
}

export function clearDeepSeekHistory(conversationId: string): void {
  deepseekHistories.delete(conversationId);
}

export async function runDeepSeek(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal } = opts;
  const cfg = loadModelsConfig();
  const modelId = cfg?.routing[model] ?? 'deepseek-v4-flash';

  const convId = existingConvId || makeDeepSeekConvId();

  const history: Web2ApiMessage[] = deepseekHistories.get(convId) ?? [];
  history.push({ role: 'user', content: prompt });

  const config = loadUserConfig();
  const apiKey = config?.deepseekApiKey || '';

  const body = JSON.stringify({
    model: modelId,
    stream: true,
    messages: history.map(h => ({ role: h.role, content: h.content })),
  });

  const backendUrl = getBackendUrl('deepseek');
  if (!backendUrl) {
    return { conversationId: '', output: '', exitCode: 1, stderr: 'DeepSeek backend URL not configured' };
  }
  const url = new URL(`${backendUrl}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  let thoughtBuf = '';
  let contentBuf = '';
  let thoughtStartTime = 0;
  let thoughtEndTime = 0;
  let inThoughts = false;

  return new Promise((resolve, reject) => {
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
              if (!thoughtStartTime) {
                thoughtStartTime = Date.now();
              }
              if (!inThoughts) {
                inThoughts = true;
                const timeAttr = ' time="0.0"';
                const startTag = `<thought-gemini${timeAttr}>`;
                if (onChunk) onChunk(startTag);
              }
              thoughtBuf += reasoning;
              if (onChunk) onChunk(reasoning);
              opts.onEvent?.({ type: 'thought', content: reasoning });
            }

            if (delta) {
              if (thoughtStartTime && !thoughtEndTime) {
                thoughtEndTime = Date.now();
              }
              if (inThoughts) {
                inThoughts = false;
                const endTag = '</thought-gemini>\n\n';
                if (onChunk) onChunk(endTag);
              }
              contentBuf += delta;
              if (onChunk) onChunk(delta);
              opts.onEvent?.({ type: 'text', content: delta });
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        if (inThoughts) {
          inThoughts = false;
          if (onChunk) onChunk('</thought-gemini>');
        }
        opts.onEvent?.({ type: 'done' });

        let finalOutput = '';
        if (thoughtStartTime) {
          if (!thoughtEndTime) thoughtEndTime = Date.now();
          const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
          finalOutput = `<thought-gemini time="${durationSec}">${thoughtBuf}</thought-gemini>\n\n${contentBuf}`;
        } else {
          finalOutput = contentBuf;
        }

        if (finalOutput) {
          history.push({ role: 'assistant', content: finalOutput });
          const maxMessages = getTuningConfig().maxHistoryMessages;
          const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
          deepseekHistories.set(convId, trimmed);
        }
        saveMessage(convId, 'user', prompt, 'deepseek');
        saveMessage(convId, 'assistant', finalOutput, 'deepseek');
        resolve({ conversationId: convId, output: finalOutput, exitCode: 0, stderr: '' });
      });

      res.on('error', reject);
    });

    req.on('error', reject);

    signal?.addEventListener('abort', () => {
      logger.debug('[deepseek] Aborting request');
      req.destroy();
      
      let finalOutput = '';
      if (thoughtStartTime) {
        if (!thoughtEndTime) thoughtEndTime = Date.now();
        const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
        finalOutput = `<thought-gemini time="${durationSec}">${thoughtBuf}</thought-gemini>\n\n${contentBuf}`;
      } else {
        finalOutput = contentBuf;
      }
      resolve({ conversationId: convId, output: finalOutput, exitCode: 1, stderr: 'Aborted' });
    });

    req.write(body);
    req.end();
  });
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
  const cfg = loadModelsConfig();
  const modelId = cfg?.routing[model] ?? 'gemini-3.5-flash';

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

  const backendUrl = getBackendUrl('web2api');
  if (!backendUrl) {
    return { conversationId: '', output: '', exitCode: 1, stderr: 'Web2API backend URL not configured' };
  }
  const url = new URL(`${backendUrl}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getWeb2ApiKey()}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    let outputBuf = '';
    let inReasoning = false;
    let chunkCount = 0;
    const req = http.request(reqOptions, (res) => {
      logger.info(`[web2api] Response status=${res.statusCode}`);
      const decoder = new StringDecoder('utf-8');
      let buf = '';

      res.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          chunkCount++;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content ?? '';
            const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content ?? '';
            if (chunkCount <= 5) logger.info(`[web2api] chunk#${chunkCount} delta="${delta}" reasoningLen=${reasoning.length}`);

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
        logger.info(`[web2api] Response ended. chunkCount=${chunkCount} outputLen=${outputBuf.length}`);
        opts.onEvent?.({ type: 'done' });
        // Persist the assistant reply in history for next turn
        if (outputBuf) {
          history.push({ role: 'assistant', content: outputBuf });
          // Cap history at maxHistoryMessages (configurable via tuning) to avoid memory growth
          const maxMessages = getTuningConfig().maxHistoryMessages;
          const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
          web2apiHistories.set(convId, trimmed);
        }
        // Persist to SQLite for restart survival
        saveMessage(convId, 'user', prompt, 'web2api');
        saveMessage(convId, 'assistant', outputBuf, 'web2api');
        // Upstream returned no content (e.g. Gemini web rate-limit / empty reply).
        // Surface a clear message instead of sending a blank message.
        if (!outputBuf.trim()) {
          logger.warn(`[web2api] Empty response from upstream for model=${modelId}`);
          resolve({
            conversationId: convId,
            output: '',
            exitCode: 1,
            stderr: '⚠️ 上游返回为空，可能是 Gemini 网页端限流，请稍后重试。',
          });
          return;
        }
        resolve({ conversationId: convId, output: outputBuf, exitCode: 0, stderr: '' });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      logger.error(`[web2api] Request timeout after 120s for model=${modelId}`);
      req.destroy(new Error('web2api request timeout'));
    });

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

function mapModelToGeminiId(model: string): string {
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
  let finalUsage: any = null;
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
             if (usage) {
               finalUsage = usage;
               if (usage.thinkingTokenCount) {
                 thinkingTokens = usage.thinkingTokenCount;
               }
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
    const maxMessages = getTuningConfig().maxHistoryMessages;
    const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
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

    if (finalUsage) {
      const promptTokens = finalUsage.promptTokenCount ?? 0;
      const cachedTokens = finalUsage.cachedContentTokenCount ?? 0;
      finalResult.usage = {
        input: promptTokens - cachedTokens,
        output: finalUsage.candidatesTokenCount ?? 0,
        cached: cachedTokens,
        thinking: finalUsage.thinkingTokenCount ?? 0,
      };
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
/**
 * Execute a model run by routing to the appropriate backend.
 *
 * Routing priority (checked in order):
 *   1. Web2API models (prefix "Web2API:") → local HTTP proxy at :8081
 *   2. DeepSeek models (prefix "DeepSeek:") → local deepseek-api proxy at :5001
 *   3. Gemini models with API key configured → direct Google AI REST SSE
 *   4. Everything else → native `agy` binary (C++ child process)
 *
 * Each backend maintains its own conversation history:
 *   - agy: persisted on disk as SQLite .db files (via conversationStore)
 *   - web2api: in-memory Map<convId, message[]> (stateless service, full replay)
 *   - deepseek: in-memory Map<convId, message[]> (stateless service, full replay)
 *   - gemini-direct: in-memory Map<convId, message[]> (stateless, full replay)
 */
export async function runAgyPrint(opts: AgyRunOptions): Promise<AgyRunResult> {
  // Route web2api models directly to the local HTTP service
  if (opts.model && isWeb2ApiModel(opts.model)) {
    logger.info(`[agyCli] Routing to web2api: model=${opts.model}`);
    return runWeb2Api(opts);
  }

  // Route DeepSeek models directly to the local deepseek-api proxy
  if (opts.model && isDeepSeekModel(opts.model)) {
    logger.info(`[agyCli] Routing to DeepSeek proxy: model=${opts.model}`);
    return runDeepSeek(opts);
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
    const startTime = Date.now();
    let isTimeout = false;

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
      cleanEnv['ALL_PROXY'] = proxy;
      cleanEnv['all_proxy'] = proxy;
    }

    const redactUrl = (urlStr?: string) => {
      if (!urlStr) return urlStr;
      try {
        const url = new URL(urlStr);
        if (url.password) url.password = '***';
        return url.toString();
      } catch {
        return '***(unparseable_url)';
      }
    };

    logger.info(`[agyCli] DIAGNOSTIC - Spawning ${agy}`);
    logger.info(`[agyCli] DIAGNOSTIC - CWD: ${cwd}`);
    logger.info(`[agyCli] DIAGNOSTIC - Proxy Env: HTTP_PROXY=${redactUrl(cleanEnv['HTTP_PROXY'])} HTTPS_PROXY=${redactUrl(cleanEnv['HTTPS_PROXY'])} ALL_PROXY=${redactUrl(cleanEnv['ALL_PROXY'])} NO_PROXY=${cleanEnv['NO_PROXY'] ?? cleanEnv['no_proxy']}`);

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
      if (opts.onActivity) opts.onActivity();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errBuf += stderrDecoder.write(chunk);
    });

    // Kill agy when the AbortController fires
    signal?.addEventListener('abort', () => {
      isTimeout = true;
      logger.debug('[agyCli] Aborting — sending SIGINT to agy process');
      child.kill('SIGINT');
    });

    child.on('error', err => {
      logger.error(`[agyCli] Spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', async (code, signal) => {
      const durationMs = Date.now() - startTime;
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
      const sigStr = signal ? String(signal) : undefined;
      logger.debug(`[agyCli] Process exited with code ${exitCode} (signal: ${sigStr}). duration: ${durationMs}ms, stderr: ${errBuf.slice(0, 200)}`);

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

      let usage: AgyRunResult['usage'] | undefined;
      if (resolvedConvId) {
        try {
          const dbPath = path.join(getConversationsDir(), `${resolvedConvId}.db`);
          usage = readUsageFromDatabase(dbPath);
        } catch (e) {
          logger.warn(`[agyCli] SQLite usage extraction failed: ${e}`);
        }
      }

      resolve({ conversationId: resolvedConvId, output: outputBuf, exitCode, stderr: errBuf, signal: sigStr, durationMs, isTimeout, usage });
    });
  });
}

function parseVarint(data: Uint8Array, pos: number): { val: number; nextPos: number } {
  let val = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos];
    val |= (b & 0x7f) << shift;
    pos++;
    if (!(b & 0x80)) {
      break;
    }
    shift += 7;
  }
  return { val, nextPos: pos };
}

/** Exported for testing: manual protobuf decoder for agy usage metadata. */
export function extractUsageFromProto(m: Uint8Array): AgyRunResult['usage'] | null {
  let pos = 0;
  while (pos < m.length) {
    let pTag;
    try {
      pTag = parseVarint(m, pos);
    } catch (e) {
      break;
    }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;
    
    const wireType = tag & 7;
    const fieldNum = tag >> 3;
    
    if (fieldNum === 9 && wireType === 2) {
      // Found field 9! Let's decode it
      let pLen;
      try {
        pLen = parseVarint(m, pos);
      } catch (e) {
        break;
      }
      const len = pLen.val;
      pos = pLen.nextPos;
      if (pos + len > m.length) break;
      
      const subM = m.subarray(pos, pos + len);
      let subPos = 0;
      const usage = { input: 0, output: 0, cached: 0, thinking: 0 };
      
      while (subPos < subM.length) {
        let pSubTag;
        try {
          pSubTag = parseVarint(subM, subPos);
        } catch (e) {
          break;
        }
        const subTag = pSubTag.val;
        subPos = pSubTag.nextPos;
        if (subPos > subM.length) break;
        
        const subWireType = subTag & 7;
        const subFieldNum = subTag >> 3;
        
        if (subWireType === 0) { // Varint
          let pSubVal;
          try {
            pSubVal = parseVarint(subM, subPos);
          } catch (e) {
            break;
          }
          const val = pSubVal.val;
          subPos = pSubVal.nextPos;
          
          if (subFieldNum === 2) usage.input = val;
          else if (subFieldNum === 3) usage.output = val;
          else if (subFieldNum === 5) usage.cached = val;
          else if (subFieldNum === 10) usage.thinking = val;
        } else if (subWireType === 1) {
          subPos += 8;
        } else if (subWireType === 2) {
          let pSubLen;
          try {
            pSubLen = parseVarint(subM, subPos);
          } catch (e) {
            break;
          }
          subPos = pSubLen.nextPos + pSubLen.val;
        } else if (subWireType === 5) {
          subPos += 4;
        } else {
          subPos++;
        }
      }
      return usage;
    } else {
      // Skip this field
      if (wireType === 0) {
        let pVal;
        try {
          pVal = parseVarint(m, pos);
        } catch (e) {
          break;
        }
        pos = pVal.nextPos;
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 2) {
        let pLen;
        try {
          pLen = parseVarint(m, pos);
        } catch (e) {
          break;
        }
        pos = pLen.nextPos + pLen.val;
      } else if (wireType === 5) {
        pos += 4;
      } else {
        pos++;
      }
    }
  }
  return null;
}

/**
 * Exported for testing: full metadata protobuf decoder, extracting all known
 * fields for debugging. Returns a plain object with key/value pairs.
 *
 * Identified fields (reverse-engineered, no .proto):
 *   field 1   — timestamp blob (12 bytes, varint-encoded)
 *   field 3   — varint (role/type indicator)
 *   field 4   — tool-call JSON (string, user steps only)
 *   field 5   — repeated string labels
 *   field 6-8 — timestamp-like blobs
 *   field 9   — usage sub-message (input/output/cached/thinking)
 *   field 11  — varint (constant 1020)
 *   field 12  — conversation UUID (string)
 *   field 20  — conversation tree (parent/child IDs)
 *   field 21  — varint (nesting depth)
 *   field 26  — sub-step token-summary container
 *   field 30  — human-readable title (string)
 *   field 31  — human-readable description (string)
 */
export function extractMetadataFromProto(m: Uint8Array): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let pos = 0;

  while (pos < m.length) {
    let pTag;
    try { pTag = parseVarint(m, pos); } catch { break; }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;

    const wireType = tag & 7;
    const fieldNum = tag >> 3;

    if (wireType === 0) {
      try {
        const v = parseVarint(m, pos);
        result[`field${fieldNum}`] = v.val;
        pos = v.nextPos;
      } catch { break; }
    } else if (wireType === 1) {
      result[`field${fieldNum}`] = Buffer.from(m.slice(pos, pos + 8)).toString('hex');
      pos += 8;
    } else if (wireType === 2) {
      try {
        const pLen = parseVarint(m, pos);
        const len = pLen.val;
        pos = pLen.nextPos;
        if (pos + len > m.length) break;
        const slice = m.subarray(pos, pos + len);
        const decoded = new TextDecoder().decode(slice);

        // Classify known string fields
        if (fieldNum === 4) {
          result['toolCall'] = decoded;
        } else if (fieldNum === 5) {
          if (!result['labels']) result['labels'] = [];
          (result['labels'] as string[]).push(decoded);
        } else if (fieldNum === 9) {
          // Field 9 is the usage sub-message; already decoded at the top level
          // by readConversationHistory. Store raw preview for debugging.
          result['field9_raw'] = decoded.slice(0, 120) + (decoded.length > 120 ? '...' : '');
        } else if (fieldNum === 12) {
          result['convId'] = decoded;
        } else if (fieldNum === 20) {
          result['convTree'] = decoded.slice(0, 120);
        } else if (fieldNum === 30) {
          result['title'] = decoded;
        } else if (fieldNum === 31) {
          result['description'] = decoded;
        } else {
          // Store raw text preview for unknown string fields
          result[`field${fieldNum}`] = decoded.length > 100 ? decoded.slice(0, 100) + '...' : decoded;
        }
        pos += len;
      } catch { break; }
    } else if (wireType === 5) {
      result[`field${fieldNum}`] = Buffer.from(m.slice(pos, pos + 4)).toString('hex');
      pos += 4;
    } else {
      pos++;
    }
  }

  return result;
}

/** Exported for testing: reads agy DB and extracts usage metadata. */
export function readUsageFromDatabase(dbPath: string): AgyRunResult['usage'] | undefined {
  try {
    if (!fssync.existsSync(dbPath)) {
      return undefined;
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC').all() as any[];
    db.close();
    
    for (const row of rows) {
      if (row.metadata instanceof Uint8Array) {
        const usage = extractUsageFromProto(row.metadata);
        if (usage) {
          return usage;
        }
      }
    }
  } catch (e) {
    logger.warn(`[agyCli] readUsageFromDatabase failed: ${e}`);
  }
  return undefined;
}

// ── Conversation History Recovery ───────────────────────────────────────────

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

/**
 * Reads the full conversation history from an agy SQLite database, decoding
 * each step's protobuf payload back into readable text. Useful for seeding
 * in-memory histories (web2apiHistories / deepseekHistories) when resuming
 * a conversation from disk.
 *
 * Returns an ordered array of all steps, or null on failure.
 */
export function readConversationHistory(dbPath: string): ConversationTurn[] | null {
  try {
    if (!fssync.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT idx, step_type, status, step_payload, metadata, step_format, has_subtrajectory, error_details, permissions, task_details, render_info FROM steps ORDER BY idx ASC').all() as any[];
    db.close();

    const turns: ConversationTurn[] = [];

    for (const row of rows) {
      if (!(row.step_payload instanceof Uint8Array)) continue;

      const text = extractTextFromProto(row.step_payload);
      if (!text) continue;

      const stepType = Number(row.step_type);
      const role = stepTypeToRole(stepType);
      const md = row.metadata instanceof Uint8Array ? extractMetadataFromProto(row.metadata) : null;
      turns.push({
        role,
        content: text,
        stepType,
        idx: Number(row.idx),
        status: Number(row.status ?? 0),
        stepFormat: Number(row.step_format ?? 0),
        hasSubtrajectory: row.has_subtrajectory === 1 || row.has_subtrajectory === true,
        usage: ((md?.['usage'] ?? undefined) as ConversationTurn['usage']),
        metadata: md,
        errorDetails: row.error_details instanceof Uint8Array ? extractTextFromProto(row.error_details) ?? decodePlainText(row.error_details) : null,
        permissions: row.permissions instanceof Uint8Array ? extractTextFromProto(row.permissions) ?? decodePlainText(row.permissions) : null,
        taskDetails: row.task_details instanceof Uint8Array ? decodePlainText(row.task_details) : null,
        renderInfo: row.render_info instanceof Uint8Array ? decodePlainText(row.render_info) : null,
      });
    }

    return turns;
  } catch (e) {
    logger.warn(`[agyCli] readConversationHistory failed: ${e}`);
    return null;
  }
}

/** Decode a blob as plain UTF-8 text, with null-bytes stripped and non-printable chars replaced. */
function decodePlainText(b: Uint8Array): string {
  const decoded = new TextDecoder().decode(b);
  // Strip trailing null bytes (common in SQLite blobs) and replace other control chars
  return decoded.replace(/\0+$/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '?');
}

function stepTypeToRole(stepType: number): ConversationTurn['role'] {
  switch (stepType) {
    case 8: return 'user';
    case 9: return 'assistant';
    case 14: return 'thinking';
    case 15: return 'tool';
    case 17: return 'observation';
    case 23: return 'assistant';
    case 98: return 'title';
    default: return 'unknown';
  }
}

/**
 * Generic protobuf-to-text extractor. Walks all length-delimited (wire type 2)
 * fields and returns the longest plausible string — this works without knowing
 * the exact .proto field numbers.
 */
function extractTextFromProto(m: Uint8Array): string | null {
  let pos = 0;
  const strings: string[] = [];

  while (pos < m.length) {
    let pTag;
    try {
      pTag = parseVarint(m, pos);
    } catch {
      break;
    }
    const tag = pTag.val;
    pos = pTag.nextPos;
    if (pos > m.length) break;

    const wireType = tag & 7;

    if (wireType === 0) {
      try { const p = parseVarint(m, pos); pos = p.nextPos; } catch { break; }
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      try {
        const pLen = parseVarint(m, pos);
        const len = pLen.val;
        pos = pLen.nextPos;
        if (pos + len > m.length) break;

        const slice = m.subarray(pos, pos + len);
        const decoded = new TextDecoder().decode(slice);

        if (decoded.length >= 4 && isPlausibleText(decoded)) {
          strings.push(decoded);
        }

        pos += len;
      } catch { break; }
    } else if (wireType === 5) {
      pos += 4;
    } else {
      pos++;
    }
  }

  if (strings.length === 0) return null;
  return strings.reduce((a, b) => a.length >= b.length ? a : b);
}

/** Quick heuristic: >70% printable / whitespace / common Unicode characters. */
function isPlausibleText(s: string): boolean {
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code <= 126) printable++;
    else if (code === 10 || code === 13 || code === 9) printable++;
    else if (code > 127) printable++;
  }
  return printable / s.length > 0.7;
}

/** Clears cached model order, forcing re-read from disk on next call. */
export function clearDefaultModelsCache(): void {
  _defaultModels = undefined;
  _parsedModels = undefined; // also force reload of models.json
}

let _defaultModels: string[] | undefined;

function getDefaultModels(): string[] {
  if (_defaultModels) return _defaultModels;
  const cfg = loadModelsConfig();
  if (cfg?.defaultOrder) {
    _defaultModels = cfg.defaultOrder;
  } else {
    _defaultModels = [];
  }
  return _defaultModels;
}

export async function getAvailableModels(): Promise<string[]> {
  const cfg = loadUserConfig();
  if (cfg?.orderedModels && cfg.orderedModels.length > 0) {
    return cfg.orderedModels;
  }
  return getDefaultModels();
}

interface ParsedBlock {
  type: 'thought' | 'thought-gemini' | 'thinking' | 'think' | 'bracket';
  startTagIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  endTagIndex: number;
  isClosed: boolean;
  time?: string;
  tokens?: string;
}

/**
 * Normalize all thinking-tag variants to the canonical `<think>` / `</think>`.
 *
 * Conversion map:
 *   `<thought-gemini ...>` / `<thought ...>` / `<thinking ...>` / `[thought:`
 *   → `<think ...>`
 *   `</thought-gemini>` / `</thought>` / `</thinking>` → `</think>`
 *   `[thought:content]` → `<think>content</think>`
 *
 * Content inside ``` code fences and inline `` code is skipped.
 */
export function normalizeThinkingTags(text: string): string {
  const out: string[] = [];
  let inCodeBlock = false;
  let inInlineCode = false;
  let i = 0;

  const peek = (prefix: string): boolean => {
    if (i + prefix.length > text.length) return false;
    for (let k = 0; k < prefix.length; k++) {
      if (text[i + k].toLowerCase() !== prefix[k].toLowerCase()) return false;
    }
    return true;
  };

  const isTagBreak = (pos: number): boolean => {
    if (pos >= text.length) return true;
    const c = text[pos];
    return c === '>' || c === ' ' || c === '\n' || c === '\r' || c === '\t';
  };

  while (i < text.length) {
    // Track code fences
    if (text.startsWith('```', i)) {
      inCodeBlock = !inCodeBlock;
      out.push('```');
      i += 3;
      continue;
    }
    // Track inline code (reset at newline)
    if (text[i] === '\n') inInlineCode = false;
    if (text[i] === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      out.push('`');
      i++;
      continue;
    }
    if (inCodeBlock || inInlineCode) {
      out.push(text[i]);
      i++;
      continue;
    }

    // Closing tags
    if (peek('</thought-gemini>')) { out.push('</think>'); i += 17; continue; }
    if (peek('</thought>'))        { out.push('</think>'); i += 10; continue; }
    if (peek('</thinking>'))       { out.push('</think>'); i += 11; continue; }

    // Opening tags (longest prefix first)
    if (peek('<thought-gemini') && isTagBreak(i + 15)) {
      const gt = text.indexOf('>', i);
      if (gt !== -1) { out.push(`<think${text.slice(i + 15, gt)}>`); i = gt + 1; continue; }
    }
    if (peek('<thought') && !peek('<thought-') && isTagBreak(i + 8)) {
      const gt = text.indexOf('>', i);
      if (gt !== -1) { out.push(`<think${text.slice(i + 8, gt)}>`); i = gt + 1; continue; }
    }
    if (peek('<thinking') && isTagBreak(i + 9)) {
      const gt = text.indexOf('>', i);
      if (gt !== -1) { out.push(`<think${text.slice(i + 9, gt)}>`); i = gt + 1; continue; }
    }

    // Bracket format: [thought:content]
    if (peek('[thought:')) {
      const close = text.indexOf(']', i);
      if (close !== -1) {
        const content = text.slice(i + 9, close);
        out.push(`<think>${content}</think>`);
        i = close + 1;
        continue;
      }
    }

    out.push(text[i]);
    i++;
  }

  return out.join('');
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
    case 'think': return 8;           // '</think>'
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
  // Normalize all thought-tag variants to canonical <think> before parsing.
  const normalized = normalizeThinkingTags(text);

  const blocks: ParsedBlock[] = [];
  let inCodeBlock = false;
  let inInlineCode = false;
  let hasSeenNonWhitespaceContent = false;
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];
    if (char === '\n') {
      inInlineCode = false;
    }

    if (normalized.startsWith('```', i)) {
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

    // Canonical <think> tag (from normalizeThinkingTags) checked FIRST.
    if (matchTag(normalized, i, '<think')) {
      matchedType = 'think';
      matchedPrefix = '<think';
      endTagStr = '</think>';
    } else if (matchTag(normalized, i, '<thought-gemini')) {
      // Legacy variant — normalizeThinkingTags should have converted these,
      // but keep as fallback in case an untagged caller bypasses normalization.
      matchedType = 'thought-gemini';
      matchedPrefix = '<thought-gemini';
      endTagStr = '</thought-gemini>';
    } else if (matchTag(normalized, i, '<thought')) {
      matchedType = 'thought';
      matchedPrefix = '<thought';
      endTagStr = '</thought>';
    } else if (matchTag(normalized, i, '<thinking')) {
      matchedType = 'thinking';
      matchedPrefix = '<thinking';
      endTagStr = '</thinking>';
    } else if (startsWithIgnoreCase(normalized, i, '[thought:')) {
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
        const gtIdx = normalized.indexOf('>', i);
        if (gtIdx !== -1) {
          startTagEnd = gtIdx + 1;
          contentStart = startTagEnd;

          // Also handle 'think' for metadata extraction
          if (matchedType === 'thought-gemini' || matchedType === 'thought' || matchedType === 'thinking' || matchedType === 'think') {
            const startTagContent = normalized.slice(i + matchedPrefix.length, gtIdx);
            const timeMatch = startTagContent.match(/time=(?:"|')([^"']*?)(?:"|')/i);
            const tokensMatch = startTagContent.match(/tokens=(?:"|')([^"']*?)(?:"|')/i);
            if (timeMatch) time = timeMatch[1];
            if (tokensMatch) tokens = tokensMatch[1];
          }
        } else {
          startTagEnd = normalized.length;
          contentStart = normalized.length;
        }
      }

      let endTagIdx = -1;
      if (startTagEnd < normalized.length) {
        let tempCodeBlock = false;
        let tempInlineCode = false;
        let j = startTagEnd;
        while (j < normalized.length) {
          if (normalized[j] === '\n') {
            tempInlineCode = false;
          }
          if (normalized.startsWith('```', j)) {
            tempCodeBlock = !tempCodeBlock;
            j += 3;
            continue;
          }
          if (normalized[j] === '`' && !tempCodeBlock) {
            tempInlineCode = !tempInlineCode;
            j++;
            continue;
          }
          if (tempCodeBlock || tempInlineCode) {
            j++;
            continue;
          }
          if (startsWithIgnoreCase(normalized, j, endTagStr)) {
            endTagIdx = j;
            break;
          }
          j++;
        }
      }

      const isClosed = endTagIdx !== -1;

      if (isClosed || !hasSeenNonWhitespaceContent) {
        const contentEnd = isClosed ? endTagIdx : normalized.length;
        const endIndex = isClosed ? endTagIdx + endTagStr.length : normalized.length;
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
    const preText = normalized.slice(lastIdx, block.startTagIndex);
    if (preText) {
      segments.push({ type: 'text', value: preText });
      cleanContent += preText;
    }

    const rawInner = normalized.slice(block.contentStartIndex, block.contentEndIndex);
    const cleanedInner = cleanInnerText(rawInner);
    thoughts.push(cleanedInner);

    segments.push({
      type: 'thought',
      value: cleanedInner,
      block,
    });

    lastIdx = block.isClosed ? block.endTagIndex + getEndTagLength(block.type) : normalized.length;
  }

  const postText = normalized.slice(lastIdx);
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
    if (seg.type === 'thought' && (seg.block?.type === 'thought-gemini' || seg.block?.type === 'think')) {
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

