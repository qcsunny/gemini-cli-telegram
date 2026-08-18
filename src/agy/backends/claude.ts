/**
 * @file claude.ts
 * @description Claude Code CLI backend runner.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { claudeHistories, makeClaudeConvId } from '../conversationManager.js';
import { saveMessage } from '../messageStore.js';
import { createEventQueue } from '../eventQueue.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

export function getClaudePath(): string {
  if (process.env['CLAUDE_PATH']) return process.env['CLAUDE_PATH'];
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

const ABORT_SIGKILL_GRACE_MS = 5000;

export async function runClaudeCli(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', signal, proxy, allowTools = true } = opts;
  const convId = existingConvId || makeClaudeConvId();
  const claude = getClaudePath();
  const cwd = opts.cwd || process.cwd();

  logger.info(`[claudeCli] Running: ${claude} with model=${model}, cwd=${cwd}`);

  const cfg = loadModelsConfig();
  const modelId = (model && cfg?.routing[model]) || '';

  const args = ['-p', '--output-format', 'stream-json'];
  if (allowTools) {
    args.push('--dangerously-skip-permissions');
  }
  if (modelId) {
    args.push('--model', modelId);
  }

  // Ensure conversation session ID is a valid UUID format for claude --session-id
  let sessionId = convId;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sessionId)) {
    const clean = sessionId.replace(/^claude-/, '');
    if (uuidRegex.test(clean)) {
      sessionId = clean;
    } else {
      sessionId = globalThis.crypto.randomUUID();
    }
  }
  args.push('--session-id', sessionId);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'] || 'https://agentrouter.org',
      ANTHROPIC_AUTH_TOKEN: process.env['ANTHROPIC_AUTH_TOKEN'] || 'PLACEHOLDER_TOKEN',
      ANTHROPIC_MODEL: process.env['ANTHROPIC_MODEL'] || 'claude-opus-5',
    };
    if (proxy) {
      env['HTTP_PROXY'] = proxy;
      env['HTTPS_PROXY'] = proxy;
    }

    let settled = false;
    const events = createEventQueue(opts.onEvent, 'claude');

    const resolveAfterDrain = (result: AgyRunResult): void => {
      events.drain()
        .then(() => resolve(result))
        .catch((err: unknown) => {
          logger.warn(`[claudeCli] event drain failed: ${err}`);
          resolve(result);
        });
    };

    const child = spawn(claude, args, {
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
    let leftover = '';
    let contentBuf = '';
    let thoughtBuf = '';
    let stepFinished = false;
    let isError = false;
    let usageTokens: { input: number; output: number; cached: number; thinking: number } | undefined;

    const processStdoutLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'content_block_delta') {
          const delta = event.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            contentBuf += delta.text;
            opts.onChunk?.(delta.text);
            opts.onActivity?.();
            events.emit({ type: 'text', content: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            thoughtBuf += delta.thinking;
            opts.onChunk?.(delta.thinking);
            opts.onActivity?.();
            events.emit({ type: 'thought', content: delta.thinking });
          }
        } else if (event.type === 'assistant') {
          opts.onActivity?.();
          const message = event.message || {};
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && block.text && !contentBuf) {
                contentBuf = block.text;
                opts.onChunk?.(block.text);
                events.emit({ type: 'text', content: block.text });
              } else if (block.type === 'thinking' && block.thinking && !thoughtBuf) {
                thoughtBuf = block.thinking;
                opts.onChunk?.(block.thinking);
                events.emit({ type: 'thought', content: block.thinking });
              }
            }
          }
        } else if (event.type === 'result') {
          stepFinished = true;
          opts.onActivity?.();
          if (event.is_error) {
            isError = true;
          }
          if (event.result && typeof event.result === 'string' && !contentBuf) {
            contentBuf = event.result;
            opts.onChunk?.(event.result);
            events.emit({ type: 'text', content: event.result });
          }
          const usage = event.usage;
          if (usage) {
            usageTokens = {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cached: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
              thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
            };
          }
          events.emit({ type: 'done' });
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
      logger.debug('[claudeCli] Aborting child process');
      settled = true;
      child.kill('SIGINT');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logger.warn('[claudeCli] Abort escalation — sending SIGKILL');
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, ABORT_SIGKILL_GRACE_MS);
      killTimer.unref?.();
      child.once('close', () => clearTimeout(killTimer));
    }, { once: true });

    child.on('error', (err) => {
      logger.error(`[claudeCli] Spawn error: ${err.message}`);
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

      const trimmedOutput = contentBuf.trim();

      claudeHistories.set(convId, [
        { role: 'user', content: prompt },
        { role: 'assistant', content: trimmedOutput },
      ]);
      if (claudeHistories.size > 500) {
        const firstKey = claudeHistories.keys().next().value;
        if (firstKey !== undefined) claudeHistories.delete(firstKey);
      }
      saveMessage(convId, 'user', prompt, 'claude');
      saveMessage(convId, 'assistant', trimmedOutput, 'claude', usageTokens);

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
