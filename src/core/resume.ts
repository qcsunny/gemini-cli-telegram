/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSession } from './types.js';
import { listAvailableSessions as getAgySessions } from '../agy/historyManager.js';

export interface SessionListEntry {
  index: number;
  id: string;
  fileName: string;
  title: string;
  messageCount: number;
  lastUpdated: string;
  relativeTime: string;
}

/**
 * List available sessions
 */
export async function listAvailableSessions(config?: any): Promise<SessionListEntry[]> {
  const sessions = getAgySessions();
  return sessions.map((s, idx) => {
    const d = new Date(s.mtime);
    return {
      index: idx + 1,
      id: s.uuid,
      fileName: `${s.uuid}.db`,
      title: s.uuid,
      messageCount: 0,
      lastUpdated: d.toISOString(),
      relativeTime: d.toLocaleDateString(),
    };
  });
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
