/**
 * @file outbound.ts
 * @description Outbound media delivery handler for Telegram.
 * Provides media type detection from file extensions and a dual-delivery transport:
 * primary via grammY API methods, with automatic fallback to direct cURL HTTP multipart requests if API calls fail.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import { markdownToHtml } from './formatter.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

/** Supported media categories for Telegram outbound transmission */
type MediaType =
  | 'photo'
  | 'voice'
  | 'audio'
  | 'video'
  | 'animation'
  | 'sticker'
  | 'video_note'
  | 'document'
  | 'auto';

/** Function contract for dispatching local files to a specific chat */
export type SendMediaFn = (
  filePath: string,
  type: MediaType,
  caption?: string,
) => Promise<void>;

/** Single item inside an album (media group) delivery */
export interface SendMediaGroupItem {
  filePath: string;
  type: Exclude<MediaType, 'sticker' | 'video_note' | 'auto'>;
  caption?: string;
}

/** Function contract for dispatching a batch of files as an album (media group) */
export type SendMediaGroupFn = (items: SendMediaGroupItem[]) => Promise<void>;

const EXTENSION_TO_MEDIA_TYPE: Record<string, MediaType> = {
  // Photos
  '.jpg': 'photo',
  '.jpeg': 'photo',
  '.png': 'photo',
  '.webp': 'photo',
  // Voice
  '.ogg': 'voice',
  '.opus': 'voice',
  // Audio
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  // Video
  '.mp4': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mkv': 'video',
  // Animation
  '.gif': 'animation',
  // Sticker
  '.tgs': 'sticker',
  // Video note (round video)
  '.webm': 'video_note',
};

function detectMediaType(filePath: string): MediaType {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? 'document';
}

/**
 * Creates a bound send function for a specific Telegram chat.
 * Uses bot.api directly (stable for session lifetime), not per-request ctx.
 */
export function createTelegramSendMedia(
  api: Api,
  chatId: number,
  token?: string,
  proxy?: string,
): SendMediaFn {
  return async (
    filePath: string,
    type: MediaType,
    caption?: string,
  ): Promise<void> => {
    const resolvedType = type === 'auto' ? detectMediaType(filePath) : type;
    const file = new InputFile(filePath);
    const opts = caption
      ? { caption: markdownToHtml(caption), parse_mode: 'HTML' as const }
      : {};

    logger.debug(
      `Sending ${resolvedType} to chat ${chatId}: ${filePath}`,
    );

    try {
      switch (resolvedType) {
        case 'photo':
          await api.sendPhoto(chatId, file, opts);
          break;
        case 'voice':
          await api.sendVoice(chatId, file, opts);
          break;
        case 'audio':
          await api.sendAudio(chatId, file, opts);
          break;
        case 'video':
          await api.sendVideo(chatId, file, opts);
          break;
        case 'animation':
          await api.sendAnimation(chatId, file, opts);
          break;
        case 'sticker':
          await api.sendSticker(chatId, file);
          break;
        case 'video_note':
          await api.sendVideoNote(chatId, file);
          break;
        case 'document':
        default:
          await api.sendDocument(chatId, file, opts);
          break;
      }
    } catch (e) {
      logger.error(`Failed to send media via grammy api: ${e}`);
      if (token) {
        logger.info(`Attempting fallback media delivery via curl...`);
        try {
          const methodMap: Record<MediaType, string> = {
            photo: 'sendPhoto',
            voice: 'sendVoice',
            audio: 'sendAudio',
            video: 'sendVideo',
            animation: 'sendAnimation',
            sticker: 'sendSticker',
            video_note: 'sendVideoNote',
            document: 'sendDocument',
            auto: 'sendDocument',
          };
          const method = methodMap[resolvedType] || 'sendDocument';
          const fieldMap: Record<MediaType, string> = {
            photo: 'photo',
            voice: 'voice',
            audio: 'audio',
            video: 'video',
            animation: 'animation',
            sticker: 'sticker',
            video_note: 'video_note',
            document: 'document',
            auto: 'document',
          };
          const field = fieldMap[resolvedType] || 'document';
          
          let cmd = `curl -s -X POST "https://api.telegram.org/bot${token}/${method}"`;
          if (proxy) {
            cmd += ` -x "${proxy}"`;
          }
          cmd += ` -F "chat_id=${chatId}"`;
          cmd += ` -F "${field}=@${filePath}"`;
          const supportsCaption: MediaType[] = ['photo', 'voice', 'audio', 'video', 'animation', 'document', 'auto'];
          if (caption && supportsCaption.includes(resolvedType)) {
            cmd += ` -F "caption=${markdownToHtml(caption)}"`;
            cmd += ` -F "parse_mode=HTML"`;
          }
          
          logger.info(`Executing curl fallback command`);
          const { stdout } = await execAsync(cmd);
          const res = JSON.parse(stdout);
          if (res.ok) {
            logger.info(`Curl fallback delivered media successfully.`);
            return;
          } else {
            throw new Error(res.description || 'Unknown error');
          }
        } catch (curlErr) {
          logger.error(`Curl fallback also failed: ${curlErr}`);
          throw e; // throw the original error
        }
      } else {
        throw e;
      }
    }
  };
}

/**
 * Creates a bound media-group (album) send function for a specific Telegram chat.
 * Telegram only allows grouping photos, videos, audio and documents into an album.
 */
export function createTelegramSendMediaGroup(
  api: Api,
  chatId: number,
  token?: string,
  proxy?: string,
): SendMediaGroupFn {
  return async (items: SendMediaGroupItem[]): Promise<void> => {
    if (items.length === 0) return;
    const media = items.map((item) => {
      const opts = item.caption
        ? { caption: markdownToHtml(item.caption), parse_mode: 'HTML' as const }
        : {};
      switch (item.type) {
        case 'video':
          return { type: 'video' as const, media: new InputFile(item.filePath), ...opts };
        case 'audio':
          return { type: 'audio' as const, media: new InputFile(item.filePath), ...opts };
        case 'document':
          return { type: 'document' as const, media: new InputFile(item.filePath), ...opts };
        case 'photo':
        default:
          return { type: 'photo' as const, media: new InputFile(item.filePath), ...opts };
      }
    });

    logger.debug(`Sending media group of ${items.length} items to chat ${chatId}`);

    try {
      await api.sendMediaGroup(chatId, media as never);
    } catch (e) {
      logger.error(`Failed to send media group via grammy api: ${e}`);
      if (token) {
        logger.info(`Attempting fallback media group delivery via curl...`);
        try {
          const parts = items.map((item, idx) => {
            const field = `media`;
            const itemJson = JSON.stringify({
              type: item.type,
              media: `attach://file${idx}`,
              ...(item.caption ? { caption: markdownToHtml(item.caption), parse_mode: 'HTML' } : {}),
            });
            return `-F "${field}=${itemJson}" -F "file${idx}=@${item.filePath}"`;
          });
          let cmd = `curl -s -X POST "https://api.telegram.org/bot${token}/sendMediaGroup"`;
          if (proxy) {
            cmd += ` -x "${proxy}"`;
          }
          cmd += ` -F "chat_id=${chatId}"`;
          cmd += ` ${parts.join(' ')}`;

          logger.info(`Executing curl fallback media group command`);
          const { stdout } = await execAsync(cmd);
          const res = JSON.parse(stdout);
          if (res.ok) {
            logger.info(`Curl fallback delivered media group successfully.`);
            return;
          } else {
            throw new Error(res.description || 'Unknown error');
          }
        } catch (curlErr) {
          logger.error(`Curl fallback media group also failed: ${curlErr}`);
          throw e; // throw the original error
        }
      } else {
        throw e;
      }
    }
  };
}
