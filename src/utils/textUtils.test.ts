/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripThoughtTags, extractSimpleThought } from './textUtils.js';

// Constructed from parts: the literal tag sequence is rewritten by output
// filters, so it must never appear verbatim in source.
const T_WORD = 'think';
const T_OPEN = `<${T_WORD}>`;
const T_CLOSE = `</${T_WORD}>`;

describe('stripThoughtTags', () => {
  it('removes paired <thought> blocks', () => {
    expect(stripThoughtTags('before<thought>inner</thought>after')).toBe('beforeafter');
  });

  it('removes paired think blocks', () => {
    expect(stripThoughtTags(`a${T_OPEN}inner${T_CLOSE}c`)).toBe('ac');
  });

  it('removes paired <thinking> blocks (parity with think/thought)', () => {
    // Previously only the tags were stripped and the inner content leaked
    // into the body; paired blocks are now removed entirely.
    expect(stripThoughtTags('a<thinking>inner</thinking>c')).toBe('ac');
  });

  it('removes orphaned open/close tags of all variants', () => {
    expect(stripThoughtTags(`a</thought>b${T_OPEN}c</thinking>d<e>`)).toBe('abcd<e>');
  });

  it('ignores tag attributes and is case-insensitive', () => {
    expect(stripThoughtTags('<THOUGHT level="1">x</THOUGHT>')).toBe('');
    expect(stripThoughtTags(`<${T_WORD.toUpperCase()} data-a="b">y</${T_WORD.toUpperCase()}>`)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(stripThoughtTags('  <thought>x</thought>  ')).toBe('');
  });

  it('returns empty string for thought-only input', () => {
    expect(stripThoughtTags('<thought>only thinking</thought>')).toBe('');
  });

  it('preserves inner newlines of the remaining content', () => {
    expect(stripThoughtTags('line1\n<thought>t</thought>\nline2')).toBe('line1\n\nline2');
  });
});

describe('extractSimpleThought', () => {
  it('extracts thought and strips it from content', () => {
    const { thought, content } = extractSimpleThought('<thought>plan</thought>answer');
    expect(thought).toBe('plan');
    expect(content).toBe('answer');
  });

  it('prefers <thought> over think when both present', () => {
    const { thought, content } = extractSimpleThought(`<thought>a</thought>${T_OPEN}c${T_CLOSE}rest`);
    expect(thought).toBe('a');
    expect(content).toBe('rest');
  });

  it('returns empty thought and original text when no tags', () => {
    const { thought, content } = extractSimpleThought('plain text');
    expect(thought).toBe('');
    expect(content).toBe('plain text');
  });

  it('trims the extracted thought content', () => {
    const { thought } = extractSimpleThought('<thought>  spaced  </thought>x');
    expect(thought).toBe('spaced');
  });

  it('extracts <thinking> blocks (parity with stripThoughtTags)', () => {
    const { thought, content } = extractSimpleThought('<thinking>deep reasoning</thinking>final answer');
    expect(thought).toBe('deep reasoning');
    expect(content).toBe('final answer');
  });
});