// @vitest-environment node
/**
 * @file channelReply.test.ts
 * @description Unit tests for the streaming draft renderer (getStreamingMarkdown),
 * which controls the typewriter UX during model replies:
 *  - Phase 1: thinking text streams verbatim under a "🧠 Thinking..." header
 *  - Phase 2: when body content arrives, thinking folds into a collapsed
 *    <details> block ("🧠 Thinking Process") and the body streams below
 *  - Body-only / empty replies still fall back to the body or placeholder
 */
import { describe, it, expect } from 'vitest';
import { getStreamingMarkdown } from './channelReply.js';

describe('getStreamingMarkdown', () => {
  it('streams the actual thinking text typewriter-style while only thinking (Phase 1)', () => {
    const md = getStreamingMarkdown({ content: '', thought: 'let me think\nstep two' });
    expect(md).toContain('**🧠 Thinking...**');
    expect(md).toContain('let me think\nstep two');
    expect(md).not.toContain('<details>');
  });

  it('folds the thinking into a collapsed details block and streams the body (Phase 2)', () => {
    const md = getStreamingMarkdown({ content: 'the answer', thought: 'reasoning here' });
    expect(md).toContain('<details><summary>🧠 Thinking Process</summary>');
    expect(md).toContain('reasoning here');
    expect(md).toContain('</details>');
    expect(md).toMatch(/the answer$/u);
  });

  it('strips literal thought tags from both thought and body', () => {
    const md = getStreamingMarkdown({ content: 'body <thinking>x</thinking>', thought: '<thought>t</thought>\nreal' });
    expect(md).not.toContain('<thinking>');
    expect(md).not.toContain('<thought>');
    expect(md).toContain('real');
    expect(md).toContain('body x');
  });

  it('returns the body as-is when there is no thought', () => {
    expect(getStreamingMarkdown({ content: 'plain answer', thought: '' })).toBe('plain answer');
  });

  it('returns a placeholder when both are empty', () => {
    expect(getStreamingMarkdown({ content: '', thought: '' })).toBe('🧠 Thinking...');
  });

  it('handles plain-string input', () => {
    expect(getStreamingMarkdown('hello')).toBe('hello');
  });
});
