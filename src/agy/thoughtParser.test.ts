import { describe, it, expect } from 'vitest';
import { normalizeThinkingTags, extractThoughtAndContent } from './thoughtParser.js';

describe('normalizeThinkingTags', () => {
  it('should convert <thinking> to <think>', () => {
    expect(normalizeThinkingTags('<thinking>hello</thinking>')).toBe('<think>hello</think>');
  });

  it('should convert <thought> to <think>', () => {
    expect(normalizeThinkingTags('<thought>hello</thought>')).toBe('<think>hello</think>');
  });

  it('should convert <thought-gemini> to <think>', () => {
    const result = normalizeThinkingTags('<thought-gemini>hello</thought-gemini>');
    expect(result).toBe('<think>hello</think>');
  });

  it('should preserve <think> tags unchanged', () => {
    expect(normalizeThinkingTags('<think>hello</think>')).toBe('<think>hello</think>');
  });

  it('should convert [thought:content] syntax', () => {
    expect(normalizeThinkingTags('[thought:hello]')).toBe('<think>hello</think>');
  });

  it('should preserve attributes from <thought-gemini>', () => {
    const result = normalizeThinkingTags('<thought-gemini time="1.5s" tokens="100">text</thought-gemini>');
    expect(result).toBe('<think time="1.5s" tokens="100">text</think>');
  });

  it('should preserve time attribute from <thought>', () => {
    const result = normalizeThinkingTags('<thought time="2.3s">text</thought>');
    expect(result).toBe('<think time="2.3s">text</think>');
  });

  it('should skip content inside code fences', () => {
    const input = 'text\n```\n<thinking>inside fence</thinking>\n```\nend';
    const result = normalizeThinkingTags(input);
    expect(result).toContain('<thinking>inside fence</thinking>');
    expect(result).not.toContain('<think>');
  });

  it('should skip content inside inline code', () => {
    const input = 'text `<thinking>inline</thinking>` end';
    const result = normalizeThinkingTags(input);
    expect(result).toContain('<thinking>inline</thinking>');
  });

  it('should handle multiple thought blocks', () => {
    const input = 'a<thinking>one</thinking>b<thought>two</thought>c';
    const result = normalizeThinkingTags(input);
    expect(result).toBe('a<think>one</think>b<think>two</think>c');
  });

  it('should handle [thought: without closing bracket', () => {
    const input = '[thought:unclosed';
    expect(normalizeThinkingTags(input)).toBe('<think>unclosed');
  });
});

describe('extractThoughtAndContent', () => {
  it('should separate thought and content', () => {
    const input = 'Before<think>inner thought</think>After';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('inner thought');
    expect(result.content).toBe('BeforeAfter');
  });

  it('should return empty thought when no tags', () => {
    const result = extractThoughtAndContent('Just content');
    expect(result.thought).toBe('');
    expect(result.content).toBe('Just content');
  });

  it('should handle <though> variants', () => {
    const input = 'pre<thought-gemini>gemini thought</thought-gemini>post';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('gemini thought');
    expect(result.content).toBe('prepost');
  });

  it('should handle multiple thought blocks', () => {
    const input = '<think>first</think>middle<think>second</think>end';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('first\n\nsecond');
    expect(result.content).toBe('middleend');
  });

  it('should extract geminiTime from <thought-gemini>', () => {
    const input = '<thought-gemini time="3.2s">thought</thought-gemini>content';
    const result = extractThoughtAndContent(input);
    expect(result.geminiTime).toBe('3.2s');
  });

  it('should extract geminiTokens from <thought-gemini>', () => {
    const input = '<thought-gemini tokens="150">thought</thought-gemini>content';
    const result = extractThoughtAndContent(input);
    expect(result.geminiTokens).toBe('150');
  });

  it('should extract both time and tokens', () => {
    const input = '<thought-gemini time="1.0s" tokens="50">thought</thought-gemini>content';
    const result = extractThoughtAndContent(input);
    expect(result.geminiTime).toBe('1.0s');
    expect(result.geminiTokens).toBe('50');
  });

  it('should handle unclosed think tags', () => {
    const input = '<think>unclosed';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('unclosed');
  });

  it('should handle [thought:bracket] syntax', () => {
    const input = 'pre[thought:bracket thought]post';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('bracket thought');
    expect(result.content).toBe('prepost');
  });

  it('should not extract thought from inside code fences', () => {
    const input = 'text\n```\n<think>hidden</think>\n```\nend';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toBe('');
  });

  it('should handle real-world mixed content', () => {
    const input = 'Hello\n\n<think>Let me analyze this step by step.\nFirst, consider the requirements.\nSecond, implement the solution.</think>\n\nHere is the final answer.';
    const result = extractThoughtAndContent(input);
    expect(result.thought).toContain('Let me analyze');
    expect(result.thought).toContain('implement the solution');
    expect(result.content).not.toContain('Let me analyze');
    expect(result.content).toContain('final answer');
  });
});
