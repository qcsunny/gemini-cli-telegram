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
import { getAgyDataDir, getStockMarketApiKey, loadUserConfig, getTuningConfig } from '../config/userConfig.js';

import { isWeb2ApiModel, isDeepSeekModel, isOpenCodeModel, isClaudeCliModel, isCodexModel } from './modelDetection.js';
import { runWeb2Api } from './backends/web2api.js';
import { runDeepSeek } from './backends/deepseek.js';

import { runOpenCode } from './backends/opencode.js';
import { runClaudeCli } from './backends/claude.js';
import { runCodex } from './backends/codex.js';
import { readUsageFromDatabase, getMaxStepIdx, getConversationsDir } from './protobuf.js';
import { createEventQueue } from './eventQueue.js';
import type { AgyRunOptions, AgyRunResult, AgyStreamEvent } from './types.js';
import { parseAgyTranscriptThoughtUpdates, describeAgyStreamEvent, pickNewConversationId } from './transcriptStream.js';

// Re-export all types and functions for backward compatibility
export type { AgyRunOptions, AgyRunResult } from './types.js';
export { isWeb2ApiModel, isDeepSeekModel, isOpenCodeModel, isClaudeCliModel, isCodexModel, clearDefaultModelsCache, getAvailableModels } from './modelDetection.js';
export { restoreHistoriesFromDb, clearDeepSeekHistory, clearWeb2ApiHistory, clearOpenCodeHistory, clearClaudeHistory, clearCodexHistory } from './conversationManager.js';
export { runClaudeCli, getClaudePath } from './backends/claude.js';
export { runCodex, getCodexPath } from './backends/codex.js';
export { extractUsageFromProto, readUsageFromDatabase, readConversationHistory } from './protobuf.js';
export { normalizeThinkingTags, extractThoughtBlocksAndSegments, extractThoughtAndContent } from './thoughtParser.js';
export { getConversationsDir } from './protobuf.js';

let _agyPath: string | undefined;

/** Grace period (ms) between SIGINT and SIGKILL escalation on abort. */
const ABORT_SIGKILL_GRACE_MS = 5000;
const TRANSCRIPT_POLL_MS = 250;

/** Path to the agy binary — prefer explicit env var, then search PATH, then common fallbacks. Cached after first resolution. */
function getAgyPath(): string {
  if (_agyPath) return _agyPath;
  if (process.env['AGY_PATH']) {
    _agyPath = process.env['AGY_PATH'];
    return _agyPath;
  }
  try {
    const resolved = execFileSync('which', ['agy'], { encoding: 'utf8' }).trim();
    if (resolved) {
      _agyPath = resolved;
      return _agyPath;
    }
  } catch {
    // fall through to defaults
  }
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) {
      _agyPath = p;
      return _agyPath;
    }
  }
  _agyPath = 'agy';
  return _agyPath;
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
  const effectiveProxy = opts.proxy || loadUserConfig()?.proxy || process.env['HTTP_PROXY'] || process.env['http_proxy'];
  const optsWithProxy = { ...opts, proxy: effectiveProxy };

  // Route web2api models directly to the local HTTP service
  if (opts.model && isWeb2ApiModel(opts.model)) {
    logger.info(`[agyCli] Routing to web2api: model=${opts.model}`);
    return runWeb2Api(optsWithProxy);
  }

  // Route DeepSeek models directly to the local deepseek-api proxy
  if (opts.model && isDeepSeekModel(opts.model)) {
    logger.info(`[agyCli] Routing to DeepSeek proxy: model=${opts.model}`);
    return runDeepSeek(optsWithProxy);
  }

  // Route OpenCode models to the local opencode binary
  if (opts.model && isOpenCodeModel(opts.model)) {
    logger.info(`[agyCli] Routing to OpenCode: model=${opts.model}`);
    return runOpenCode(optsWithProxy);
  }

  // Route Claude CLI models to the local claude binary
  if (opts.model && isClaudeCliModel(opts.model)) {
    logger.info(`[agyCli] Routing to Claude CLI: model=${opts.model}`);
    return runClaudeCli(optsWithProxy);
  }

  // Route Codex models to the local codex binary
  if (opts.model && isCodexModel(opts.model)) {
    logger.info(`[agyCli] Routing to Codex CLI: model=${opts.model}`);
    return runCodex(optsWithProxy);
  }

  const { prompt, cwd, conversationId, onChunk, signal, extraDirs, model, printTimeout, allowTools } = optsWithProxy;
  const proxy = effectiveProxy;
  const agy = getAgyPath();

  // Only pass a conversation id when it is a real agy conversation DB. Synthetic
  // ids from other backends (e.g. "opencode-...") do not exist under agy's
  // conversations dir: forwarding one makes agy silently start a fresh
  // conversation while the bot keeps the stale id, so transcript recovery
  // (thinking block) later looks in the wrong brain/ path. Treat them as no
  // conversation so agy creates a new one and the close handler detects it.
  const validConversationId =
    conversationId && fssync.existsSync(path.join(getConversationsDir(), `${conversationId}.db`))
      ? conversationId
      : undefined;
  if (conversationId && !validConversationId) {
    logger.warn(`[agyCli] conversationId "${conversationId}" has no agy DB — starting a fresh conversation`);
  }

  // Build arg list
  // The default print format streams the answer live in small chunks (measured
  // ~20-180 bytes every ~0.2s), then dumps a large buffered remainder in one
  // final write at process exit (the last chunk can hold ~50-80% of the whole
  // answer). It is NOT a true incremental feed, so UIs that want smooth
  // typewriter updates should re-chunk that final burst on their side. agy's
  // machine-readable streaming format (`stream-json`) is only requested when
  // the caller supplied a stream callback.
  const streamJson = Boolean(onChunk);
  const args: string[] = ['--print', prompt];

  if (streamJson) {
    args.push('--output-format', 'stream-json');
  }

  if (printTimeout) {
    args.push('--print-timeout', printTimeout);
  }

  // /invest flow: allow the model to use tools so it can supplement missing
  // data via web fetch / file read. This bypasses all permission prompts, so
  // it is ONLY enabled from the trusted inline /invest path.
  if (allowTools) {
    args.push('--dangerously-skip-permissions');
  }

  if (validConversationId) {
    args.push('--conversation', validConversationId);
  }

  if (model) {
    args.push('--model', model);
  }

  for (const dir of extraDirs ?? []) {
    args.push('--add-dir', dir);
  }

  // Snapshot conversations before the call so we can detect the new one
  const before = validConversationId ? new Set<string>() : await snapshotConversations();

  // Record the max step idx before this run so per-reply usage only counts new steps
  const fromIdx = validConversationId ? getMaxStepIdx(path.join(getConversationsDir(), `${validConversationId}.db`)) : -1;

  // Resolve and inject the correct Antigravity Project ID for the workspace
  const agProjectId = await findAntigravityProjectId(cwd);

  if (agProjectId) {
    args.push('--project', agProjectId);
  }

  logger.debug(`[agyCli] Spawning: ${agy} ${args.slice(0, 3).join(' ')} … (cwd=${cwd})`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let isTimeout = false;
    // Prevent close handler from executing DB side-effects after abort already settled the promise
    let settled = false;

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

    const fmpApiKey = getStockMarketApiKey();
    if (fmpApiKey) {
      cleanEnv['FMP_API_KEY'] = fmpApiKey;
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
    logger.info(`[agyCli] DIAGNOSTIC - FMP_API_KEY ${fmpApiKey ? 'configured' : 'NOT configured'} (len=${fmpApiKey?.length ?? 0})`);

    const child = spawn(agy, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv as NodeJS.ProcessEnv,
    });

    if (opts.onSpawn && child.pid !== undefined) {
      opts.onSpawn(child.pid);
    }

    let outputBuf = '';
    let streamJsonText = '';
    let streamJsonResult = '';
    let thoughtBuf = '';
    let errBuf = '';
    let transcriptConversationId: string | undefined = validConversationId;
    let transcriptPollTimer: NodeJS.Timeout | undefined;
    const processedTranscriptSteps = new Set<number>();
    // Diagnostic: read once per run so a mid-run config edit can't split the dedupe set.
    const dumpEventShapes = getTuningConfig().debugAgyStreamEvents;
    const seenEventShapes = new Set<string>();

    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');

    let accumulatedText = '';

    // Serialize async onEvent handlers so that messageLoop's tail re-chunker
    // (which awaits each oversized text event) finishes before 'done' fires and
    // before this run resolves. Without this, the final edit would jump straight
    // to the full answer, defeating the re-chunking.
    const events = createEventQueue(opts.onEvent, 'agyCli');
    const emitEvent = (event: AgyStreamEvent): void => events.emit(event);

    const emitThought = (content: string): void => {
      if (!content) return;
      thoughtBuf += content;
      opts.onActivity?.();
      // Must go through emitEvent, not opts.onEvent directly: bypassing the chain
      // lets a slow async thought handler be overtaken by the next event (and its
      // rejection go unhandled).
      emitEvent({ type: 'thought', content });
    };

    const formatToolNote = (update: Record<string, any>): string => {
      const name = String(update['tool_name'] || 'tool');
      const info = update['tool_info'] as Record<string, any> | undefined;
      const parameters = info?.['parameters'] as Record<string, any> | undefined;
      const detail = parameters
        ? Object.values(parameters).find((value) => typeof value === 'string' && value.trim())
        : undefined;
      return `[${name}]${detail ? ` ${String(detail)}` : ''}`;
    };

    const processTranscript = async (): Promise<void> => {
      if (!opts.onEvent && !opts.onChunk) return;

      let id = transcriptConversationId;
      if (!id) {
        // A brand-new conversation has no id until agy creates its .db file.
        // Without --output-format stream-json there is no `init` event either,
        // so the filesystem diff the close handler uses is the only way to learn
        // it while the run is still going.
        if (validConversationId) return;
        id = pickNewConversationId(before, await snapshotConversations());
        if (!id) return;
        transcriptConversationId = id;
        logger.info(`[agyCli] Discovered conversation UUID mid-run: ${id}`);
      }

      const logsDir = path.join(getAgyDataDir(), 'brain', id, '.system_generated', 'logs');
      let raw: string;
      try {
        raw = await fs.readFile(path.join(logsDir, 'transcript_full.jsonl'), 'utf8');
      } catch {
        try {
          raw = await fs.readFile(path.join(logsDir, 'transcript.jsonl'), 'utf8');
        } catch {
          return;
        }
      }

      for (const update of parseAgyTranscriptThoughtUpdates(raw, processedTranscriptSteps, startTime)) {
        emitThought(update.content);
      }
    };

    const handleStreamJsonLine = (line: string): void => {
      if (!line.trim()) return;
      // Opt-in contract discovery: log each distinct event *shape* once per run.
      if (dumpEventShapes) {
        let name = '?';
        try { name = String((JSON.parse(line) as any)['event'] ?? '<none>'); } catch { /* non-JSON line */ }
        const shape = describeAgyStreamEvent(line);
        if (shape && !seenEventShapes.has(shape.signature)) {
          seenEventShapes.add(shape.signature);
          logger.info(`[agyCli] stream-json shape #${seenEventShapes.size} [event=${name}]: ${shape.detail}`);
        } else if (!shape) {
          // Unknown shape: still surface it so nothing is silently dropped.
          const key = `raw:${name}`;
          if (!seenEventShapes.has(key)) {
            seenEventShapes.add(key);
            logger.info(`[agyCli] stream-json shape #${seenEventShapes.size} [event=${name}] (unrecognized layout) raw="${line.slice(0, 200)}"`);
          }
        }
      }
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event['event'] === 'init' && typeof event['conversation_id'] === 'string') {
          transcriptConversationId = event['conversation_id'];
        }
        const update = event['step_update'] as Record<string, any> | undefined;
        const delta = typeof update?.['text_delta'] === 'string' ? update['text_delta'] : '';
        if (delta) {
          streamJsonText += delta;
          accumulatedText += delta;
          onChunk?.(delta);
          emitEvent({ type: 'text', content: delta });
        }
        if (update?.['step_type'] === 'tool' && update['state'] === 'ACTIVE') {
          emitThought(`${formatToolNote(update)}\n`);
        }

        const result = event['result'] as Record<string, any> | undefined;
        if (typeof result?.['response'] === 'string') {
          streamJsonResult = result['response'];
        }
        if (event['event'] === 'step_update' || event['event'] === 'result') {
          opts.onActivity?.();
        }
      } catch {
        // Ignore incomplete/non-JSON diagnostic lines from the CLI.
      }
    };

    let chunkIndex = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;

      if (streamJson) {
        outputBuf += text;
        const lines = outputBuf.split('\n');
        outputBuf = lines.pop() || '';
        for (const line of lines) handleStreamJsonLine(line);
        return;
      }

      accumulatedText += text;
      outputBuf += text;
      chunkIndex++;

      const containsT = text.includes('<thought') || text.includes('</thought>') || text.includes('<thinking') || text.includes('</thinking>');
      logger.debug(`[STDOUT] chunk=${chunkIndex} len=${text.length} containsThought=${containsT} preview="${text.slice(0, 200).replace(/\n/g, '\\n')}"`);

      onChunk?.(text);
      // Emit incremental streaming event per chunk so the UI updates in real time
      emitEvent({ type: 'text', content: text });
      opts.onActivity?.();
    });

    // Poll whenever anything is listening — reading the transcript file has
    // nothing to do with the stdout format. Gating this on `streamJson` meant
    // regular chat (which passes onEvent but no onChunk) never streamed thinking
    // at all; only the inline path did. Mirrors the guard in backends/opencode.ts.
    if (opts.onEvent || opts.onChunk) {
      transcriptPollTimer = setInterval(() => { void processTranscript(); }, TRANSCRIPT_POLL_MS);
      transcriptPollTimer.unref?.();
    }

    child.stderr.on('data', (chunk: Buffer) => {
      errBuf += stderrDecoder.write(chunk);
    });

    // Kill agy when the AbortController fires
    signal?.addEventListener('abort', () => {
      isTimeout = true;
      settled = true;
      logger.debug('[agyCli] Aborting — sending SIGINT to agy process');
      child.kill('SIGINT');
      // Escalate to SIGKILL if the process ignores SIGINT (prevents orphaned children)
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logger.warn('[agyCli] Abort escalation — sending SIGKILL to agy process');
          try { child.kill('SIGKILL'); } catch { /* process already gone */ }
        }
      }, ABORT_SIGKILL_GRACE_MS);
      killTimer.unref?.();
      child.once('close', () => clearTimeout(killTimer));
    }, { once: true });

    child.on('error', err => {
      logger.error(`[agyCli] Spawn error: ${err.message}`);
      if (!settled) { settled = true; reject(err); }
    });

    // Declared as a named async fn rather than inlined as `on('close', async …)`:
    // an async listener's rejection is invisible to the EventEmitter, so a throw
    // anywhere below (transcript read, SQLite usage extraction) would leave this
    // promise pending forever *and* surface as an unhandled rejection.
    const handleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (transcriptPollTimer) clearInterval(transcriptPollTimer);
      await processTranscript();
      const durationMs = Date.now() - startTime;
      // Flush decoders
      const finalStdout = stdoutDecoder.end();
      if (streamJson) {
        outputBuf += finalStdout;
        if (outputBuf.trim()) handleStreamJsonLine(outputBuf);
        outputBuf = streamJsonResult || streamJsonText;
      } else if (finalStdout) {
        accumulatedText += finalStdout;
        outputBuf += finalStdout;
        onChunk?.(finalStdout);
      }

      // Wait for the tail re-chunker (if any) to drain before signalling done,
      // so the last edits happen while streaming rather than being skipped by
      // finalize's isFinished guard.
      emitEvent({ type: 'done' });
      await events.drain();
      errBuf += stderrDecoder.end();

      const exitCode = code ?? 1;
      const sigStr = signal ? String(signal) : undefined;
      logger.debug(`[agyCli] Process exited with code ${exitCode} (signal: ${sigStr}). duration: ${durationMs}ms, stderr: ${errBuf.slice(0, 200)}`);

      // If abort already settled the promise, skip expensive DB side-effects
      if (settled) {
        const abortedOutput = thoughtBuf.trim()
          ? `<thinking>${thoughtBuf.trim()}</thinking>\n\n${outputBuf}`
          : outputBuf;
        resolve({ conversationId: validConversationId ?? transcriptConversationId ?? '', output: abortedOutput, exitCode, stderr: errBuf, signal: sigStr, durationMs, isTimeout, usage: undefined });
        return;
      }
      settled = true;

      let resolvedConvId = validConversationId ?? '';

      // If this was a new conversation, detect the new .db file
      if (!validConversationId) {
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

      // If the mid-run guess disagrees, thinking streamed during this turn came
      // from the wrong conversation — worth knowing, since the final thought is
      // re-read from the correct transcript and would silently paper over it.
      if (transcriptConversationId && resolvedConvId && transcriptConversationId !== resolvedConvId) {
        logger.warn(`[agyCli] Mid-run conversation guess ${transcriptConversationId} != resolved ${resolvedConvId}; streamed thinking may have come from another conversation`);
      }

      let usage: AgyRunResult['usage'] | undefined;
      if (resolvedConvId) {
        try {
          const dbPath = path.join(getConversationsDir(), `${resolvedConvId}.db`);
          usage = readUsageFromDatabase(dbPath, fromIdx);
          logger.info(`[agyCli] Read usage from agy database: ${JSON.stringify(usage)}`);
        } catch (e) {
          logger.warn(`[agyCli] SQLite usage extraction failed: ${e}`);
        }
      }

      const finalOutput = thoughtBuf.trim()
        ? `<thinking>${thoughtBuf.trim()}</thinking>\n\n${outputBuf}`
        : outputBuf;
      resolve({ conversationId: resolvedConvId || transcriptConversationId || '', output: finalOutput, exitCode, stderr: errBuf, signal: sigStr, durationMs, isTimeout, usage });
    };

    child.on('close', (code, signal) => {
      handleClose(code, signal).catch((err: unknown) => {
        logger.error(`[agyCli] close handler failed: ${err}`);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });
}
