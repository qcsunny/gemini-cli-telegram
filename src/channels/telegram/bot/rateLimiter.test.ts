import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  draftBackoffUntil,
  record429Backoff,
  reset429Backoff,
  is429Error,
  get429RetryAfter,
} from './rateLimiter.js';

beforeEach(() => {
  draftBackoffUntil.clear();
});

describe('is429Error', () => {
  it('should return false for null/undefined', () => {
    expect(is429Error(null)).toBe(false);
    expect(is429Error(undefined)).toBe(false);
  });

  it('should detect 429 via error_code', () => {
    expect(is429Error({ error_code: 429 })).toBe(true);
  });

  it('should detect 429 via status', () => {
    expect(is429Error({ status: 429 })).toBe(true);
  });

  it('should detect 429 via retry_after parameter', () => {
    expect(is429Error({ parameters: { retry_after: 5 } })).toBe(true);
  });

  it('should detect 429 via payload.parameters.retry_after', () => {
    expect(is429Error({ payload: { parameters: { retry_after: 5 } } })).toBe(true);
  });

  it('should detect 429 via message string', () => {
    expect(is429Error({ message: 'HTTP 429 Too Many Requests' })).toBe(true);
    expect(is429Error(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('should return false for non-429 errors', () => {
    expect(is429Error({ error_code: 400 })).toBe(false);
    expect(is429Error({ message: 'Bad Request' })).toBe(false);
  });
});

describe('get429RetryAfter', () => {
  it('should extract retry_after from parameters', () => {
    expect(get429RetryAfter({ parameters: { retry_after: 15 } })).toBe(15);
  });

  it('should extract retry_after from payload.parameters', () => {
    expect(get429RetryAfter({ payload: { parameters: { retry_after: 30 } } })).toBe(30);
  });

  it('should return undefined when no retry_after', () => {
    expect(get429RetryAfter({ error_code: 429 })).toBeUndefined();
    expect(get429RetryAfter({})).toBeUndefined();
    expect(get429RetryAfter(null)).toBeUndefined();
  });
});

describe('record429Backoff', () => {
  it('should set backoff with default wait when no retry_after', () => {
    const before = Date.now();
    record429Backoff(1);
    const until = draftBackoffUntil.get(1)!;
    expect(until).toBeGreaterThanOrEqual(before + 1000 + 100);
  });

  it('should use retry_after when provided', () => {
    const before = Date.now();
    record429Backoff(1, 10);
    const until = draftBackoffUntil.get(1)!;
    expect(until).toBeGreaterThanOrEqual(before + 10000 + 100);
  });

  it('should increase monotonically with each successive call', () => {
    record429Backoff(1);
    const first = draftBackoffUntil.get(1)!;
    record429Backoff(1);
    const second = draftBackoffUntil.get(1)!;
    record429Backoff(1);
    const third = draftBackoffUntil.get(1)!;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);
  });

  it('should not decrease backoff', () => {
    record429Backoff(1, 100);
    const first = draftBackoffUntil.get(1)!;

    record429Backoff(1, 1);
    const second = draftBackoffUntil.get(1)!;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe('reset429Backoff', () => {
  it('should clear backoff state for a chat', () => {
    record429Backoff(1);
    expect(draftBackoffUntil.has(1)).toBe(true);
    reset429Backoff(1);
    expect(draftBackoffUntil.has(1)).toBe(false);
  });

  it('should do nothing for unknown chat', () => {
    expect(() => reset429Backoff(999)).not.toThrow();
  });
});
