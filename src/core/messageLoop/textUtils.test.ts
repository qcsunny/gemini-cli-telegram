import { describe, it, expect } from 'vitest';
import {
  stripWholeMessageCodeFence,
  normalizeCodeFences,
  stripSearchResultPayloads,
} from './textUtils.js';

describe('stripWholeMessageCodeFence', () => {
  it('should strip markdown fence when whole message is fenced', () => {
    const result = stripWholeMessageCodeFence('```markdown\nHello **world**\n```');
    expect(result).toBe('Hello **world**');
  });

  it('should strip md fence', () => {
    const result = stripWholeMessageCodeFence('```md\n# Title\n```');
    expect(result).toBe('# Title');
  });

  it('should not strip non-markdown fence', () => {
    const input = '```python\nprint("hello")\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('should not strip when fence lang is absent and content contains nested fences', () => {
    const input = '```\n```nested```\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('should return text unchanged when not fenced', () => {
    const input = 'Just plain text';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('should strip lang-less fence with no nested fences', () => {
    const result = stripWholeMessageCodeFence('```\nplain text\n```');
    expect(result).toBe('plain text');
  });
});

describe('normalizeCodeFences', () => {
  it('should add newline before fence when inline', () => {
    const result = normalizeCodeFences('text```js\ncode\n```');
    expect(result).toBe('text\n```js\ncode\n```');
  });

  it('should not modify already-normalized fences', () => {
    const input = 'text\n```js\ncode\n```';
    expect(normalizeCodeFences(input)).toBe(input);
  });

  it('should handle multiple fences', () => {
    const input = 'a```js\n1\n```\nb```ts\n2\n```';
    const result = normalizeCodeFences(input);
    expect(result).toBe('a\n```js\n1\n```\nb\n```ts\n2\n```');
  });
});

describe('stripSearchResultPayloads', () => {
  it('should remove JSON with open_url key', () => {
    const input = 'Some text\n```json\n{"open_url": "https://x.com"}\n```\nmore text';
    expect(stripSearchResultPayloads(input)).toBe('Some text\n\nmore text');
  });

  it('should remove heading/subheading objects', () => {
    const input = 'text\n{"heading": "foo", "subheading": "bar"}\nend';
    expect(stripSearchResultPayloads(input)).toBe('text\n\nend');
  });

  it('should remove actions block with open_url', () => {
    const input = 'text\n{"actions": {"open_url": "..."}}\nend';
    expect(stripSearchResultPayloads(input)).toBe('text\n\nend');
  });

  it('should return unchanged text when no payloads', () => {
    const input = 'Just regular text here';
    expect(stripSearchResultPayloads(input)).toBe(input);
  });
});
