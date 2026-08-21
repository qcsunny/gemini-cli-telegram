/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file incrementalBlocks.test.ts
 * @description Tests for the stable-prefix incremental streaming parser.
 * The core invariant: feeding a growing text frame-by-frame must produce the
 * same blocks as parsing the final text in one shot (for fence-safe content).
 */

import { describe, it, expect } from 'vitest';
import { IncrementalRichBlocksParser, getIncrementalParser } from './incrementalBlocks.js';
import { markdownToRichBlocks } from './blocks.js';

describe('IncrementalRichBlocksParser', () => {
  it('matches whole-text parsing for append-only paragraphs', () => {
    const full = [
      'First paragraph with some text.',
      '',
      'Second paragraph follows here.',
      '',
      'Third paragraph concludes the document.',
    ].join('\n');

    const p = new IncrementalRichBlocksParser();
    let last: ReturnType<IncrementalRichBlocksParser['feed']> = [];
    for (let i = 10; i <= full.length; i += 7) {
      last = p.feed(full.slice(0, i));
    }
    last = p.feed(full);

    expect(last).toEqual(markdownToRichBlocks(full));
  });

  it('matches whole-text parsing for markdown with headings, lists, bold', () => {
    const full = [
      '# Title',
      '',
      'Intro **bold** and *italic* text.',
      '',
      '- item one',
      '- item two',
      '- item three',
      '',
      '## Section',
      '',
      'Closing paragraph.',
    ].join('\n');

    const p = new IncrementalRichBlocksParser();
    let out: ReturnType<IncrementalRichBlocksParser['feed']> = [];
    for (let i = 1; i <= full.length; i++) {
      out = p.feed(full.slice(0, i));
    }
    expect(out).toEqual(markdownToRichBlocks(full));
  });

  it('does not freeze across an unclosed code fence (parity guard)', () => {
    const head = 'Before.\n\n```js\nconst a = 1;\n';
    const tailMore = 'const b = 2;\n```\n\nAfter the fence.';
    const full = head + tailMore;

    const p = new IncrementalRichBlocksParser();
    p.feed(head);
    // While the fence is unclosed, output must still render the fenced code
    // correctly (not split into stray paragraphs).
    const mid = p.feed(head + 'more code');
    const finalOut = p.feed(full);

    expect(finalOut).toEqual(markdownToRichBlocks(full));
    // Mid-stream must contain a code block, not mangled text.
    expect(JSON.stringify(mid)).toContain('code');
  });

  it('resets when input is not an append of the frozen prefix', () => {
    const p = new IncrementalRichBlocksParser();
    p.feed('First version.\n\nSecond paragraph.');
    // Completely different (shorter) text → cache must not corrupt output.
    const out = p.feed('Totally different');
    expect(out).toEqual(markdownToRichBlocks('Totally different'));
  });

  it('handles empty and single-frame inputs', () => {
    const p = new IncrementalRichBlocksParser();
    expect(p.feed('')).toEqual([]);
    expect(p.feed('Just one line.')).toEqual(markdownToRichBlocks('Just one line.'));
  });

  it('getIncrementalParser returns the same instance per key and isolates keys', () => {
    const a1 = getIncrementalParser('chat:1');
    const a2 = getIncrementalParser('chat:1');
    const b = getIncrementalParser('chat:2');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
