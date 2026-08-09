import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DaemonSession } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getAgyDataDir } from '../../config/userConfig.js';

export async function detectAndSendNewArtifacts(
  session: DaemonSession,
  conversationId: string,
  turnStartTime: number,
): Promise<void> {
  if (!session.sendMedia || !conversationId) return;

  const baseDir = getAgyDataDir();

  const artifactDir = path.join(baseDir, 'brain', conversationId);
  try {
    const files = await fs.readdir(artifactDir).catch(() => [] as string[]);
    const photos: { filePath: string; file: string }[] = [];
    for (const file of files) {
      if (file.startsWith('.') || file === 'scratch' || file === '.system_generated' || file === '.user_uploaded') {
        continue;
      }
      const filePath = path.join(artifactDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      // Only detect files created or modified since the current turn started
      // We subtract 2000ms (2s) to handle any clock skew or system clock resolution issues
      if (stat.mtimeMs >= turnStartTime - 2000) {
        const ext = path.extname(file).toLowerCase();
        let mediaType: 'photo' | 'video' | 'audio' | 'voice' | 'document' = 'document';
        if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
          mediaType = 'photo';
        } else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) {
          mediaType = 'video';
        } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
          mediaType = 'audio';
        }

        if (mediaType === 'photo') {
          photos.push({ filePath, file });
          continue;
        }

        logger.info(`[messageLoop] Automatically sending generated artifact file to Telegram: ${file} (type: ${mediaType})`);
        try {
          await session.sendMedia(filePath, mediaType, `🎨 Generated: ${file}`);
        } catch (e) {
          logger.error(`[messageLoop] Failed to send media ${file}: ${e}`);
        }
      }
    }

    if (photos.length > 0) {
      if (photos.length === 1 || !session.sendMediaGroup) {
        const { filePath, file } = photos[0];
        logger.info(`[messageLoop] Automatically sending generated artifact photo to Telegram: ${file}`);
        try {
          await session.sendMedia(filePath, 'photo', `🎨 Generated: ${file}`);
        } catch (e) {
          logger.error(`[messageLoop] Failed to send media ${file}: ${e}`);
        }
      } else {
        logger.info(`[messageLoop] Automatically sending ${photos.length} generated photos as an album to Telegram`);
        try {
          await session.sendMediaGroup(
            photos.map((p, i) => ({
              filePath: p.filePath,
              type: 'photo' as const,
              caption: i === 0 ? `🎨 Generated: ${photos.length} photos` : undefined,
            })),
          );
        } catch (e) {
          logger.error(`[messageLoop] Failed to send photo album: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`[messageLoop] Error detecting new artifacts: ${e}`);
  }
}
