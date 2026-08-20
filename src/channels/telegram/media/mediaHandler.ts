/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file mediaHandler.ts
 * @description Handlers for single and album Telegram media messages (photos, documents, audio, voice, video).
 */

import type { Context } from 'grammy';
import type { Message } from '@grammyjs/types/message.js';
import type { ProxyAgent } from 'undici';
import * as fs from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import { ICONS } from '../ui.js';
import { downloadTelegramFile } from './mediaDownloader.js';
import { withSession } from '../bot/withSession.js';
import { reset429Backoff } from '../bot/rateLimiter.js';
import { processMessage } from '../../../core/messageLoop.js';
import { telegramFormatter } from '../formatter.js';
import type { SessionManager } from '../../../core/session.js';
import type {
  SessionOptions,
  MultimodalInput,
} from '../../../core/types.js';

/** Supported Telegram media types for extraction. */
export type TelegramMediaType = 'photo' | 'voice' | 'audio' | 'video' | 'document' | 'sticker' | 'animation' | 'video_note';

/** Extracted info from a Telegram media message. */
export interface TelegramMediaInfo {
  fileId: string;
  mimeType: string;
  caption?: string;
  fileName?: string;
}

interface AlbumBufferEntry {
  chatId: number;
  items: { mediaType: TelegramMediaType; info: TelegramMediaInfo; ctx: Context }[];
  timer: ReturnType<typeof setTimeout>;
}

// ── Media caption task instruction injection ──

const MEDIA_CAPTION_TASK_MAP: Record<string, string> = {
  '/translate': 'Translate the content in the image/document below between Chinese and English (or to the target language if one is specified), preserving the original meaning and formatting:\n\n',
  '/summarize': 'Summarize the content in the image/document below concisely and list the key points. Reply in the same language as the user\'s message:\n\n',
};

/**
 * If a media caption starts with a supported task command (/translate, /summarize),
 * strip the command token and inject the corresponding task instruction as the
 * text prompt — while leaving the actual attachment pipeline untouched.
 * Returns undefined when no task command is present.
 */
function injectMediaCaptionTask(caption?: string): string | undefined {
  if (!caption) return undefined;
  const trimmed = caption.trim();
  const lowerToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  const instruction = MEDIA_CAPTION_TASK_MAP[lowerToken];
  if (!instruction) return undefined;
  const rest = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
  return `${instruction}${rest}`;
}

/** Extract media info from a Telegram message if it carries one. */
export function extractMediaFromMessage(
  msg: Message | undefined,
): {
  type: TelegramMediaType;
  fileId: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
} | undefined {
  if (!msg) return undefined;
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return { type: 'photo', fileId: photo.file_id, mimeType: 'image/jpeg', caption: msg.caption };
  }
  if (msg.voice) {
    return { type: 'voice', fileId: msg.voice.file_id, mimeType: msg.voice.mime_type || 'audio/ogg', caption: msg.caption };
  }
  if (msg.audio) {
    return { type: 'audio', fileId: msg.audio.file_id, mimeType: msg.audio.mime_type || 'audio/mpeg', caption: msg.caption, fileName: msg.audio.file_name };
  }
  if (msg.video) {
    return { type: 'video', fileId: msg.video.file_id, mimeType: msg.video.mime_type || 'video/mp4', caption: msg.caption, fileName: msg.video.file_name };
  }
  if (msg.document) {
    return { type: 'document', fileId: msg.document.file_id, mimeType: msg.document.mime_type || 'application/octet-stream', caption: msg.caption, fileName: msg.document.file_name };
  }
  if (msg.sticker) {
    return { type: 'sticker', fileId: msg.sticker.file_id, mimeType: 'image/webp', caption: msg.caption, fileName: msg.sticker.emoji };
  }
  if (msg.animation) {
    return { type: 'animation', fileId: msg.animation.file_id, mimeType: msg.animation.mime_type || 'video/mp4', caption: msg.caption, fileName: msg.animation.file_name };
  }
  if (msg.video_note) {
    return { type: 'video_note', fileId: msg.video_note.file_id, mimeType: 'video/mp4', caption: msg.caption, fileName: 'video_note.mp4' };
  }
  return undefined;
}

/**
 * Extract media info for a specific media type from a Context message.
 * Delegates to extractMediaFromMessage and filters by the requested type.
 */
export function extractMediaInfo(
  ctx: Context,
  mediaType: TelegramMediaType,
): TelegramMediaInfo | undefined {
  const result = extractMediaFromMessage(ctx.message);
  if (!result || result.type !== mediaType) return undefined;
  return { fileId: result.fileId, mimeType: result.mimeType, caption: result.caption, fileName: result.fileName };
}

/**
 * Handle a single non-album media message from a user.
 */
export async function handleSingleMediaMessage(
  ctx: Context,
  mediaType: TelegramMediaType,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  proxyAgent?: ProxyAgent,
): Promise<void> {
  const info = extractMediaInfo(ctx, mediaType);
  if (!info) {
    await ctx.reply(`${ICONS.error} Could not retrieve ${mediaType} file info.`);
    return;
  }

  let captionText = info.caption ?? '';

  // In group chats, only respond if the bot is mentioned or replied to
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    const botUsername = ctx.me.username;
    const isMentioned = captionText.includes(`@${botUsername}`);
    const isReplyToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;

    if (!isMentioned && !isReplyToBot) {
      return;
    }

    // Clean up the mention from caption text
    if (isMentioned) {
      const mentionRegex = new RegExp(`@${botUsername}\\b`, 'gi');
      captionText = captionText.replace(mentionRegex, '').trim();
      if (ctx.message && ctx.message.caption) {
        ctx.message.caption = captionText;
      }
    }
  }

  let tempFilePath: string | undefined;

  await withSession(
    sessionManager,
    ctx,
    defaultOptions,
    async (session, channelReply) => {
      tempFilePath = await downloadTelegramFile(ctx, info.fileId, proxyAgent);

      const taskText = injectMediaCaptionTask(captionText);
      let promptText = taskText ?? captionText;
      if (!promptText || !promptText.trim()) {
        if (mediaType === 'voice' || mediaType === 'audio') {
          promptText = '请转写并理解这段语音音频内容，并根据其中的内容或指令进行回答。';
        } else if (mediaType === 'document') {
          promptText = '请阅读并分析该文件的核心内容。';
        } else if (mediaType === 'photo') {
          promptText = '请分析这幅图片的内容。';
        }
      }
      const multimodalInput: MultimodalInput = {
        text: promptText,
        media: [
          {
            type: mediaType,
            path: tempFilePath,
            mimeType: info.mimeType,
            fileName: info.fileName,
          },
        ],
      };

      try {
        await processMessage(
          session,
          multimodalInput,
          channelReply,
          telegramFormatter,
        );
      } finally {
        if (tempFilePath) {
          await fs
            .unlink(tempFilePath)
            .catch((e) =>
              logger.warn(`Failed to delete temp file: ${e}`),
            );
        }
      }
    },
  );
}

/**
 * Flush and process an album (media group) of multiple items.
 */
export async function flushAlbumBuffer(
  albumBuffer: Map<string, AlbumBufferEntry>,
  groupId: string,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  proxyAgent?: ProxyAgent,
): Promise<void> {
  const entry = albumBuffer.get(groupId);
  albumBuffer.delete(groupId);
  if (!entry || entry.items.length === 0) return;

  const firstCtx = entry.items[0].ctx;

  if (firstCtx.chat?.type === 'group' || firstCtx.chat?.type === 'supergroup') {
    const botUsername = firstCtx.me.username;
    const targetsBot = entry.items.some(({ info, ctx }) =>
      (info.caption ?? '').includes(`@${botUsername}`) || ctx.message?.reply_to_message?.from?.id === ctx.me.id,
    );
    if (!targetsBot) return;
  }

  // Telegram puts the album caption on the last media item; pick the last non-empty one.
  let captionText = '';
  for (const item of entry.items) {
    if (item.info.caption) captionText = item.info.caption;
  }

  // Clean up the mention from caption text for group chats
  if (firstCtx.chat?.type === 'group' || firstCtx.chat?.type === 'supergroup') {
    const botUsername = firstCtx.me.username;
    const mentionRegex = new RegExp(`@${botUsername}\\b`, 'gi');
    captionText = captionText.replace(mentionRegex, '').trim();
  }

  const media: {
    type: TelegramMediaType;
    path: string;
    mimeType?: string;
    fileName?: string;
  }[] = [];
  const tempPaths: string[] = [];

  try {
    for (const item of entry.items) {
      const tempFilePath = await downloadTelegramFile(
        item.ctx,
        item.info.fileId,
        proxyAgent,
      );
      tempPaths.push(tempFilePath);
      media.push({
        type: item.mediaType,
        path: tempFilePath,
        mimeType: item.info.mimeType,
        fileName: item.info.fileName,
      });
    }
  } catch (e) {
    logger.error(`Failed to download album files: ${e}`);
    for (const p of tempPaths) {
      await fs.unlink(p).catch(() => undefined);
    }
    return;
  }

  await withSession(
    sessionManager,
    firstCtx,
    defaultOptions,
    async (session, channelReply) => {
      const taskText = injectMediaCaptionTask(captionText);
      const multimodalInput: MultimodalInput = {
        text: taskText ?? captionText,
        media,
      };
      await processMessage(
        session,
        multimodalInput,
        channelReply,
        telegramFormatter,
      );
      reset429Backoff(Number(session.chatId));
    },
  );

  for (const p of tempPaths) {
    await fs
      .unlink(p)
      .catch((e) => logger.warn(`Failed to delete temp file: ${e}`));
  }
}
