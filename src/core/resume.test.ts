/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { listAvailableSessions, resumeSession } from './resume.js';

vi.mock('../agy/historyManager.js', () => ({
  listAvailableSessions: vi.fn(() => []),
}));

describe('resume', () => {
  describe('listAvailableSessions', () => {
    it('should return an empty list because agy CLI manages sessions automatically', async () => {
      const sessions = await listAvailableSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('resumeSession', () => {
    it('should return a static confirmation message', async () => {
      const mockSession = {} as any;
      const result = await resumeSession(mockSession, 'latest');
      expect(result).toBe('Successfully switched active agy session to latest');
    });
  });
});
