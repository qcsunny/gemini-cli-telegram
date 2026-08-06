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
  const { prompt, conversationId: existingConvId, model = '', signal, proxy } = opts;
  const convId = existingConvId || makeOpenCodeConvId();
  const opencode = getOpenCodePath();
  const cwd = opts.cwd || process.cwd();

  logger.info(`[opencode] Running: ${opencode} run with model=${model}, cwd=${cwd}`);

  const cfg = loadModelsConfig();
  const modelId = (model && cfg?.routing[model]) || '';

  const args = ['run', '--format', 'json', '--thinking', '--dir', cwd, prompt];

  if (modelId) {
    args.push('--model', modelId);
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
    let stdoutBuf = '';
    let errBuf = '';
    let thoughtBuf = '';
    let contentBuf = '';
    let stepFinished = false;
    let usageTokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined;

    let leftover = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      stdoutBuf += text;
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
            thoughtBuf += part.text + '\n';
            opts.onEvent?.({ type: 'thought', content: part.text });
          } else if (part.type === 'text' && part.text) {
            contentBuf += part.text + '\n';
            opts.onEvent?.({ type: 'text', content: part.text });
          } else if (part.type === 'tool') {
            const toolName = part.tool || 'tool';
            const toolDesc = part.state?.title || part.state?.input?.command || part.state?.input?.filePath || '';
            const note = `[${toolName}] ${toolDesc}`;
            opts.onEvent?.({ type: 'text', content: note + '\n' });
          } else if (event.type === 'step_finish') {
            stepFinished = part.reason === 'stop';
            if (part.tokens) usageTokens = part.tokens;
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
    }, { once: true });

    child.on('error', (err) => {
      logger.error(`[opencode] Spawn error: ${err.message}`);
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code) => {
      const finalStderr = stderrDecoder.end();
      if (finalStderr) errBuf += finalStderr;

      if (!stepFinished) {
        opts.onEvent?.({ type: 'done' });
      }

      // If abort already settled the promise, skip DB side-effects
      if (settled) {
        resolve({ conversationId: convId, output: stdoutBuf.trim(), exitCode: code ?? 1, stderr: errBuf });
        return;
      }
      settled = true;

      const trimmedOutput = stdoutBuf.trim();

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
