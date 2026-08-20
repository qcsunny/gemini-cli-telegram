/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file mediaDownloader.ts
 * @description Helper functions for safely streaming and downloading media files from Telegram API with retries.
 */

import type { Context } from 'grammy';
import type { ProxyAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { getTuningConfig } from '../../../config/userConfig.js';

const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_MS = 1000;

/**
 * Download a file from Telegram with retry + exponential backoff.
 * Uses ctx.api.token instead of env var so --token flag works.
 */
export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  proxyAgent?: ProxyAgent,
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram file_path not found.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const response = await undiciFetch(fileUrl, {
        dispatcher: proxyAgent,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const tempDir = path.join(os.tmpdir(), 'gemini-cli-telegram-media');
      await fs.mkdir(tempDir, { recursive: true });

      // Use unique filename to avoid collisions from concurrent downloads
      const ext = path.extname(file.file_path) || '';
      const localFilePath = path.join(
        tempDir,
        `${crypto.randomUUID()}${ext}`,
      );

      const maxBytes = getTuningConfig().maxDownloadBytes;
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > maxBytes) {
        throw new Error(`Telegram file is too large (${contentLength} bytes, limit ${maxBytes})`);
      }
      if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) throw new Error(`Telegram file exceeded the ${maxBytes}-byte download limit`);
        await fs.writeFile(localFilePath, Buffer.from(arrayBuffer));
        return localFilePath;
      }
      const fileHandle = await fs.open(localFilePath, 'wx');
      let received = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > maxBytes) {
            throw new Error(`Telegram file exceeded the ${maxBytes}-byte download limit`);
          }
          await fileHandle.write(buffer);
        }
      } catch (error) {
        await fileHandle.close().catch(() => {});
        await fs.unlink(localFilePath).catch(() => {});
        throw error;
      }
      await fileHandle.close();

      return localFilePath;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        const delay = DOWNLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `File download attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(
    `Failed to download file after ${DOWNLOAD_MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}
