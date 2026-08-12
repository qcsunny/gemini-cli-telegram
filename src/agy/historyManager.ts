/**
 * @file historyManager.ts
 * @description SQLite database management for native `agy` conversation files.
 * Provides helper functions to list session databases, undo the most recent turn in a SQLite database,
 * and physically delete session database files (`.db`, `-shm`, `-wal`).
 */

import Database from 'better-sqlite3';
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

// NOTE: deleteSession(uuid) was here — permanently deletes .db/-shm/-wal files.
// Currently unused: the /delete_session command uses its own inline file deletion.
// function deleteSession(uuid: string): boolean {
//   const dir = getConversationsDir();
//   const dbPath = path.join(dir, `${uuid}.db`);
//   const shmPath = path.join(dir, `${uuid}.db-shm`);
//   const walPath = path.join(dir, `${uuid}.db-wal`);
//   let deletedAny = false;
//   if (fs.existsSync(dbPath)) { fs.unlinkSync(dbPath); deletedAny = true; }
//   if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
//   if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
//   return deletedAny;
// }

/**
 * Removes the most recent turn (user prompt & assistant steps) from an agy conversation SQLite database.
 * Deletes the last 15 step indices to roll back state.
 *
 * @param uuid - The agy conversation UUID.
 * @returns True if successful, false otherwise.
 */
export function undoLastTurn(uuid: string): boolean {
  const dbPath = path.join(getConversationsDir(), `${uuid}.db`);
  if (!fs.existsSync(dbPath)) return false;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { timeout: 5000 });

    // Antigravity (agy) records many steps per turn (thinking, tools, generation).
    // The safest "undo" without deep protobuf parsing is to delete the last ~5 to 10 indices
    // or rely on the user to just clarify. For a true undo, we delete everything after
    // max(idx) - 10 as a heuristic.

    const stmt = db.prepare('SELECT MAX(idx) as max_idx FROM steps');
    const result = stmt.get() as { max_idx: number } | undefined;

    if (result && result.max_idx !== null && result.max_idx !== undefined && result.max_idx >= 0) {
      const max_idx = result.max_idx;
      // Guard against deleting into another conversation's steps: never delete
      // below 2 (the conversation header/title steps). Also run inside a
      // transaction so a crash mid-delete can't tear the step sequence.
      const lowerBound = Math.max(2, max_idx - 15);
      if (max_idx <= 2) {
        db.close();
        return false;
      }
      db.transaction(() => {
        db!.prepare('DELETE FROM steps WHERE idx > ?').run(lowerBound);
      })();
      db.close();
      return true;
    }

    db.close();
    return false;
  } catch (e) {
    // SQLITE_BUSY (timeout exceeded) — the session DB is likely locked by a
    // running agy process; surface a clear message instead of silently failing.
    logger.error(`Error undoing turn in ${uuid}${e instanceof Error && e.message.includes('busy') ? ' (database locked, is the session active?)' : ''}: ${e}`);
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
