/**
 * @file web2api.ts
 * @description Web2API proxy backend with streaming SSE.
 */

import * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../../utils/logger.js';
import { getTuningConfig, getBackendUrl, getWeb2ApiKey } from '../../config/userConfig.js';
import { saveMessageTurn, getHistory } from '../messageStore.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { web2apiHistories, makeWeb2ApiConvId } from '../conversationManager.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

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
  const history = getHistory(web2apiHistories, convId, 'web2api');
  history.push({ role: 'user', content: prompt });

  const body = JSON.stringify({
    model: modelId,
    stream: true,
    max_tokens: 16384,
    messages: history,
  });

  const backendUrl = getBackendUrl('web2api');
  if (!backendUrl) {
    return { conversationId: '', output: '', exitCode: 1, stderr: 'Web2API backend URL not configured' };
  }
  const url = new URL(`${backendUrl}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
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
    let settled = false;
    const finish = (result: AgyRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(reqOptions, (res) => {
      logger.info(`[web2api] Response status=${res.statusCode}`);
      const decoder = new StringDecoder('utf-8');
      let buf = '';

      if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errorBody = '';
        res.on('data', (chunk) => { errorBody += Buffer.from(chunk).toString('utf8'); });
        res.on('end', () => finish({
          conversationId: convId,
          output: '',
          exitCode: 1,
          stderr: `Web2API HTTP ${res.statusCode}: ${errorBody.slice(0, 1000)}`,
        }));
        return;
      }

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
        buf += decoder.end();
        if (buf.trim()) {
          const line = buf.trim();
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed?.choices?.[0]?.delta?.content ?? '';
                const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content ?? '';
                if (reasoning) {
                  if (!inReasoning) {
                    inReasoning = true;
                    outputBuf += '<thought>';
                    onChunk?.('<thought>');
                  }
                  outputBuf += reasoning;
                  onChunk?.(reasoning);
                  opts.onEvent?.({ type: 'thought', content: reasoning });
                }
                if (delta) {
                  if (inReasoning) {
                    inReasoning = false;
                    outputBuf += '</thought>\n\n';
                    onChunk?.('</thought>\n\n');
                  }
                  outputBuf += delta;
                  onChunk?.(delta);
                  opts.onEvent?.({ type: 'text', content: delta });
                }
              } catch { /* ignore malformed final SSE line */ }
            }
          }
        }
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
          // BUG-fix: Prevent unbounded Map growth (OOM risk). Evict oldest entry
          // when the map exceeds 500 active conversations.
          if (web2apiHistories.size > 500) {
            const firstKey = web2apiHistories.keys().next().value;
            if (firstKey !== undefined) web2apiHistories.delete(firstKey);
          }
        }
        // Persist to SQLite atomically for restart survival
        saveMessageTurn(convId, 'web2api', prompt, outputBuf);
        // Upstream returned no content (e.g. Gemini web rate-limit / empty reply).
        // Surface a clear message instead of sending a blank message.
        if (!outputBuf.trim()) {
          logger.warn(`[web2api] Empty response from upstream for model=${modelId}`);
          finish({
            conversationId: convId,
            output: '',
            exitCode: 1,
            stderr: '⚠️ The upstream returned empty, possibly rate-limited by the Gemini web interface. Please try again later.',
          });
          return;
        }
        finish({ conversationId: convId, output: outputBuf, exitCode: 0, stderr: '' });
      });

      res.on('error', (err) => {
        if (!settled) reject(err);
      });
    });

    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    req.setTimeout(120000, () => {
      logger.error(`[web2api] Request timeout after 120s for model=${modelId}`);
      req.destroy(new Error('web2api request timeout'));
    });

    signal?.addEventListener('abort', () => {
      logger.debug('[web2api] Aborting request');
      req.destroy();
      finish({ conversationId: convId, output: outputBuf, exitCode: 1, stderr: 'Aborted' });
    }, { once: true });

    req.write(body);
    req.end();
  });
}
