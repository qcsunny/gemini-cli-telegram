import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import { markdownToHtml } from './formatter.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export type MediaType =
  | 'photo'
  | 'voice'
  | 'audio'
  | 'video'
  | 'animation'
  | 'document'
  | 'auto';

export type SendMediaFn = (
  filePath: string,
  type: MediaType,
  caption?: string,
) => Promise<void>;

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
          if (caption) {
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
