/**
 * @file historyManager.ts
 * @description SQLite database management for native `agy` conversation files.
 * Provides helper functions to list session databases, undo the most recent turn in a SQLite database,
 * and physically delete session database files (`.db`, `-shm`, `-wal`).
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { getConversationsDir } from './agyCli.js';
import { logger } from '../utils/logger.js';

/**
 * Summary information for a local agy session database file.
 */
export interface SessionInfo {
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

  try {
    const db = new DatabaseSync(dbPath);
    
    // Antigravity (agy) records many steps per turn (thinking, tools, generation).
    // The safest "undo" without deep protobuf parsing is to delete the last ~5 to 10 indices
    // or rely on the user to just clarify. For a true undo, we delete everything after
    // max(idx) - 10 as a heuristic.
    
    const stmt = db.prepare('SELECT MAX(idx) as max_idx FROM steps');
    const result = stmt.get() as { max_idx: number };
    
    if (result && result.max_idx !== null && result.max_idx >= 0) {
      const max_idx = result.max_idx;
      const deleteStmt = db.prepare('DELETE FROM steps WHERE idx > ?');
      // Delete last 15 steps which should clear the last assistant generation and user prompt
      deleteStmt.run(Math.max(0, max_idx - 15));
      db.close();
      return true;
    }
    
    db.close();
    return false;
  } catch (e) {
    logger.error(`Error undoing turn in ${uuid}: ${e}`);
    return false;
  }
}

/**
 * Permanently deletes an agy session database file (`.db`) and its associated WAL/SHM files.
 *
 * @param uuid - The agy conversation UUID to delete.
 * @returns True if any files were deleted, false otherwise.
 */
export function deleteSession(uuid: string): boolean {
  try {
    const dir = getConversationsDir();
    const dbPath = path.join(dir, `${uuid}.db`);
    const shmPath = path.join(dir, `${uuid}.db-shm`);
    const walPath = path.join(dir, `${uuid}.db-wal`);

    let deletedAny = false;
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      deletedAny = true;
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    return deletedAny;
  } catch (e) {
    logger.error(`Error deleting session ${uuid}: ${e}`);
    return false;
  }
}

