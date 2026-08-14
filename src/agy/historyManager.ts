/**
 * @file historyManager.ts
 * @description Scans the conversations directory for `.db` session files.
 */

import * as path from 'path';
import * as fs from 'fs';
import { getConversationsDir } from './agyCli.js';
import { logger } from '../utils/logger.js';

/**
 * Summary information for a local agy session database file.
 */
interface SessionInfo {
  uuid: string;
  mtime: number;
}

/**
 * Scans the conversations directory for `.db` files and returns a list sorted by modification time (newest first).
 */
export function listAvailableSessions(): SessionInfo[] {
  try {
    const dir = getConversationsDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir);
    const sessions: SessionInfo[] = [];
    for (const f of files) {
      if (f.endsWith('.db') && !f.endsWith('-shm') && !f.endsWith('-wal')) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        sessions.push({
          uuid: f.replace('.db', ''),
          mtime: stat.mtimeMs,
        });
      }
    }
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
  } catch (e) {
    logger.error(`Error listing sessions: ${e}`);
    return [];
  }
}
