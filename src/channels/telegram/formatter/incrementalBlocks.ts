/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file incrementalBlocks.ts
 * @description Stable-prefix incremental markdown→blocks parsing for streaming.
 *
 * Naive streaming re-parses the WHOLE accumulated text every frame — O(n) per
 * frame, O(n²) over a reply. This parser freezes everything up to the last
 * blank-line boundary ("\n\n") once, then each frame only parses the small
 * unfrozen tail: O(n) total.
 *
 * Safety guards:
 *  - The cut only advances when the number of ``` fences before it is EVEN
 *    (no unclosed code fence spans the boundary).
 *  - If the incoming text is not an append of the frozen prefix (edit/rewrite),
 *    the cache resets and falls back to a full parse.
 *
 * Transient edge cases (list continuation across a blank line, reference-style
 * link definitions after first use) may render slightly differently mid-stream;
 * finalize always re-renders canonically via buildFinalBlocks, so glitches
 * self-correct.
 */

import { LRUCache } from 'lru-cache';
import type { RichBlock } from '../richMessage.js';
import { markdownToRichBlocks } from './blocks.js';

interface FrozenState {
  /** Input prefix already parsed into `blocks` (ends exactly at a "\n\n" cut, or ''). */
  prefix: string;
  /** Parsed blocks for `prefix`. */
  blocks: RichBlock[];
}

/** True when text[0..endIdx) contains an even number of ``` fence markers. */
function fenceParityEven(text: string, endIdx: number): boolean {
  let count = 0;
  let i = 0;
  while ((i = text.indexOf('```', i)) !== -1 && i < endIdx) {
    count++;
    i += 3;
  }
  return count % 2 === 0;
}

export class IncrementalRichBlocksParser {
  private frozen: FrozenState = { prefix: '', blocks: [] };

  reset(): void {
    this.frozen = { prefix: '', blocks: [] };
  }

  /**
   * Parse the accumulated streaming `body`, reusing the frozen stable prefix.
   * Returns blocks equivalent (modulo mid-stream boundary effects documented
   * above) to `markdownToRichBlocks(body)`.
   */
  feed(body: string): RichBlock[] {
    if (!body) {
      this.reset();
      return [];
    }
    // Append-only invariant broken → full reparse from scratch.
    if (!body.startsWith(this.frozen.prefix)) {
      this.reset();
    }

    const { prefix, blocks } = this.frozen;

    // Candidate new freeze point: last blank-line boundary beyond the frozen prefix.
    const cut = body.lastIndexOf('\n\n');
    if (cut > prefix.length && fenceParityEven(body, cut)) {
      const segment = body.slice(prefix.length, cut);
      const segmentBlocks = markdownToRichBlocks(segment);
      // Re-freeze atomically: new prefix covers [0, cut), old blocks + segment.
      this.frozen = {
        prefix: body.slice(0, cut),
        blocks: prefix.length === 0 ? segmentBlocks : [...blocks, ...segmentBlocks],
      };
      return [...this.frozen.blocks, ...markdownToRichBlocks(body.slice(cut))];
    }

    // No safe advance: reparse only the unfrozen tail.
    const tail = body.slice(prefix.length);
    return [...blocks, ...markdownToRichBlocks(tail)];
  }
}

const parserCache = new LRUCache<string, IncrementalRichBlocksParser>({
  max: 64,
  ttl: 30 * 60 * 1000,
});

/** Per-stream parser instance keyed by chat/stream id (bounded, auto-expiring). */
export function getIncrementalParser(key: string | number): IncrementalRichBlocksParser {
  const k = String(key);
  let p = parserCache.get(k);
  if (!p) {
    p = new IncrementalRichBlocksParser();
    parserCache.set(k, p);
  }
  return p;
}
