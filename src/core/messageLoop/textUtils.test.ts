import { describe, it, expect } from 'vitest';
import { stripWholeMessageCodeFence, normalizeCodeFences } from './textUtils.js';

describe('stripWholeMessageCodeFence', () => {
  it('strips a whole-message fence with a language tag', () => {
    const input = '```markdown\nhello world\n```';
    expect(stripWholeMessageCodeFence(input)).toBe('hello world');
  });

  it('strips a whole-message fence with no language tag', () => {
    const input = '```\nplain body\n```';
    expect(stripWholeMessageCodeFence(input)).toBe('plain body');
  });

  it('keeps the inner body when the model appends a remark after the closing fence', () => {
    const input =
      '```markdown\n这是一个顶尖学者的思考。\n```\n以上就是对这位学者的分析。';
    expect(stripWholeMessageCodeFence(input)).toBe('这是一个顶尖学者的思考。');
  });

  it('does not strip a fence in the middle of text', () => {
    const input = 'Here is:\n```js\ncode\n```\nend';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('does not strip when inner content has nested fences', () => {
    const input = '```\n```json\n{"a":1}\n```\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('does not strip non-markdown language tags (real code block)', () => {
    const input = '```js\nconsole.log(1)\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });
});

describe('normalizeCodeFences', () => {
  it('no-ops on clean text', () => {
    expect(normalizeCodeFences('plain text')).toBe('plain text');
  });
});