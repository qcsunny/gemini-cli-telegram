/**
 * @file web2api.ts
 * @description Web2API proxy backend — an OpenAI-compatible SSE endpoint.
 *
 * Only the Web2API-specific parts live here; the streaming machinery is shared
 * with deepseek in {@link runSseBackend}.
 *
 * Media models (gemini-image / gemini-music / gemini-canvas) need special
 * handling: the Go side returns base64 data URLs or inline HTML in the
 * `choices[0].delta.content` field. Streaming that to Telegram would flood
 * the chat with thousands of characters of base64. Instead, we suppress text
 * streaming for media models, collect the full response, extract the media
 * payload, save it to a temp file, and return it via `result.mediaFiles`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { getWeb2ApiKey } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { web2apiHistories, makeWeb2ApiConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult, AgyStreamEvent } from '../types.js';

/** Used when the model alias has no routing entry. */
const FALLBACK_MODEL_ID = 'gemini-3.1-pro';

/** Model IDs that produce non-text media instead of plain text. */
const MEDIA_MODEL_IDS = new Set(['gemini-image', 'gemini-music', 'gemini-canvas']);

/** Resolve a user-facing alias to the upstream model ID the Go side expects. */
function resolveModelId(alias: string): string {
  return loadModelsConfig()?.routing[alias] ?? FALLBACK_MODEL_ID;
}

/** True when the resolved model ID is a media generation model. */
function isMediaModel(alias: string | undefined): boolean {
  if (!alias) return false;
  return MEDIA_MODEL_IDS.has(resolveModelId(alias));
}

/** One extracted media file ready for `session.sendMedia()`. */
interface MediaFileInfo {
  path: string;
  type: 'photo' | 'audio' | 'video' | 'document';
  caption?: string;
}

/** Regex to find base64 data URLs in the model output. */
const DATA_URL_RE = /data:([-\w.+/]+);base64,([A-Za-z0-9+/=]+)/g;

/**
 * Extracts media files from the model output and returns them plus the
 * leftover text (preamble with data URLs / HTML stripped out).
 *
 * - gemini-image: `![image](data:image/jpeg;base64,…)` → temp JPEG/PNG file
 * - gemini-music: `[audio](data:audio/mp3;base64,…)` → temp MP3 file
 * - gemini-canvas: `<!DOCTYPE html>…</html>` → temp HTML file
 */
async function extractMediaFiles(output: string, modelId: string): Promise<{ files: MediaFileInfo[]; text: string }> {
  const files: MediaFileInfo[] = [];
  let text = output;

  if (modelId === 'gemini-canvas') {
    // Canvas returns an inline HTML document (not a data URL). The upstream
    // sometimes truncates the document mid-stream, so fall back to "DOCTYPE
    // to end of output" when no closing </html> is present.
    const htmlMatch = output.match(/(<!DOCTYPE html[\s\S]*?<\/html>)/i)
      ?? output.match(/(<!DOCTYPE html[\s\S]*)/i);
    if (htmlMatch) {
      const html = htmlMatch[1];
      const tmpPath = path.join(os.tmpdir(), `web2api-canvas-${crypto.randomUUID()}.html`);
      await fs.writeFile(tmpPath, html, 'utf-8');
      files.push({ path: tmpPath, type: 'document', caption: '📄 Canvas HTML document' });
      text = output.slice(0, htmlMatch.index).trim();
    }
  } else {
    // Image and music models return base64 data URLs in markdown. A single
    // music response can carry several payloads at once: the MP3 track, an
    // MP4 container (audio, sometimes with a visualizer), and a WebVTT
    // subtitle track — handle every mime, not just audio/*.
    const matches = [...output.matchAll(DATA_URL_RE)];
    for (const m of matches) {
      const mime = m[1];

      // Subtitle/caption tracks (text/vtt) ride along with music responses.
      // Telegram shows neither sidecar nor embedded soft-sub tracks, and
      // burning them in needs an ffmpeg re-encode — too costly here. Skip.
      if (mime.startsWith('text/')) continue;

      const buf = Buffer.from(m[2], 'base64');
      // Truncated or spurious binary fragments (<1 KB) are never real media.
      if (buf.length < 1024) continue;

      let ext: string;
      let mediaType: 'photo' | 'audio' | 'video';

      if (modelId === 'gemini-image' || mime.startsWith('image/')) {
        ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
        mediaType = 'photo';
      } else if (mime.startsWith('video/')) {
        // Gemini music often arrives as an MP4 container (audio track, or
        // audio + visualizer). Send it as video so Telegram plays it as-is.
        ext = '.mp4';
        mediaType = 'video';
      } else {
        ext = mime === 'audio/mp4' || mime === 'audio/m4a' ? '.m4a' : '.mp3';
        mediaType = 'audio';
      }

      const prefix = modelId === 'gemini-image' ? 'web2api-img' : 'web2api-music';
      const tmpPath = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}${ext}`);
      await fs.writeFile(tmpPath, buf);
      files.push({
        path: tmpPath,
        type: mediaType,
        caption: files.length === 0
          ? (mediaType === 'photo' ? '🎨 Generated image' : '🎵 Generated music')
          : undefined,
      });
    }

    // Strip EVERY markdown data-URL (any mime) from the leftover text, plus
    // any bare data URL. A single unstripped video/mp4 payload is megabytes
    // of base64 that pegs the CPU in the rendering pipeline and floods the
    // Telegram draft.
    text = output
      .replace(/!?\[[^\]]*\]\(data:[-\w.+/]+;base64,[A-Za-z0-9+/=]+\)/g, '')
      .replace(/data:[-\w.+/]+;base64,[A-Za-z0-9+/=]+/g, '')
      .trim();
  }

  return { files, text };
}

export async function runWeb2Api(opts: AgyRunOptions): Promise<AgyRunResult> {
  const mediaModel = isMediaModel(opts.model);
  const modelId = resolveModelId(opts.model ?? '');

  // For media models, suppress text streaming so base64 / HTML never reaches
  // the Telegram draft. Reasoning events still pass through so the user sees
  // the model thinking before the media arrives.
  const runOpts: AgyRunOptions = mediaModel
    ? {
        ...opts,
        onChunk: undefined,
        onEvent: opts.onEvent
          ? (event: AgyStreamEvent) => {
              if (event.type === 'text') {
                // Still signal activity so the inactivity watchdog doesn't fire.
                opts.onActivity?.();
                return;
              }
              opts.onEvent!(event);
            }
          : undefined,
      }
    : opts;

  const result = await runSseBackend(runOpts, {
    backend: 'web2api',
    label: 'Web2API',
    histories: web2apiHistories,
    makeConvId: makeWeb2ApiConvId,
    resolveModelId: (alias) => resolveModelId(alias),
    authHeaders: () => ({ 'Authorization': `Bearer ${getWeb2ApiKey()}` }),
    // The Gemini web bridge is slower than a raw API, so it gets a longer leash.
    // Set slightly above the Go-side request_timeout_sec (180s) so the Go
    // backend's own timeout fires first, surfacing the real upstream error
    // instead of a generic socket timeout here.
    timeoutMs: 200_000,
    openThinking: '<thought>',
    closeThinking: '</thought>',
    // Web2API keeps the interleaved stream verbatim: reasoning and answer can
    // alternate more than once and thoughtParser renders every block.
    buildOutput: ({ stream }) => stream,
    emptyOutputError:
      '⚠️ The upstream returned empty, possibly rate-limited by the Gemini web interface. Please try again later.',
    logFirstChunks: true,
  });

  // Post-process media model output: extract base64 / HTML into temp files.
  if (mediaModel && result.exitCode === 0 && result.output) {
    try {
      const { files, text } = await extractMediaFiles(result.output, modelId);
      result.mediaFiles = files;
      result.output = text;
    } catch (err) {
      logger.error(`[web2api] Media extraction failed for ${modelId}: ${err}`);
      // Leave result.output as-is so the user at least sees the raw output.
    }
  }

  return result;
}
