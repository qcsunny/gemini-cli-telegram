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

        logger.info(`[messageLoop] Automatically sending generated artifact file to Telegram: ${file} (type: ${mediaType})`);
        try {
          await session.sendMedia(filePath, mediaType, `🎨 Generated: ${file}`);
        } catch (e) {
          logger.error(`[messageLoop] Failed to send media ${file}: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`[messageLoop] Error detecting new artifacts: ${e}`);
  }
}
