/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file thoughtParser.test.ts
 * @description Tests for thinking-tag normalization and thought/content separation.
 * These decide what the user actually sees as "thinking" vs the answer body,
 * including the streaming-critical rule for unclosed <think> blocks.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeThinkingTags,
  extractThoughtBlocksAndSegments,
  extractThoughtAndContent,
} from './thoughtParser.js';

describe('normalizeThinkingTags', () => {
  it('converts <thought>/<thinking> variants to canonical <think>', () => {
    expect(normalizeThinkingTags('<thought>a</thought>')).toBe('<think>a</think>');
    expect(normalizeThinkingTags('<thinking>b</thinking>')).toBe('<think>b</think>');
    expect(normalizeThinkingTags('<THINKING>c</THINKING>')).toBe('<think>c</think>');
  });

  it('converts [thought:...] bracket form to an open+close pair', () => {
    expect(normalizeThinkingTags('[thought:reasoning here]')).toBe('<think>reasoning here</think>');
    // Unclosed bracket swallows the rest as thought content.
    expect(normalizeThinkingTags('[thought:no close')).toBe('<think>no close');
  });

  it('preserves time/tokens attributes on <thought> opening tags', () => {
    const out = normalizeThinkingTags('<thought time="1.2s" tokens="42">x</thought>');
    expect(out).toBe('<think time="1.2s" tokens="42">x</think>');
  });

  it('strips unknown attributes from <thought> but keeps known ones', () => {
    const out = normalizeThinkingTags('<thought foo="bar" tokens="7">x</thought>');
    expect(out).toBe('<think tokens="7">x</think>');
  });

  it('leaves tag-like text inside code fences untouched', () => {
    const text = '```\n<thought>not a tag</thought>\n```';
    expect(normalizeThinkingTags(text)).toBe(text);
  });

  it('leaves tag-like text inside inline code untouched', () => {
    expect(normalizeThinkingTags('use `<thought>` tag')).toBe('use `<thought>` tag');
  });

  it('resets inline-code tracking at newlines', () => {
    // The backtick opens inline code, but the newline closes it, so the
    // <thought> on the next line must still be normalized.
    expect(normalizeThinkingTags('`x\n<thought>y</thought>')).toBe('`x\n<think>y</think>');
  });

  it('does not treat <thought-foo> as a <thought> tag', () => {
    expect(normalizeThinkingTags('<thought-foo>x')).toBe('<thought-foo>x');
  });
});

describe('extractThoughtBlocksAndSegments', () => {
  it('separates a closed think block from surrounding content', () => {
    const res = extractThoughtBlocksAndSegments('<think>hmm</think>Answer');
    expect(res.thought).toBe('hmm');
    expect(res.content).toBe('Answer');
    expect(res.segments.map(s => s.type)).toEqual(['thought', 'text']);
  });

  it('keeps text before and after the block in order', () => {
    const res = extractThoughtBlocksAndSegments('Intro <think>t</think> Outro');
    expect(res.content).toBe('Intro  Outro');
    expect(res.segments.map(s => s.type)).toEqual(['text', 'thought', 'text']);
  });

  it('joins multiple thought blocks with a blank line', () => {
    const res = extractThoughtBlocksAndSegments('<think>one</think><think>two</think>done');
    expect(res.thought).toBe('one\n\ntwo');
    expect(res.content).toBe('done');
  });

  it('treats an unclosed leading <think> as streaming thought', () => {
    // Mid-stream: model opened thinking but has not closed it yet.
    const res = extractThoughtBlocksAndSegments('<think>still thinking...');
    expect(res.thought).toBe('still thinking...');
    expect(res.content).toBe('');
  });

  it('REGRESSION: ignores a stray unclosed <think> after real content appeared', () => {
    // Once non-whitespace answer text exists, a later unclosed <think> is
    // literal content, not thought — otherwise streaming answers would vanish.
    const res = extractThoughtBlocksAndSegments('The answer is 42 <think>oops');
    expect(res.content).toBe('The answer is 42 <think>oops');
    expect(res.thought).toBe('');
  });

  it('ignores think-like text inside code fences', () => {
    const res = extractThoughtBlocksAndSegments('```\n<think>code</think>\n```');
    expect(res.thought).toBe('');
    expect(res.content).toBe('```\n<think>code</think>\n```');
  });

  it('normalizes all variants before parsing', () => {
    const res = extractThoughtBlocksAndSegments(
      '<thinking>a</thinking>[thought:b]<thought>c</thought>'
    );
    expect(res.thought).toBe('a\n\nb\n\nc');
    expect(res.content).toBe('');
  });

  it('returns empty results for empty input', () => {
    const res = extractThoughtBlocksAndSegments('');
    expect(res.thought).toBe('');
    expect(res.content).toBe('');
    expect(res.segments).toEqual([]);
  });
});

describe('extractThoughtAndContent', () => {
  it('extracts geminiTime and geminiTokens from think attributes', () => {
    const res = extractThoughtAndContent(
      '<think time="3.4s" tokens="128">deep thought</think>Result'
    );
    expect(res.geminiTime).toBe('3.4s');
    expect(res.geminiTokens).toBe('128');
    expect(res.thought).toBe('deep thought');
    expect(res.content).toBe('Result');
  });

  it('takes metadata only from the first attributed block', () => {
    const res = extractThoughtAndContent(
      '<think time="1s" tokens="10">a</think><think time="9s" tokens="99">b</think>'
    );
    expect(res.geminiTime).toBe('1s');
    expect(res.geminiTokens).toBe('10');
  });

  it('returns undefined metadata when absent', () => {
    const res = extractThoughtAndContent('<think>x</think>y');
    expect(res.geminiTime).toBeUndefined();
    expect(res.geminiTokens).toBeUndefined();
  });
});
