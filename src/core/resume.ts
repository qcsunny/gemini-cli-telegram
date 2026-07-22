/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file resume.ts
 * @description Session listing and switching utilities.
 * Extracts conversation metadata (title, modified timestamp) from SQLite summaries database
 * or transcript logs, and switches active session context for a chat.
 */

import type { DaemonSession } from './types.js';
import { listAvailableSessions as getAgySessions } from '../agy/historyManager.js';

/**
 * Metadata entry representing a resumable agy session in UI lists.
 */
export interface SessionListEntry {
  index: number;
  id: string;
  fileName: string;
  title: string;
  messageCount: number;
  lastUpdated: string;
  relativeTime: string;
}

import Database from 'better-sqlite3';

/**
 * Extracts conversation title and last modified timestamp for a given session UUID.
 * Queries conversation_summaries.db first; falls back to parsing transcript.jsonl.
 */
function getSessionMetadata(uuid: string, defaultMtimeMs: number): { title: string; date: Date } {
  // 1. Primary: Query conversation_summaries.db for preview and authentic last_modified_time
  try {
    const homeDir = process.env['HOME'] || '/root';
    const dbPath = `${homeDir}/.gemini/antigravity-cli/conversation_summaries.db`;
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT title, preview, last_modified_time FROM conversation_summaries WHERE conversation_id = ?').get(uuid) as { title?: string; preview?: string; last_modified_time?: string } | undefined;
      db.close();
      if (row) {
        const text = (row.preview || row.title || '').trim();
        const title = text ? text.replace(/^[#*`\- >]+/g, '').substring(0, 25) : uuid.slice(0, 8);
        const date = row.last_modified_time ? new Date(row.last_modified_time) : new Date(defaultMtimeMs);
        return { title, date };
      }
    }
  } catch {
    // fallback
  }

  // 2. Secondary fallback: transcript.jsonl
  let title = uuid.slice(0, 8);
  try {
    const homeDir = process.env['HOME'] || '/root';
    const transcriptPath = `${homeDir}/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript.jsonl`;
    if (fs.existsSync(transcriptPath)) {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'USER_INPUT' && obj.content) {
            let text = String(obj.content)
              .replace(/<USER_REQUEST>/gi, '')
              .replace(/<\/USER_REQUEST>/gi, '')
              .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
              .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
              .trim();
            const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0);
            if (firstLine) {
              title = firstLine.replace(/^[#*`\- >]+/g, '').substring(0, 25);
              break;
            }
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // fallback
  }

  return { title, date: new Date(defaultMtimeMs) };
}

function formatShortRelativeTime(date: Date): string {
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

import * as fs from 'fs';

/**
 * List available sessions
 */
export async function listAvailableSessions(config?: any): Promise<SessionListEntry[]> {
  const sessions = getAgySessions();
  const entries = sessions.map((s) => {
    const meta = getSessionMetadata(s.uuid, s.mtime);
    return {
      id: s.uuid,
      fileName: `${s.uuid}.db`,
      title: meta.title,
      messageCount: 0,
      lastUpdated: meta.date.toISOString(),
      relativeTime: formatShortRelativeTime(meta.date),
      mtimeMs: meta.date.getTime(),
    };
  });

  // Sort by authentic last_modified_time descending (newest first)
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return entries.map((e, idx) => ({
    ...e,
    index: idx + 1,
  }));
}

/**
 * Resume a session
 */
export async function resumeSession(
  session: DaemonSession,
  identifier: string,
): Promise<string> {
  const sessions = getAgySessions();
  const idx = parseInt(identifier, 10);
  let targetUuid = identifier;
  if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
    targetUuid = sessions[idx - 1].uuid;
  }
  
  session.conversationId = targetUuid;
  if (session.chatId) {
    const { setConversation } = await import('../agy/conversationStore.js');
    await setConversation(
      session.chatId,
      targetUuid,
      session.currentProject?.path || process.cwd(),
      session.model
    );
  }
  return `Successfully switched active agy session to ${targetUuid}`;
}
