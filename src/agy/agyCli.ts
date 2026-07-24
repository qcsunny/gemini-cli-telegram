/**
 * @file agyCli.ts
 * @description Subprocess wrapper, proxy client, and execution router for model runs.
 * This is now a thin facade that re-exports from modular files:
 *   - types.ts: shared type definitions
 *   - modelDetection.ts: model routing configuration and detection
 *   - conversationManager.ts: in-memory conversation history management
 *   - thoughtParser.ts: thought/reasoning tag normalization and extraction
 *   - protobuf.ts: protobuf parsing for agy databases
 *   - backends/deepseek.ts: DeepSeek API proxy
 *   - backends/web2api.ts: Web2API proxy
 *   - backends/geminiDirect.ts: Direct Gemini API
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../utils/logger.js';
import { loadUserConfig } from '../config/userConfig.js';
import { isWeb2ApiModel, isDeepSeekModel, isOpenCodeModel } from './modelDetection.js';
import { runWeb2Api } from './backends/web2api.js';
import { runDeepSeek } from './backends/deepseek.js';
import { runGeminiDirect } from './backends/geminiDirect.js';
import { runOpenCode } from './backends/opencode.js';
import { extractThoughtAndContent } from './thoughtParser.js';
import { readUsageFromDatabase, getConversationsDir } from './protobuf.js';
import type { AgyRunOptions, AgyRunResult } from './types.js';

// Re-export all types and functions for backward compatibility
export type { AgyRunOptions, AgyRunResult, AgyStreamEvent, ConversationTurn } from './types.js';
export { isWeb2ApiModel, isDeepSeekModel, isOpenCodeModel, clearDefaultModelsCache, getAvailableModels } from './modelDetection.js';
export { restoreHistoriesFromDb, clearDeepSeekHistory, clearWeb2ApiHistory, clearGeminiDirectHistory, clearOpenCodeHistory } from './conversationManager.js';
export { extractUsageFromProto, extractMetadataFromProto, readUsageFromDatabase, readConversationHistory } from './protobuf.js';
export { normalizeThinkingTags, extractThoughtBlocksAndSegments, extractThoughtAndContent } from './thoughtParser.js';
export { getConversationsDir } from './protobuf.js';

// Re-export runDeepSeek, runWeb2Api, runGeminiDirect, runOpenCode for direct callers
export { runDeepSeek } from './backends/deepseek.js';
export { runWeb2Api } from './backends/web2api.js';
export { runGeminiDirect } from './backends/geminiDirect.js';
export { runOpenCode } from './backends/opencode.js';

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
 * Execute a model run by routing to the appropriate backend.
 *
 * Routing priority (checked in order):
 *   1. Web2API models (prefix "Web2API:") → local HTTP proxy at :8081
 *   2. DeepSeek models (prefix "DeepSeek:") → local deepseek-api proxy at :5001
 *   3. Gemini models with API key configured → direct Google AI REST SSE
 *   4. Everything else → native `agy` binary (C++ child process)
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

  // Route OpenCode models to the local opencode binary
  if (opts.model && isOpenCodeModel(opts.model)) {
    logger.info(`[agyCli] Routing to OpenCode: model=${opts.model}`);
    return runOpenCode(opts);
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
