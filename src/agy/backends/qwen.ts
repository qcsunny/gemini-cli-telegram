/**
 * @file qwen.ts
 * @description Qwen (chat.qwen.ai) web2api proxy backend — an OpenAI-compatible
 * SSE endpoint served by the local Qwen2API instance.
 *
 * Only the Qwen-specific parts live here; the streaming machinery is shared with
 * deepseek / web2api / glm in {@link runSseBackend}.
 *
 * Qwen2API derives the upstream `chat_type` from the model id's suffix, so one
 * id encodes both the base model and what it produces: `-thinking` streams
 * `reasoning_content` (t2t), `-image` generates a picture (t2i) and `-video`
 * generates a clip (t2v). Media turns come back as a markdown URL rather than a
 * base64 payload, so — unlike web2api — the file has to be fetched here before
 * Telegram can send it.
 *
 * The upstream WAF (Aliyun x5sec) answers a request it dislikes with HTTP 200
 * and a captcha `punish?...` URL as the body. Left alone that URL would be
 * rendered as the model's answer, so it is detected and turned into an error.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { loadUserConfig } from '../../config/userConfig.js';
import { loadModelsConfig } from '../../core/modelRegistry.js';
import { qwenHistories, makeQwenConvId } from '../conversationManager.js';
import { runSseBackend } from './sseBackend.js';
import type { AgyRunOptions, AgyRunResult, AgyStreamEvent } from '../types.js';

/** Upstream id used when a display name carries no routing entry. */
const QWEN_FALLBACK_MODEL_ID = 'qwen3.8-max-thinking';

/** One extracted media file ready for `session.sendMedia()`. */
interface QwenMediaFile {
  path: string;
  type: 'photo' | 'video';
  caption?: string;
}

/** Markdown wrappers Qwen2API puts around a generated asset's URL. */
const IMAGE_URL_RE = /!\[image\]\((https?:\/\/[^\s)]+)\)/g;
const VIDEO_URL_RE = /\[Download Video\]\((https?:\/\/[^\s)]+)\)/g;
/** Aliyun x5sec captcha wall — arrives as HTTP 200 with the punish URL as body. */
const PUNISH_RE = /punish\?|x5secdata|FAIL_SYS_USER_VALIDATE|RGV587/i;

/** Resolve a display name to the upstream model id Qwen2API expects. */
function resolveModelId(alias: string): string {
  return loadModelsConfig()?.routing[alias] ?? QWEN_FALLBACK_MODEL_ID;
}

/** t2i / t2v ids produce a media asset instead of text (see file header). */
function mediaKindOf(modelId: string): 'photo' | 'video' | null {
  if (modelId.endsWith('-image')) return 'photo';
  if (modelId.endsWith('-video')) return 'video';
  return null;
}

/** Download one generated asset to a temp file. Rejects on non-2xx so the
 *  caller can leave the raw URL in the text instead of sending a broken file. */
function downloadTo(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? https.get : http.get;
    get(url, (res) => {
      // Qwen's CDN redirects signed asset URLs at least once.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadTo(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { fs.writeFile(dest, Buffer.concat(chunks)).then(resolve, reject); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Pull generated images / videos out of the reply and download each one.
 * Returns the files plus the text with those markdown links stripped.
 */
async function extractMediaFiles(output: string, kind: 'photo' | 'video'): Promise<{ files: QwenMediaFile[]; text: string }> {
  const re = kind === 'photo' ? IMAGE_URL_RE : VIDEO_URL_RE;
  const urls = [...output.matchAll(re)].map(m => m[1]!);
  const files: QwenMediaFile[] = [];

  for (const url of urls) {
    const ext = kind === 'photo' ? (/\.png(\?|$)/i.test(url) ? '.png' : '.jpg') : '.mp4';
    const tmpPath = path.join(os.tmpdir(), `qwen-${kind}-${crypto.randomUUID()}${ext}`);
    try {
      await downloadTo(url, tmpPath);
      files.push({
        path: tmpPath,
        type: kind,
        caption: files.length === 0 ? (kind === 'photo' ? '🎨 Qwen 生成图像' : '🎬 Qwen 生成视频') : undefined,
      });
    } catch (err) {
      logger.warn(`[qwen] Asset download failed (${url.slice(0, 80)}…): ${err}`);
    }
  }

  // Drop the markdown links and the `<video>` wrapper; keep any prose around
  // them. A bare asset URL left behind would be re-rendered as a link.
  let text = output
    .replace(IMAGE_URL_RE, '')
    .replace(VIDEO_URL_RE, '')
    .replace(/<video[^>]*>[\s\S]*?<\/video>/gi, '')
    .trim();
  if (files.length && text === '') text = '';
  return { files, text };
}

export async function runQwen(opts: AgyRunOptions): Promise<AgyRunResult> {
  const modelId = resolveModelId(opts.model ?? '');
  const mediaKind = mediaKindOf(modelId);

  // Media turns stream the asset URL as ordinary content. Suppressing text
  // keeps a raw signed URL (or a captcha link) out of the Telegram draft while
  // reasoning events still show the model working.
  const runOpts: AgyRunOptions = mediaKind
    ? {
        ...opts,
        onChunk: undefined,
        onEvent: opts.onEvent
          ? (event: AgyStreamEvent) => {
              if (event.type === 'text') {
                opts.onActivity?.(); // keep the inactivity watchdog quiet
                return;
              }
              opts.onEvent!(event);
            }
          : undefined,
      }
    : opts;

  const result = await runSseBackend(runOpts, {
    backend: 'qwen',
    label: 'Qwen',
    histories: qwenHistories,
    makeConvId: makeQwenConvId,
    resolveModelId: (alias) => resolveModelId(alias),
    authHeaders: (): Record<string, string> => {
      const apiKey = loadUserConfig()?.backends?.qwenKey || '';
      return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    },
    // qwen3.8-max-thinking measured 225s end-to-end on a hard reasoning prompt,
    // and Qwen2API's own upstream budget is 10 minutes for text. Video is worse:
    // it polls the render task after the turn returns, so it gets its own leash.
    timeoutMs: mediaKind === 'video' ? 920_000 : 640_000,
    // Same reasoning-tag syntax as GLM: the duration is unknown while streaming,
    // so the live tag carries 0.0 and buildOutput stamps the measured value.
    openThinking: '<thinking time="0.0">',
    closeThinking: '</thinking>',
    buildOutput: ({ thought, content, thinkingMs }) => {
      if (!thought) return content;
      const durationSec = (thinkingMs / 1000).toFixed(1);
      return `<thinking time="${durationSec}">${thought}</thinking>\n\n${content}`;
    },
    emptyOutputError: 'Qwen 上游返回空内容（可能触发限流或会话失效），请重试或换模型',
    logFirstChunks: true,
  });

  // The WAF answers with HTTP 200 and a captcha URL as the body, so a "successful"
  // run can still be a wall. Fail it loudly rather than sending the link.
  if (result.exitCode === 0 && PUNISH_RE.test(result.output)) {
    logger.warn(`[qwen] x5sec captcha wall for model=${modelId}`);
    return {
      ...result,
      output: '',
      exitCode: 1,
      stderr: `Qwen 上游要求人机验证（x5sec），model=${modelId} 本次被拦。` +
        '文本模型通常不受影响；生图/生视频需要账号在浏览器里过一次验证后刷新 cookie。',
    };
  }

  if (mediaKind && result.exitCode === 0 && result.output) {
    result.mediaModel = true;
    try {
      const { files, text } = await extractMediaFiles(result.output, mediaKind);
      result.mediaFiles = files;
      result.output = text;
    } catch (err) {
      logger.error(`[qwen] Media extraction failed for ${modelId}: ${err}`);
      // Leave result.output as-is so the user at least sees the asset URL.
    }
  }

  return result;
}
