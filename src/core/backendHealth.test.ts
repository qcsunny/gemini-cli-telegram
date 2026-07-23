/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  isBackendAvailable,
  markBackendFailed,
  markBackendHealthy,
  clearBackendHealth,
  isConnectionError,
  isRateLimitOrUnavailableError,
} from './backendHealth.js';

describe('backendHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    clearBackendHealth();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isBackendAvailable', () => {
    it('should return true for null channel', () => {
      expect(isBackendAvailable(null)).toBe(true);
    });

    it('should return true when no health entry exists', () => {
      expect(isBackendAvailable('web2api')).toBe(true);
    });

    it('should return false when channel is in cooldown', () => {
      markBackendFailed('deepseek');
      expect(isBackendAvailable('deepseek')).toBe(false);
    });

    it('should return true after cooldown expires', () => {
      markBackendFailed('deepseek');
      // First failure: 30s cooldown
      vi.advanceTimersByTime(30_000);
      expect(isBackendAvailable('deepseek')).toBe(true);
    });

    it('should delete entry after cooldown expires', () => {
      markBackendFailed('deepseek');
      vi.advanceTimersByTime(30_000);
      isBackendAvailable('deepseek');
      // After expiry, entry should be deleted — next call should also return true
      expect(isBackendAvailable('deepseek')).toBe(true);
    });
  });

  describe('markBackendFailed', () => {
    it('should mark channel as unavailable with 30s cooldown on first failure', () => {
      markBackendFailed('web2api');
      expect(isBackendAvailable('web2api')).toBe(false);
      // Should become available after 30s
      vi.advanceTimersByTime(29_999);
      expect(isBackendAvailable('web2api')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(isBackendAvailable('web2api')).toBe(true);
    });

    it('should double cooldown on subsequent failures', () => {
      markBackendFailed('web2api'); // fail 1: 30s
      markBackendFailed('web2api'); // fail 2: 60s (without checking availability in between)
      vi.advanceTimersByTime(30_000);
      expect(isBackendAvailable('web2api')).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(isBackendAvailable('web2api')).toBe(true);
    });

    it('should cap cooldown at 5 minutes (300s)', () => {
      // 6 consecutive failures without availability checks
      for (let i = 0; i < 6; i++) {
        markBackendFailed('web2api');
      }
      // fail 6: cooldown is min(30000 * 2^5, 300000) = min(960000, 300000) = 300000
      vi.advanceTimersByTime(299_999);
      expect(isBackendAvailable('web2api')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(isBackendAvailable('web2api')).toBe(true);
    });

    it('should not throw for null channel', () => {
      expect(() => markBackendFailed(null)).not.toThrow();
    });
  });

  describe('markBackendHealthy', () => {
    it('should clear cooldown for a channel', () => {
      markBackendFailed('web2api');
      expect(isBackendAvailable('web2api')).toBe(false);
      markBackendHealthy('web2api');
      expect(isBackendAvailable('web2api')).toBe(true);
    });

    it('should not throw for null channel', () => {
      expect(() => markBackendHealthy(null)).not.toThrow();
    });

    it('should not throw for unknown channel', () => {
      expect(() => markBackendHealthy('unknown')).not.toThrow();
    });
  });

  describe('isConnectionError', () => {
    it('should return true for ECONNREFUSED', () => {
      expect(isConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    });

    it('should return true for ENOTFOUND', () => {
      expect(isConnectionError({ code: 'ENOTFOUND' })).toBe(true);
    });

    it('should return true for ECONNRESET', () => {
      expect(isConnectionError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should return true for ENETUNREACH', () => {
      expect(isConnectionError({ code: 'ENETUNREACH' })).toBe(true);
    });

    it('should return true for ETIMEDOUT', () => {
      expect(isConnectionError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('should return true for "socket hang up" message', () => {
      expect(isConnectionError({ message: 'Socket Hang Up' })).toBe(true);
    });

    it('should return true for "connection refused" message', () => {
      expect(isConnectionError({ message: 'Connection refused' })).toBe(true);
    });

    it('should return true for "econnrefused" message', () => {
      expect(isConnectionError({ message: 'econnrefused' })).toBe(true);
    });

    it('should return false for null', () => {
      expect(isConnectionError(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isConnectionError('string')).toBe(false);
    });

    it('should return false for unrelated error code', () => {
      expect(isConnectionError({ code: 'ENOENT' })).toBe(false);
    });

    it('should return false for unrelated message', () => {
      expect(isConnectionError({ message: 'something went wrong' })).toBe(false);
    });
  });

  describe('isRateLimitOrUnavailableError', () => {
    it('should return true for 429 in stderr', () => {
      expect(isRateLimitOrUnavailableError('Error 429', '')).toBe(true);
    });

    it('should return true for quota in output', () => {
      expect(isRateLimitOrUnavailableError('', 'quota exceeded')).toBe(true);
    });

    it('should return true for exhausted', () => {
      expect(isRateLimitOrUnavailableError('Resource exhausted', '')).toBe(true);
    });

    it('should return true for rate_limit', () => {
      expect(isRateLimitOrUnavailableError('rate_limit error', '')).toBe(true);
    });

    it('should return true for rate limit', () => {
      expect(isRateLimitOrUnavailableError('rate limit exceeded', '')).toBe(true);
    });

    it('should return true for limit exceeded', () => {
      expect(isRateLimitOrUnavailableError('limit exceeded', '')).toBe(true);
    });

    it('should return true for resource_exhausted', () => {
      expect(isRateLimitOrUnavailableError('resource_exhausted', '')).toBe(true);
    });

    it('should return true for unavailable', () => {
      expect(isRateLimitOrUnavailableError('service unavailable', '')).toBe(true);
    });

    it('should return true for overloaded', () => {
      expect(isRateLimitOrUnavailableError('overloaded', '')).toBe(true);
    });

    it('should return true for capacity', () => {
      expect(isRateLimitOrUnavailableError('capacity reached', '')).toBe(true);
    });

    it('should return false for unrelated errors', () => {
      expect(isRateLimitOrUnavailableError('authentication failed', 'invalid token')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isRateLimitOrUnavailableError('RATE_LIMIT', '')).toBe(true);
      expect(isRateLimitOrUnavailableError('Quota', '')).toBe(true);
    });
  });
});
