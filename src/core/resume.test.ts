/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { listAvailableSessions, resumeSession } from './resume.js';
import { SESSION_FILE_PREFIX } from '@google/gemini-cli-core';

vi.mock('node:fs/promises');
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual('@google/gemini-cli-core') as any;
  return {
    ...actual,
    convertSessionToClientHistory: vi.fn().mockReturnValue([]),
  };
});

describe('resume', () => {
  const mockTempDir = '/mock/temp';
  const mockConfig = {
    storage: {
      getProjectTempDir: () => mockTempDir,
    },
    setSessionId: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('listAvailableSessions', () => {
    it('should return an empty list if chats directory does not exist', async () => {
      const error = new Error('ENOENT');
      (error as any).code = 'ENOENT';
      vi.mocked(fs.readdir).mockRejectedValue(error);
      const sessions = await listAvailableSessions(mockConfig);
      expect(sessions).toEqual([]);
    });

    it('should list and sort session files', async () => {
      const session1 = {
        sessionId: 'session-1',
        messages: [{ type: 'user', content: 'Hello' }],
        startTime: '2026-05-10T10:00:00Z',
        lastUpdated: '2026-05-10T10:05:00Z',
      };
      const session2 = {
        sessionId: 'session-2',
        messages: [{ type: 'user', content: 'World' }],
        startTime: '2026-05-10T11:00:00Z',
        lastUpdated: '2026-05-10T11:05:00Z',
      };

      vi.mocked(fs.readdir).mockResolvedValue([
        `${SESSION_FILE_PREFIX}1.json`,
        `${SESSION_FILE_PREFIX}2.json`,
        'other-file.txt',
      ] as any);

      vi.mocked(fs.readFile).mockImplementation((p: any) => {
        if (p.includes('1.json')) return Promise.resolve(JSON.stringify(session1));
        if (p.includes('2.json')) return Promise.resolve(JSON.stringify(session2));
        return Promise.reject(new Error('File not found'));
      });

      const sessions = await listAvailableSessions(mockConfig);

      expect(sessions.length).toBe(2);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[1].id).toBe('session-2');
      expect(sessions[0].index).toBe(1);
      expect(sessions[1].index).toBe(2);
      expect(sessions[0].title).toBe('Hello');
    });

    it('should deduplicate sessions by ID and keep most recent', async () => {
      const session1Old = {
        sessionId: 'session-1',
        messages: [{ type: 'user', content: 'Old' }],
        startTime: '2026-05-10T10:00:00Z',
        lastUpdated: '2026-05-10T10:05:00Z',
      };
      const session1New = {
        sessionId: 'session-1',
        messages: [{ type: 'user', content: 'New' }],
        startTime: '2026-05-10T10:00:00Z',
        lastUpdated: '2026-05-10T11:05:00Z',
      };

      vi.mocked(fs.readdir).mockResolvedValue([
        `${SESSION_FILE_PREFIX}1.json`,
        `${SESSION_FILE_PREFIX}2.json`,
      ] as any);

      vi.mocked(fs.readFile).mockImplementation((p: any) => {
        if (p.includes('1.json')) return Promise.resolve(JSON.stringify(session1Old));
        if (p.includes('2.json')) return Promise.resolve(JSON.stringify(session1New));
        return Promise.reject(new Error('File not found'));
      });

      const sessions = await listAvailableSessions(mockConfig);

      expect(sessions.length).toBe(1);
      expect(sessions[0].title).toBe('New');
    });
  });

  describe('resumeSession', () => {
    it('should resume the latest session if identifier is latest', async () => {
      const sessionData = {
        sessionId: 'session-latest',
        messages: [{ type: 'user', content: 'Latest' }],
        startTime: '2026-05-10T12:00:00Z',
        lastUpdated: '2026-05-10T12:05:00Z',
      };

      vi.mocked(fs.readdir).mockResolvedValue([`${SESSION_FILE_PREFIX}latest.json`] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sessionData));

      const mockSession = {
        config: mockConfig,
        geminiClient: {
          resumeChat: vi.fn().mockResolvedValue(undefined),
        },
        sessionId: 'old-session',
      } as any;

      const result = await resumeSession(mockSession, 'latest');

      expect(result).toContain('Resumed session 1: Latest');
      expect(mockSession.sessionId).toBe('session-latest');
      expect(mockConfig.setSessionId).toHaveBeenCalledWith('session-latest');
    });

    it('should throw error if session not found', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      
      const mockSession = { config: mockConfig } as any;

      await expect(resumeSession(mockSession, '999')).rejects.toThrow('No sessions found to resume.');
    });
  });
});
