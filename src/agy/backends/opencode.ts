import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import { logger } from '../../utils/logger.js';
import { opencodeHistories, makeOpenCodeConvId } from '../conversationManager.js';
import { saveMessage } from '../messageStore.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

function getOpenCodePath(): string {
  if (process.env['OPENCODE_PATH']) return process.env['OPENCODE_PATH'];
  const candidates = [
    '/home/qcsunny/.opencode/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'opencode';
}

export async function runOpenCode(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', signal, proxy } = opts;
  const convId = existingConvId || makeOpenCodeConvId();
  const opencode = getOpenCodePath();
  const cwd = opts.cwd || process.cwd();

  logger.info(`[opencode] Running: ${opencode} run with model=${model}, cwd=${cwd}`);

  const args = ['run', '--format', 'json', '--dir', cwd, prompt];

  if (model) {
    const cleanModel = model.replace(/^OpenCode:\s*/, '').trim();
    if (cleanModel) {
      args.push('--model', cleanModel);
    }
  }

  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env };
    if (proxy) {
      env['HTTP_PROXY'] = proxy;
      env['HTTPS_PROXY'] = proxy;
    }

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

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      stdoutBuf += text;
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const part = event.part || {};
          if (part.type === 'reasoning' && part.text) {
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
      child.kill('SIGINT');
    });

    child.on('error', (err) => {
      logger.error(`[opencode] Spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      const finalStderr = stderrDecoder.end();
      if (finalStderr) errBuf += finalStderr;

      if (!stepFinished) {
        opts.onEvent?.({ type: 'done' });
      }

      const trimmedOutput = stdoutBuf.trim();

      opencodeHistories.set(convId, [
        { role: 'user', content: prompt },
        { role: 'assistant', content: trimmedOutput },
      ]);
      saveMessage(convId, 'user', prompt, 'opencode');
      saveMessage(convId, 'assistant', trimmedOutput, 'opencode');

      resolve({
        conversationId: convId,
        output: trimmedOutput,
        exitCode: code ?? 1,
        stderr: errBuf,
      });
    });
  });
}
