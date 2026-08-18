/**
 * @file codex.ts
 * @description Codex CLI backend runner.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { codexHistories, makeCodexConvId } from '../conversationManager.js';
import { saveMessage } from '../messageStore.js';
import { createEventQueue } from '../eventQueue.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

export const codexThreadMap = new Map<string, string>();

export function getCodexPath(): string {
  if (process.env['CODEX_PATH']) return process.env['CODEX_PATH'];
  const candidates = [
    '/path/to/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'codex';
}

const ABORT_SIGKILL_GRACE_MS = 5000;

export async function runCodex(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', signal, proxy, allowTools = true } = opts;
  const convId = existingConvId || makeCodexConvId();
  const codex = getCodexPath();
  const cwd = opts.cwd || process.cwd();

  logger.info(`[codexCli] Running: ${codex} with model=${model}, cwd=${cwd}`);

  const cfg = loadModelsConfig();
  const modelId = (model && cfg?.routing[model]) || '';

  const threadId = codexThreadMap.get(convId);
  const args: string[] = [];

  if (threadId) {
    args.push('exec', 'resume', threadId, prompt, '--json', '--skip-git-repo-check');
  } else {
    args.push('exec', prompt, '--json', '--skip-git-repo-check');
  }

  if (allowTools) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (modelId) {
    args.push('--model', modelId);
  }

  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      AGENTROUTER_API_KEY: process.env['AGENTROUTER_API_KEY'] || 'PLACEHOLDER_TOKEN',
    };
    if (proxy) {
      env['HTTP_PROXY'] = proxy;
      env['HTTPS_PROXY'] = proxy;
    }

    let settled = false;
    const events = createEventQueue(opts.onEvent, 'codex');

    const resolveAfterDrain = (result: AgyRunResult): void => {
      events.drain()
        .then(() => resolve(result))
        .catch((err: unknown) => {
          logger.warn(`[codexCli] event drain failed: ${err}`);
          resolve(result);
        });
    };

    const child = spawn(codex, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });

    if (opts.onSpawn && child.pid !== undefined) {
      opts.onSpawn(child.pid);
    }

    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');
    let leftover = '';
    let errBuf = '';
    let contentBuf = '';
    let thoughtBuf = '';
    let stepFinished = false;
    let isError = false;
    let usageTokens: { input: number; output: number; cached: number; thinking: number } | undefined;

    const processStdoutLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && event.thread_id) {
          codexThreadMap.set(convId, event.thread_id);
          opts.onActivity?.();
        } else if (event.type === 'item.completed' || event.type === 'item.updated') {
          opts.onActivity?.();
          const item = event.item || {};
          if (item.type === 'agent_message' && item.text) {
            contentBuf = item.text;
            opts.onChunk?.(item.text);
            events.emit({ type: 'text', content: item.text });
          } else if (item.type === 'reasoning' && item.text) {
            thoughtBuf = item.text;
            opts.onChunk?.(item.text);
            events.emit({ type: 'thought', content: item.text });
          }
        } else if (event.type === 'turn.completed') {
          stepFinished = true;
          opts.onActivity?.();
          const usage = event.usage;
          if (usage) {
            usageTokens = {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cached: usage.cached_input_tokens ?? 0,
              thinking: usage.reasoning_output_tokens ?? 0,
            };
          }
          events.emit({ type: 'done' });
        } else if (event.type === 'turn.failed' || event.is_error) {
          isError = true;
          opts.onActivity?.();
          if (event.error?.message) {
            errBuf += event.error.message;
          }
        }
      } catch {
        // ignore non-JSON output
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      const fullText = leftover + text;
      const lines = fullText.split('\n');
      leftover = lines.pop() || '';
      for (const line of lines) processStdoutLine(line);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      errBuf += stderrDecoder.write(chunk);
    });

    signal?.addEventListener('abort', () => {
      logger.debug('[codexCli] Aborting child process');
      settled = true;
      child.kill('SIGINT');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logger.warn('[codexCli] Abort escalation — sending SIGKILL');
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, ABORT_SIGKILL_GRACE_MS);
      killTimer.unref?.();
      child.once('close', () => clearTimeout(killTimer));
    }, { once: true });

    child.on('error', (err) => {
      logger.error(`[codexCli] Spawn error: ${err.message}`);
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code) => {
      const finalStdout = stdoutDecoder.end();
      if (finalStdout) leftover += finalStdout;
      processStdoutLine(leftover);
      leftover = '';

      const finalStderr = stderrDecoder.end();
      if (finalStderr) errBuf += finalStderr;

      if (!stepFinished) {
        events.emit({ type: 'done' });
      }

      if (settled) {
        resolveAfterDrain({
          conversationId: convId,
          output: contentBuf.trim(),
          exitCode: (code === 0 && !isError) ? 0 : (code || 1),
          stderr: errBuf,
        });
        return;
      }
      settled = true;

      if (!contentBuf && thoughtBuf) {
        contentBuf = thoughtBuf;
      }
      const trimmedOutput = contentBuf.trim();

      codexHistories.set(convId, [
        { role: 'user', content: prompt },
        { role: 'assistant', content: trimmedOutput },
      ]);
      if (codexHistories.size > 500) {
        const firstKey = codexHistories.keys().next().value;
        if (firstKey !== undefined) codexHistories.delete(firstKey);
      }
      saveMessage(convId, 'user', prompt, 'codex');
      saveMessage(convId, 'assistant', trimmedOutput, 'codex', usageTokens);

      const effectiveExitCode = (code === 0 && !isError) ? 0 : (code ?? 1);

      resolveAfterDrain({
        conversationId: convId,
        output: trimmedOutput,
        exitCode: effectiveExitCode,
        stderr: errBuf || (isError ? trimmedOutput : ''),
        usage: usageTokens,
      });
    });
  });
}
