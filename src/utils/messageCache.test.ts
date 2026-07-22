import { describe, it, expect, beforeEach } from 'vitest';

describe('MessageCache', () => {
  let MessageCache: typeof import('./messageCache.js').MessageCache;
  let cache: import('./messageCache.js').MessageCache;

  beforeEach(async () => {
    MessageCache = (await import('./messageCache.js')).MessageCache;
    cache = new MessageCache(10000, 5); // 10s TTL, max 5 entries
  });

  it('should store and retrieve a message', () => {
    cache.set(1, 'Hello world');
    expect(cache.get(1)).toBe('Hello world');
  });

  it('should return null for a non-existent key', () => {
    expect(cache.get(999)).toBeNull();
  });

  it('should return null after TTL expiry', async () => {
    const shortCache = new MessageCache(10, 100); // 10ms TTL
    shortCache.set(1, 'expiring');
    await new Promise(r => setTimeout(r, 20));
    expect(shortCache.get(1)).toBeNull();
  });

  it('should evict LRU entries when over capacity', () => {
    for (let i = 0; i < 6; i++) cache.set(i, `msg-${i}`);
    // cache max=5, so at least one entry was evicted
    expect(cache.size).toBeLessThanOrEqual(5);
  });

  it('should store and retrieve reply context', () => {
    const ctx = { answerMarkdown: 'answer', thinkingMarkdown: 'thinking' };
    cache.set(1, 'text', ctx);
    expect(cache.getReplyContext(1)).toEqual(ctx);
  });

  it('should track the last reply context', () => {
    const ctx1 = { answerMarkdown: 'a1', thinkingMarkdown: 't1' };
    const ctx2 = { answerMarkdown: 'a2', thinkingMarkdown: 't2' };
    cache.set(1, 't1', ctx1);
    cache.set(2, 't2', ctx2);
    expect(cache.getLastReplyContext()).toEqual(ctx2);
  });

  it('should expose size and capacity', () => {
    expect(cache.capacity).toBe(5);
    expect(cache.size).toBe(0);
    cache.set(1, 'hi');
    expect(cache.size).toBe(1);
  });

  it('should update existing entry', () => {
    cache.set(1, 'old');
    cache.set(1, 'new');
    expect(cache.get(1)).toBe('new');
  });
});
