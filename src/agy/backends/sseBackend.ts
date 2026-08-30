/**
 * @file sseBackend.ts
 * @description Shared OpenAI-compatible SSE streaming backend.
 *
 * `deepseek`, `web2api`, `glm` and `qwen` all POST to `<base>/chat/completions` with
 * `stream: true` and read `data: {...}` frames whose `choices[0].delta` carries
 * `content` plus `reasoning_content`. Every mechanical part of that flow used to
 * exist twice, verbatim: line framing across chunk boundaries, the tail frame
 * left in the buffer when the response ends, in-memory history trimming, the
 * 500-conversation eviction cap, the socket read timeout, and abort handling.
 *
 * This module owns all of it. A backend supplies only what genuinely differs —
 * auth headers, model resolution, the reasoning-tag syntax, the timeout, and how
 * the final output string is assembled — via {@link SseBackendSpec}.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../../utils/logger.js';
import { getTuningConfig, getBackendUrl } from '../../config/userConfig.js';
import { saveMessageTurn, getHistory, type StoredMessage } from '../messageStore.js';
import { createEventQueue } from '../eventQueue.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

/** Cap on live conversations kept in a backend's in-memory history map. */
const MAX_TRACKED_CONVERSATIONS = 500;
/** Number of leading SSE frames logged when `logFirstChunks` is on. */
const CHUNK_LOG_LIMIT = 5;

/** The pieces a backend can use to assemble its final output string. */
interface SseOutputParts {
  /** Reasoning + content interleaved exactly as it was streamed, tags included. */
  stream: string;
  /** Reasoning text only, tags excluded. */
  thought: string;
  /** Answer text only, tags excluded. */
  content: string;
  /** Milliseconds spent streaming reasoning (0 when the model never reasoned). */
  thinkingMs: number;
}

/** Everything that differs between two OpenAI-compatible SSE backends. */
interface SseBackendSpec {
  /** Backend id — selects the configured URL and namespaces stored history. */
  backend: 'deepseek' | 'web2api' | 'glm' | 'qwen' | 'mimo';
  /** Extra top-level body fields merged into the request (e.g. thinking_mode). */
  extraBody?: Record<string, unknown>;
  /** Human-readable name used in error strings (`DeepSeek HTTP 500: ...`). */
  label: string;
  /** In-memory history map for this backend. */
  histories: Map<string, StoredMessage[]>;
  /** Factory for a fresh conversation id. */
  makeConvId: () => string;
  /** Upstream model id for a caller-supplied alias; undefined lets it default. */
  resolveModelId: (alias: string) => string | undefined;
  /** Extra request headers, e.g. `Authorization`. */
  authHeaders: () => Record<string, string>;
  /** Socket read timeout in ms — guards against TCP half-open connections. */
  timeoutMs: number;
  /** Opening tag streamed when reasoning starts, e.g. `<thinking time="0.0">`. */
  openThinking: string;
  /** Closing tag streamed when reasoning ends, e.g. `</thinking>`. */
  closeThinking: string;
  /** When set, sends `X-Conversation-Id: <convId>` with every request so a
   *  stateful upstream (deepseek-web2api's session cache reads exactly this
   *  header) threads all turns of one Telegram conversation into a single
   *  server-side chat session. Without it the server keys on a hash of the
   *  first user message, which collides across conversations that share an
   *  opener and leaks one conversation's context into another. */
  conversationIdHeader?: boolean;
  /** Assembles the value returned as `AgyRunResult.output`. */
  buildOutput: (parts: SseOutputParts) => string;
  /** When set, an empty upstream reply fails the run with this stderr message. */
  emptyOutputError?: string;
  /** Log the first few SSE frames (delta preview + reasoning length). */
  logFirstChunks?: boolean;
}

/** Picks the transport that matches the URL scheme — `http.request` cannot do TLS. */
function transportFor(url: URL): typeof http.request {
  return url.protocol === 'https:' ? https.request : http.request;
}

/**
 * Run one streaming turn against an OpenAI-compatible `/chat/completions`
 * endpoint, forwarding text to `onChunk` and structured events to `onEvent`.
 */
export async function runSseBackend(opts: AgyRunOptions, spec: SseBackendSpec): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal } = opts;
  const modelId = spec.resolveModelId(model);

  const convId = existingConvId || spec.makeConvId();

  // Replay the whole conversation on every request. web2api is stateless;
  // deepseek-web2api is stateful but expects the full history too — it diffs
  // against the previous turn server-side and forwards only the new user
  // message upstream. The full history doubles as the recovery path when its
  // session cache misses (restart, TTL expiry, history divergence).
  const history = getHistory(spec.histories, convId, spec.backend);
  history.push({ role: 'user', content: prompt });

  const body = JSON.stringify({
    model: modelId,
    stream: true,
    max_tokens: 16384,
    // Send only the wire fields — stored turns also carry bookkeeping like
    // `createdAt`, which strict upstreams reject.
    messages: history.map(h => ({ role: h.role, content: h.content })),
    ...spec.extraBody,
  });

  const backendUrl = getBackendUrl(spec.backend);
  if (!backendUrl) {
    return { conversationId: '', output: '', exitCode: 1, stderr: `${spec.label} backend URL not configured` };
  }
  const url = new URL(`${backendUrl}/chat/completions`);
  const reqOptions: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(spec.conversationIdHeader ? { 'X-Conversation-Id': convId } : {}),
      ...spec.authHeaders(),
    },
  };

  return new Promise((resolve, reject) => {
    const events = createEventQueue(opts.onEvent, spec.backend);
    let streamBuf = '';
    let thoughtBuf = '';
    let contentBuf = '';
    let thoughtStartTime = 0;
    let thoughtEndTime = 0;
    let inThoughts = false;
    let chunkCount = 0;
    let settled = false;

    const finish = (result: AgyRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    /** Resolve only once every queued event handler has settled, so a caller's
     *  finalize step never runs before the last streamed edit it depends on. */
    const finishAfterDrain = (result: AgyRunResult): void => {
      events.drain()
        .then(() => finish(result))
        .catch((err: unknown) => {
          logger.warn(`[${spec.backend}] event drain failed: ${err}`);
          finish(result); // `finish` is idempotent — the run must still resolve.
        });
    };

    const buildOutput = (): string => spec.buildOutput({
      stream: streamBuf,
      thought: thoughtBuf,
      content: contentBuf,
      thinkingMs: thoughtStartTime ? (thoughtEndTime || Date.now()) - thoughtStartTime : 0,
    });

    const emit = (text: string): void => {
      streamBuf += text;
      onChunk?.(text);
    };

    /** Handle one decoded `data:` payload. Shared by the streaming path and the
     *  final frame that `end` finds still sitting in the buffer. */
    const processFrame = (data: string): void => {
      if (data === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // malformed SSE line — the upstream will resend or end
      }
      const delta = (parsed as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content ?? '';
      const reasoning = (parsed as { choices?: { delta?: { reasoning_content?: string } }[] })
        ?.choices?.[0]?.delta?.reasoning_content ?? '';
      if (spec.logFirstChunks && chunkCount <= CHUNK_LOG_LIMIT) {
        logger.info(`[${spec.backend}] chunk#${chunkCount} delta="${delta}" reasoningLen=${reasoning.length}`);
      }

      if (reasoning) {
        if (!thoughtStartTime) thoughtStartTime = Date.now();
        if (!inThoughts) {
          inThoughts = true;
          emit(spec.openThinking);
        }
        thoughtBuf += reasoning;
        emit(reasoning);
        events.emit({ type: 'thought', content: reasoning });
      }

      if (delta) {
        if (thoughtStartTime && !thoughtEndTime) thoughtEndTime = Date.now();
        if (inThoughts) {
          inThoughts = false;
          emit(`${spec.closeThinking}\n\n`);
        }
        contentBuf += delta;
        emit(delta);
        events.emit({ type: 'text', content: delta });
      }
    };

    const req = transportFor(url)(reqOptions, (res) => {
      logger.info(`[${spec.backend}] Response status=${res.statusCode}`);
      const decoder = new StringDecoder('utf-8');
      let buf = '';

      if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errorBody = '';
        res.on('data', (chunk: Buffer) => { errorBody += Buffer.from(chunk).toString('utf8'); });
        res.on('end', () => finish({
          conversationId: convId,
          output: '',
          exitCode: 1,
          stderr: `${spec.label} HTTP ${res.statusCode}: ${errorBody.slice(0, 1000)}`,
        }));
        return;
      }

      res.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        const lines = buf.split('\n');
        // Keep the trailing partial line; the next chunk completes it.
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          chunkCount++;
          processFrame(line.slice(6).trim());
        }
      });

      res.on('end', () => {
        buf += decoder.end();
        const tail = buf.trim();
        if (tail.startsWith('data: ')) {
          chunkCount++;
          processFrame(tail.slice(6).trim());
        }
        // A stream that ended mid-reasoning still needs its block closed.
        if (inThoughts) {
          inThoughts = false;
          emit(spec.closeThinking);
        }
        logger.info(`[${spec.backend}] Response ended. chunkCount=${chunkCount} outputLen=${streamBuf.length}`);
        events.emit({ type: 'done' });

        const finalOutput = buildOutput();

        if (finalOutput) {
          history.push({ role: 'assistant', content: finalOutput });
          // Cap history at maxHistoryMessages (configurable via tuning) to avoid memory growth
          const maxMessages = getTuningConfig().maxHistoryMessages;
          const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
          spec.histories.set(convId, trimmed);
          // BUG-04: Prevent unbounded Map growth (OOM risk). Evict the oldest
          // entry once the map exceeds MAX_TRACKED_CONVERSATIONS.
          if (spec.histories.size > MAX_TRACKED_CONVERSATIONS) {
            const firstKey = spec.histories.keys().next().value;
            if (firstKey !== undefined) spec.histories.delete(firstKey);
          }
        }
        // Persist to SQLite atomically for restart survival
        saveMessageTurn(convId, spec.backend, prompt, finalOutput);

        // Upstream returned no content (e.g. web rate-limit / empty reply).
        // Surface a clear message instead of sending a blank message.
        if (spec.emptyOutputError && !finalOutput.trim()) {
          logger.warn(`[${spec.backend}] Empty response from upstream for model=${modelId}`);
          finishAfterDrain({
            conversationId: convId,
            output: '',
            exitCode: 1,
            stderr: spec.emptyOutputError,
          });
          return;
        }
        finishAfterDrain({ conversationId: convId, output: finalOutput, exitCode: 0, stderr: '' });
      });

      res.on('error', (err) => {
        if (!settled) reject(err);
      });
    });

    req.on('error', (err) => {
      if (!settled) reject(err);
    });

    // BUG-03: Add a socket-level read timeout so TCP half-open connections
    // (server connected but never sends data back) don't hang indefinitely.
    req.setTimeout(spec.timeoutMs, () => {
      const seconds = Math.round(spec.timeoutMs / 1000);
      logger.error(`[${spec.backend}] Request timeout after ${seconds}s for model=${modelId}`);
      req.destroy(new Error(`${spec.label} socket read timeout (${seconds}s)`));
    });

    signal?.addEventListener('abort', () => {
      logger.debug(`[${spec.backend}] Aborting request`);
      req.destroy();
      finish({ conversationId: convId, output: buildOutput(), exitCode: 1, stderr: 'Aborted' });
    }, { once: true });

    req.write(body);
    req.end();
  });
}
