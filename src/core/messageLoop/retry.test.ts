/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseErrorMessage,
  calculateRateLimitBackoffMs,
  extractErrorChannel,
  evaluateRetryState,
} from './retry.js';

describe('retry.ts', () => {
  describe('calculateRateLimitBackoffMs', () => {
    it('calculates exponential backoff capped at 30s', () => {
      expect(calculateRateLimitBackoffMs(0)).toBe(1000);
      expect(calculateRateLimitBackoffMs(1)).toBe(2000);
      expect(calculateRateLimitBackoffMs(2)).toBe(4000);
      expect(calculateRateLimitBackoffMs(3)).toBe(8000);
      expect(calculateRateLimitBackoffMs(5)).toBe(30000); // capped at 30000ms
    });
  });

  describe('extractErrorChannel', () => {
    it('detects backend channel from error string', () => {
      expect(extractErrorChannel('agy process failed')).toBe('agy (local)');
      expect(extractErrorChannel('DeepSeek API connection reset')).toBe('deepseek-api (proxy)');
      expect(extractErrorChannel('web2api returned 502')).toBe('web2api (proxy)');
      expect(extractErrorChannel('OpenCode daemon unavailable')).toBe('opencode (local)');
      expect(extractErrorChannel('general network timeout')).toBeUndefined();
    });
  });

  describe('parseErrorMessage', () => {
    it('parses rate limit error correctly', () => {
      const res = parseErrorMessage('HTTP 429: Too Many Requests');
      expect(res.type).toBe('rate_limit');
      expect(res.code).toBe('429');
    });

    it('parses connection errors correctly', () => {
      const res = parseErrorMessage('connect ECONNREFUSED 127.0.0.1:8080');
      expect(res.type).toBe('connection');
      expect(res.code).toBe('ECONNREFUSED');
    });

    it('parses authentication errors correctly', () => {
      const res = parseErrorMessage('401 unauthorized');
      expect(res.type).toBe('auth');
    });
  });

  describe('evaluateRetryState', () => {
    it('evaluates rate limit with backoff delay', () => {
      const res = evaluateRetryState('Rate limit exceeded (429)', 1, 3);
      expect(res.isRateLimited).toBe(true);
      expect(res.backoffMs).toBe(2000);
      expect(res.isPermanent).toBe(false);
    });

    it('evaluates connection error as permanent and connection-related', () => {
      const res = evaluateRetryState('ECONNREFUSED', 0, 3);
      expect(res.isConnection).toBe(true);
      expect(res.isPermanent).toBe(true);
      expect(res.backoffMs).toBe(0);
    });

    it('handles EOF cloud API error properly', () => {
      const res = evaluateRetryState('streamGenerateContent EOF error', 0, 3);
      expect(res.isPermanent).toBe(true);
      expect(res.reason).toContain('EOF network fluctuation');
    });
  });
});
