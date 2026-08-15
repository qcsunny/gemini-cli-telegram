import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { getOpenCodeDbPath } from '../../config/userConfig.js';
import { opencodeHistories, makeOpenCodeConvId } from '../conversationManager.js';
import { saveMessage } from '../messageStore.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

import * as os from 'node:os';
import * as path from 'node:path';

function getOpenCodePath(): string {
  if (process.env['OPENCODE_PATH']) return process.env['OPENCODE_PATH'];
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'opencode';
}

const SESSION_TITLE_PREFIX = 'gemini-cli-telegram:';

/** Grace period (ms) between SIGINT and SIGKILL escalation on abort. */
const ABORT_SIGKILL_GRACE_MS = 5000;
/** OpenCode persists live part text before its JSON CLI emits the completed part. */
const PART_POLL_MS = 150;

/**
 * Look up an existing opencode session id by the bot's conversation marker.
 * The bot tags every session it creates with title "gemini-cli-telegram:<convId>"
 * so subsequent turns can continue the same conversation instead of starting
 * a fresh session (which previously lost all multi-turn context).
 */
export function findSessionIdByConvId(convId: string): string | null {
  const dbPath = getOpenCodeDbPath();
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT id FROM session WHERE title = ? ORDER BY time_updated DESC LIMIT 1')
      .get(`${SESSION_TITLE_PREFIX}${convId}`) as { id: string } | undefined;
    if (row?.id) {
      logger.info(`[opencode] Found existing session ${row.id} for conv ${convId}`);
      return row.id;
    }
  } catch (err) {
    logger.warn(`[opencode] Failed to query opencode db for session lookup: ${err}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return null;
}

export async function runOpenCode(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', signal, proxy, allowTools } = opts;
  const convId = existingConvId || makeOpenCodeConvId();
  const opencode = getOpenCodePath();
  const cwd = opts.cwd || process.cwd();
  const runStartedAt = Date.now();

  logger.info(`[opencode] Running: ${opencode} run with model=${model}, cwd=${cwd}`);

  const cfg = loadModelsConfig();
  const modelId = (model && cfg?.routing[model]) || '';

  const args = ['run', '--format', 'json', '--thinking', '--dir', cwd, prompt];

  if (modelId) {
    args.push('--model', modelId);
  }

  // /invest flow: allow the model to auto-approve tools (web fetch, file read)
  // so it can supplement missing analysis data. ONLY set from the trusted
  // inline /invest path — it bypasses every permission prompt.
  if (allowTools) {
    args.push('--auto');
  }

  // Reuse the opencode-native session for multi-turn context: if this convId
  // already has a tagged session, continue it with --session; otherwise create
  // a new one and tag it so future turns can find it again.
  const existingSessionId = findSessionIdByConvId(convId);
  if (existingSessionId) {
    args.push('--session', existingSessionId);
  } else {
    args.push('--title', `${SESSION_TITLE_PREFIX}${convId}`);
  }

  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env };
    if (proxy) {
      env['HTTP_PROXY'] = proxy;
      env['HTTPS_PROXY'] = proxy;
    }
    let settled = false;

    const child = spawn(opencode, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });

    if (opts.onSpawn && child.pid !== undefined) {
      opts.onSpawn(child.pid);
    }

    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');
    let errBuf = '';
    let thoughtBuf = '';
    let contentBuf = '';
    let stdoutThoughtBuf = '';
    let stdoutContentBuf = '';
    let thoughtStartTime = 0;
    let stepFinished = false;
    let usageTokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined;
    let partPollTimer: NodeJS.Timeout | undefined;
    let partPollDb: Database.Database | undefined;
    let polledSessionId: string | null = existingSessionId;
    let sawPolledReasoning = false;
    let sawPolledText = false;
    let sawPolledTool = false;
    let livePartPollingReady = false;
    const emittedPartLengths = new Map<string, number>();
    const emittedToolParts = new Set<string>();

    const emitReasoning = (partId: string, text: string): void => {
      const previousLength = emittedPartLengths.get(partId) ?? 0;
      if (text.length <= previousLength) return;
      const delta = text.slice(previousLength);
      emittedPartLengths.set(partId, text.length);
      if (!thoughtStartTime) thoughtStartTime = Date.now();
      if (previousLength === 0 && thoughtBuf && !thoughtBuf.endsWith('\n')) thoughtBuf += '\n';
      thoughtBuf += delta;
      opts.onActivity?.();
      opts.onEvent?.({ type: 'thought', content: delta });
    };

    const emitText = (partId: string, text: string): void => {
      const previousLength = emittedPartLengths.get(partId) ?? 0;
      if (text.length <= previousLength) return;
      const delta = text.slice(previousLength);
      emittedPartLengths.set(partId, text.length);
      contentBuf += delta;
      opts.onActivity?.();
      opts.onChunk?.(delta);
      opts.onEvent?.({ type: 'text', content: delta });
    };

    const emitTool = (partId: string, data: Record<string, any>): void => {
      if (emittedToolParts.has(partId)) return;
      emittedToolParts.add(partId);
      const state = data['state'] as Record<string, any> | undefined;
      const input = state?.['input'] as Record<string, any> | undefined;
      const toolName = String(data['tool'] ?? 'tool');
      const description = state?.['title'] ?? input?.['command'] ?? input?.['filePath'] ?? input?.['url'] ?? '';
      const note = `[${toolName}]${description ? ` ${description}` : ''}`;
      if (!thoughtStartTime) thoughtStartTime = Date.now();
      if (thoughtBuf && !thoughtBuf.endsWith('\n')) thoughtBuf += '\n';
      thoughtBuf += note + '\n';
      opts.onActivity?.();
      opts.onEvent?.({ type: 'thought', content: note + '\n' });
    };

    const pollLiveParts = (): void => {
      if (!opts.onEvent && !opts.onChunk) return;
      try {
        if (!partPollDb) {
          partPollDb = new Database(getOpenCodeDbPath(), { readonly: true, fileMustExist: true });
        }
        if (!polledSessionId) {
          const session = partPollDb.prepare(
            'SELECT id FROM session WHERE title = ? ORDER BY time_updated DESC LIMIT 1',
          ).get(`${SESSION_TITLE_PREFIX}${convId}`) as { id: string } | undefined;
          polledSessionId = session?.id ?? null;
        }
        if (!polledSessionId) return;
        const rows = partPollDb.prepare(
          `SELECT p.id, p.data
             FROM part p
             JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ?
              AND json_extract(m.data, '$.role') = 'assistant'
              AND p.time_created >= ?
            ORDER BY p.time_created, p.id`,
        ).all(polledSessionId, runStartedAt - 2000) as Array<{ id: string; data: string }>;
        livePartPollingReady = true;

        for (const row of rows) {
          let data: Record<string, any>;
          try { data = JSON.parse(row.data); } catch { continue; }
          const type = data['type'];
          if (type === 'reasoning' && typeof data['text'] === 'string') {
            sawPolledReasoning = true;
            emitReasoning(row.id, data['text']);
          } else if (type === 'text' && typeof data['text'] === 'string') {
            sawPolledText = true;
            emitText(row.id, data['text']);
          } else if (type === 'tool') {
            sawPolledTool = true;
            emitTool(row.id, data);
          }
        }
      } catch (error) {
        logger.debug(`[opencode] live part polling unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    let leftover = '';
    // Assemble the final output with the thinking chain embedded (mirrors the
    // deepseek backend's `<thinking time="...">…</thinking>` format) so both the
    // main chat path (extractThoughtAndContent) and inline cards render it.
    const buildOutput = (content: string): string => {
      const thought = thoughtBuf.trim();
      if (!thought) return content;
      const durationSec = thoughtStartTime ? ((Date.now() - thoughtStartTime) / 1000).toFixed(1) : '0.0';
      return `<thinking time="${durationSec}">${thought}</thinking>\n\n${content}`;
    };
    if (opts.onEvent || opts.onChunk) {
      partPollTimer = setInterval(pollLiveParts, PART_POLL_MS);
      partPollTimer.unref?.();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      const fullText = leftover + text;
      const lines = fullText.split('\n');
      leftover = lines.pop() || ''; // keep incomplete last line for next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const part = event.part || {};
          if (part.type === 'reasoning' && part.text) {
            logger.debug(`[TRACE opencode] reasoning event: text.length=${part.text.length} preview="${part.text.slice(0, 80).replace(/\n/g, '\\n')}"`);
            stdoutThoughtBuf += part.text + '\n';
            if (!livePartPollingReady && !sawPolledReasoning) emitReasoning(`stdout-reasoning-${thoughtBuf.length}`, part.text);
          } else if (part.type === 'text' && part.text) {
            stdoutContentBuf += part.text;
            if (!livePartPollingReady && !sawPolledText) emitText(`stdout-text-${contentBuf.length}`, part.text);
          } else if (part.type === 'tool') {
            const toolName = part.tool || 'tool';
            if (!livePartPollingReady && !sawPolledTool) emitTool(`stdout-tool-${thoughtBuf.length}`, { tool: toolName, state: part.state });
          } else if (event.type === 'step_finish') {
            stepFinished = part.reason === 'stop';
            opts.onActivity?.();
            if (part.tokens) {
              usageTokens = usageTokens ? {
                input: (usageTokens.input ?? 0) + (part.tokens.input ?? 0),
                output: (usageTokens.output ?? 0) + (part.tokens.output ?? 0),
                reasoning: (usageTokens.reasoning ?? 0) + (part.tokens.reasoning ?? 0),
                cache: {
                  read: (usageTokens.cache?.read ?? 0) + (part.tokens.cache?.read ?? 0),
                  write: (usageTokens.cache?.write ?? 0) + (part.tokens.cache?.write ?? 0),
                },
              } : part.tokens;
            }
            if (stepFinished) {
              opts.onEvent?.({ type: 'done' });
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errBuf += stderrDecoder.write(chunk);
    });

    signal?.addEventListener('abort', () => {
      logger.debug('[opencode] Aborting');
      settled = true;
      child.kill('SIGINT');
      // Escalate to SIGKILL if the process ignores SIGINT (prevents orphaned children)
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logger.warn('[opencode] Abort escalation — sending SIGKILL to child process');
          try { child.kill('SIGKILL'); } catch { /* process already gone */ }
        }
      }, ABORT_SIGKILL_GRACE_MS);
      killTimer.unref?.();
      child.once('close', () => clearTimeout(killTimer));
    }, { once: true });

    child.on('error', (err) => {
      logger.error(`[opencode] Spawn error: ${err.message}`);
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code) => {
      if (partPollTimer) clearInterval(partPollTimer);
      pollLiveParts();
      try { partPollDb?.close(); } catch { /* ignore */ }
      if (!thoughtBuf.trim() && stdoutThoughtBuf.trim()) thoughtBuf = stdoutThoughtBuf;
      if (!contentBuf.trim() && stdoutContentBuf.trim()) contentBuf = stdoutContentBuf;
      const finalStderr = stderrDecoder.end();
      if (finalStderr) errBuf += finalStderr;

      if (!stepFinished) {
        opts.onEvent?.({ type: 'done' });
      }

      // If abort already settled the promise, skip DB side-effects
      if (settled) {
        resolve({ conversationId: convId, output: buildOutput(contentBuf.trim()), exitCode: code ?? 1, stderr: errBuf });
        return;
      }
      settled = true;

      const trimmedOutput = buildOutput(contentBuf.trim());

      const usage = usageTokens ? {
        input: usageTokens.input ?? 0,
        output: usageTokens.output ?? 0,
        cached: (usageTokens.cache?.read ?? 0) + (usageTokens.cache?.write ?? 0),
        thinking: usageTokens.reasoning ?? 0,
      } : undefined;

      opencodeHistories.set(convId, [
        { role: 'user', content: prompt },
        { role: 'assistant', content: trimmedOutput },
      ]);
      // Prevent unbounded Map growth (mirrors BUG-04 in web2api/deepseek).
      if (opencodeHistories.size > 500) {
        const firstKey = opencodeHistories.keys().next().value;
        if (firstKey !== undefined) opencodeHistories.delete(firstKey);
      }
      saveMessage(convId, 'user', prompt, 'opencode');
      saveMessage(convId, 'assistant', trimmedOutput, 'opencode', usage);

      resolve({
        conversationId: convId,
        output: trimmedOutput,
        exitCode: code ?? 1,
        stderr: errBuf,
        usage,
      });
    });
  });
}
