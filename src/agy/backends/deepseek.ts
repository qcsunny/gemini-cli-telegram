/**
 * @file deepseek.ts
 * @description DeepSeek API proxy backend with streaming SSE.
 */

import * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../../utils/logger.js';
import { getTuningConfig, getBackendUrl } from '../../config/userConfig.js';
import { loadUserConfig } from '../../config/userConfig.js';
import { saveMessage, getHistory } from '../messageStore.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { deepseekHistories, makeDeepSeekConvId } from '../conversationManager.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

export async function runDeepSeek(opts: AgyRunOptions): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal } = opts;
  const cfg = loadModelsConfig();
  const modelId = cfg?.routing[model] ?? 'deepseek-v4-flash';

  const convId = existingConvId || makeDeepSeekConvId();

  const history = getHistory(deepseekHistories, convId, 'deepseek');
  history.push({ role: 'user', content: prompt });

  const config = loadUserConfig();
  const apiKey = config?.deepseekApiKey || '';

  const body = JSON.stringify({
    model: modelId,
    stream: true,
    max_tokens: 16384,
    messages: history.map(h => ({ role: h.role, content: h.content })),
  });

  const backendUrl = getBackendUrl('deepseek');
  if (!backendUrl) {
    return { conversationId: '', output: '', exitCode: 1, stderr: 'DeepSeek backend URL not configured' };
  }
  const url = new URL(`${backendUrl}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
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
                const startTag = `<thinking${timeAttr}>`;
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
                const endTag = '</thinking>\n\n';
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
          if (onChunk) onChunk('</thinking>');
        }
        opts.onEvent?.({ type: 'done' });

        let finalOutput = '';
        if (thoughtStartTime) {
          if (!thoughtEndTime) thoughtEndTime = Date.now();
          const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
          finalOutput = `<thinking time="${durationSec}">${thoughtBuf}</thinking>\n\n${contentBuf}`;
        } else {
          finalOutput = contentBuf;
        }

        if (finalOutput) {
          history.push({ role: 'assistant', content: finalOutput });
          const maxMessages = getTuningConfig().maxHistoryMessages;
          const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
          deepseekHistories.set(convId, trimmed);
          // BUG-04: Prevent unbounded Map growth (OOM risk). Evict oldest entry
          // when the map exceeds 500 active conversations.
          if (deepseekHistories.size > 500) {
            const firstKey = deepseekHistories.keys().next().value;
            if (firstKey !== undefined) deepseekHistories.delete(firstKey);
          }
        }
        saveMessage(convId, 'user', prompt, 'deepseek');
        saveMessage(convId, 'assistant', finalOutput, 'deepseek');
        resolve({ conversationId: convId, output: finalOutput, exitCode: 0, stderr: '' });
      });

      res.on('error', reject);
    });

    req.on('error', reject);

    // BUG-03: Add Socket-level read timeout so TCP half-open connections
    // (server connected but never sends data back) don't hang indefinitely.
    req.setTimeout(60_000, () => {
      req.destroy(new Error('DeepSeek socket read timeout (60s)'));
    });

    signal?.addEventListener('abort', () => {
      logger.debug('[deepseek] Aborting request');
      req.destroy();
      
      let finalOutput = '';
      if (thoughtStartTime) {
        if (!thoughtEndTime) thoughtEndTime = Date.now();
        const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
        finalOutput = `<thinking time="${durationSec}">${thoughtBuf}</thinking>\n\n${contentBuf}`;
      } else {
        finalOutput = contentBuf;
      }
      resolve({ conversationId: convId, output: finalOutput, exitCode: 1, stderr: 'Aborted' });
    });

    req.write(body);
    req.end();
  });
}
