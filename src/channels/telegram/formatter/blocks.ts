/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file blocks.ts
 * @description Rich Text Blocks (Bot API 10.2) conversion and splitting.
 * Entry points (markdownToRichBlocks, buildFinalBlocks, buildFooterBlocksFromHtml,
 * splitRichBlocks) plus post-processing (nesting flattening, footnotes) and
 * payload splitting. Token-level rendering lives in blocksRender.ts.
 */

import type { RichBlock } from '../richMessage.js';
import type { RichText, InputRichBlockListItem } from '@grammyjs/types/rich.js';
import {
  md,
  normalizeMarkdownFences,
  normalizeMarkdownStructure,
  extractStringFromRichText,
  isEligibleMainHeading,
} from './core.js';
import { resetMediaStore } from './media.js';
import type { MarkdownToken } from './core.js';
import { logger } from '../../../utils/logger.js';
import {
  extractMath,
  markdownTokensToRichBlocks,
  trimRichText,
  asRecord,
  setMathPlaceholderStore,
} from './blocksRender.js';

export function markdownToRichBlocks(markdown: string): RichBlock[] {
  if (typeof markdown !== 'string' || !markdown) return [];

  resetMediaStore();
  const { text: placeholderText, math } = extractMath(markdown);
  setMathPlaceholderStore(math);

  let result: RichBlock[];
  try {
    const fenced = normalizeMarkdownFences(placeholderText);
    const tokens = md.parse(normalizeMarkdownStructure(fenced), {}) as unknown as MarkdownToken[];
    const blocks = markdownTokensToRichBlocks(tokens, math);

    result = blocks.length === 0 && markdown.trim()
      ? [{ type: 'paragraph', text: markdown.trim() }]
      : blocks;

    // Post-processing: standalone checkbox conversion
    for (let bi = 0; bi < result.length; bi++) {
      const b = result[bi];
      if (b.type === 'paragraph') {
        const rawText = extractStringFromRichText(b.text).trim();
        const cbMatch = rawText.match(/^\[([ xX])\]\s*/);
        if (cbMatch) {
          const prefixLen = cbMatch[0].length;
          let strippedText: RichText = b.text;
          if (typeof strippedText === 'string') {
            strippedText = strippedText.slice(prefixLen);
          } else if (Array.isArray(strippedText)) {
            strippedText = strippedText.map((item, idx) => {
              if (idx === 0 && typeof item === 'string' && item.startsWith(cbMatch[0])) {
                return item.slice(prefixLen);
              }
              return item;
            });
            if (strippedText.length === 1 && typeof strippedText[0] === 'string') {
              strippedText = strippedText[0];
            }
          }
          result[bi] = {
            type: 'list',
            is_ordered: false,
            items: [{
              has_checkbox: true,
              is_checked: cbMatch[1] !== ' ' ? true : undefined,
              blocks: [{ type: 'paragraph', text: trimRichText(strippedText) }],
            }],
          } as RichBlock;
        }
      }
    }

    // Filter out empty blocks, flatten deep nesting
    result = result.filter(b => isMeaningfulBlock(b, 0)).map(b => flattenDepth(b, 0));
  } finally {
    setMathPlaceholderStore([]);
    resetMediaStore();
  }
  return result;
}

const MAX_DEPTH = 16;

function isMeaningfulBlock(blk: RichBlock, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const b = asRecord(blk);
  if (!b) return false;
  const type = b['type'] as string;
  if (type === 'paragraph' || type === 'heading') {
    const text = b['text'];
    if (!text) return false;
    if (typeof text === 'string' && !text.trim()) return false;
    if (Array.isArray(text) && text.length === 0) return false;
    return true;
  }
  if (type === 'pre') {
    const text = b['text'];
    return typeof text === 'string' && text.length > 0;
  }
  if (type === 'footer') {
    const text = b['text'];
    return typeof text === 'string' && text.length > 0;
  }
  if (type === 'details') {
    // A details block is meaningful even when its only child is the empty
    // ' ' paragraph placeholder (content was folded into the summary line).
    // Only drop it when the *summary* itself is empty/unusable.
    const summary = (b['summary'] as string | undefined) ?? '';
    return typeof summary === 'string' && summary.trim().length > 0;
  }
  if (type === 'blockquote') {
    const innerBlocks = (b['blocks'] as RichBlock[]) ?? [];
    const filtered = innerBlocks.filter(child => isMeaningfulBlock(child, depth + 1));
    if (filtered.length === 0) return false;
    (b['blocks'] as RichBlock[]) = filtered;
    return true;
  }
  if (type === 'list') {
    const items = (b['items'] as InputRichBlockListItem<never>[]) ?? [];
    if (items.length === 0) return false;
    for (const item of items) {
      item.blocks = item.blocks.filter(child => isMeaningfulBlock(child, depth + 1));
    }
    return items.some(item => item.blocks.length > 0);
  }
  if (type === 'slideshow' || type === 'collage') {
    const innerBlocks = (b['blocks'] as RichBlock[]) ?? [];
    const filtered = innerBlocks.filter(child => isMeaningfulBlock(child, depth + 1));
    if (filtered.length === 0) return false;
    (b['blocks'] as RichBlock[]) = filtered;
    return true;
  }
  if (type === 'photo' || type === 'video' || type === 'animation' || type === 'audio' || type === 'voice_note') {
    const media = asRecord(b['photo'] ?? b['video'] ?? b['animation'] ?? b['audio'] ?? b['voice_note']);
    return !!(media && typeof media['media'] === 'string' && media['media'].trim());
  }
  if (type === 'map') {
    const loc = asRecord(b['location']);
    return !!(loc && typeof b['zoom'] === 'number');
  }
  return !!(type === 'anchor' || type === 'divider' || type === 'mathematical_expression' || type === 'table' || type === 'thinking' || type === 'pullquote');
}

function flattenDepth(blk: RichBlock, depth: number): RichBlock {
  if (depth < MAX_DEPTH) return blk;
  if (blk.type === 'list') {
    for (const item of blk.items) {
      item.blocks = item.blocks.flatMap(child => {
        if (child.type === 'list') {
          return child.items.flatMap(nestedItem => nestedItem.blocks);
        }
        return [flattenDepth(child, depth + 1)];
      });
    }
  }
  if (blk.type === 'blockquote' || blk.type === 'details') {
    blk.blocks = blk.blocks.flatMap(child => {
      if (child.type === 'blockquote') return child.blocks;
      return [flattenDepth(child, depth + 1)];
    });
  }
  if (blk.type === 'slideshow' || blk.type === 'collage') {
    blk.blocks = blk.blocks.flatMap(child => {
      if (child.type === 'slideshow' || child.type === 'collage') return child.blocks;
      return [flattenDepth(child, depth + 1)];
    });
  }
  return blk;
}

/**
 * Extract footnote definitions from model output and rewrite [^id] markers
 * as Telegram native reference_link anchors.
 *
 * Handles standard markdown footnote syntax:
 *   Text with a citation[^1] and more[^2].
 *
 *   [^1]: First source
 *   [^2]: Second source with details
 */
function preprocessFootnotes(markdown: string): { body: string; defs: Array<{ id: string; text: string }> } {
  const defRe = /^\[\^(\w+)\]:\s*(.+)$/gm;
  const defMatches = [...markdown.matchAll(defRe)];
  if (defMatches.length === 0) return { body: markdown, defs: [] };

  const firstDefIndex = defMatches[0].index!;
  const bodyText = markdown.slice(0, firstDefIndex).trimEnd();

  // Collect unique footnote IDs in order of first appearance in the body.
  const idOrder: string[] = [];
  const bodyRefRe = /\[\^(\w+)\]/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = bodyRefRe.exec(bodyText)) !== null) {
    const id = refMatch[1];
    if (!idOrder.includes(id)) idOrder.push(id);
  }

  // Assign sequential numbers based on appearance order.
  const idToNum = new Map<string, string>();
  idOrder.forEach((id, i) => idToNum.set(id, String(i + 1)));

  // Only include definitions that are actually cited.
  const defs: Array<{ id: string; text: string }> = [];
  const defTextMap = new Map<string, string>();
  for (const m of defMatches) {
    defTextMap.set(m[1], m[2].trim());
  }
  for (const id of idOrder) {
    const text = defTextMap.get(id);
    if (text) defs.push({ id: idToNum.get(id)!, text });
  }

  // Replace [^id] in body with sequential numbers.
  // A separate empty reference[name:"body-N"] marks the citation position
  // for backward navigation, without wrapping the forward link.
  // This avoids client confusion when reference wraps reference_link.
  let body = bodyText;
  for (const [origId, num] of idToNum) {
    body = body.replace(
      new RegExp(`\\[\\^${origId}\\]`, 'g'),
      `<tg-reference name="body-${num}"></tg-reference><a href="#fn-${num}"><sup>[${num}]</sup></a>`,
    );
  }

  return { body, defs };
}

/**
 * Format a structured message with optional thought into Telegram RichBlocks.
 * The returned blocks array is suitable for `sendRichMessage` / `editMessageText`
 * (final, persisted messages). For streaming drafts the channel layer builds
 * lightweight blocks directly.
 */
export function buildFinalBlocks(
  content: string,
  thought?: string,
  opts?: { time?: string; tokens?: string; isClosed?: boolean; footerText?: string; bodySummary?: string },
): RichBlock[] {
  const blocks: RichBlock[] = [];

  // Inline final messages place thinking after the Answer label and can fold
  // the answer body into a separate details block.
  const answerMarker = /\n\n(?=\*\*🤖 Answer(?: \([^\n]*\))?:\*\*)/;
  const answerParts = content.split(answerMarker, 2);
  if (answerParts.length === 2 && (thought?.trim() || opts?.bodySummary)) {
    const question = markdownToRichBlocks(answerParts[0]);
    const answer = answerParts[1];
    const answerHeader = answer.match(/^(\*\*🤖 Answer(?: \([^\n]*\))?:\*\*)\n\n?([\s\S]*)$/);
    if (answerHeader) {
      blocks.push(...question, ...markdownToRichBlocks(answerHeader[1]));
      const thoughtText = (thought ?? '').trim();
      if (thoughtText) {
        let summary = '🧠 Thinking Process';
        const infoLines: string[] = [];
        if (opts?.time && Number(opts.time) > 0) infoLines.push(`Thinking Time: ${opts.time} s`);
        if (opts?.tokens && Number(opts.tokens) > 0) infoLines.push(`Thinking Tokens: ${opts.tokens}`);
        if (infoLines.length > 0) summary = `${summary} · ${infoLines.join(' · ')}`;
        const thoughtBlocks = markdownToRichBlocks(thoughtText);
        blocks.push({
          type: 'details',
          summary,
          blocks: thoughtBlocks.length > 0 ? thoughtBlocks : [{ type: 'paragraph', text: thoughtText }],
        });
      }
      const answerBody = markdownToRichBlocks(answerHeader[2]);
      if (opts?.bodySummary) {
        blocks.push({
          type: 'details',
          summary: opts.bodySummary,
          blocks: answerBody.length > 0 ? answerBody : [{ type: 'paragraph', text: answerHeader[2] }],
        });
      } else {
        blocks.push(...answerBody);
      }
      if (opts?.footerText) blocks.push({ type: 'footer', text: opts.footerText });
      return blocks;
    }
  }

  // Pre-process footnote references before markdown parsing
  const { body: footnoteBody, defs: footnoteDefs } = preprocessFootnotes(content);
  const body = markdownToRichBlocks(footnoteBody);

  // Extract first heading to hoist above thinking block ONLY if it is a genuine overall title
  let mainHeading: RichBlock | undefined;
  if (body.length > 0 && isEligibleMainHeading(body[0])) {
    mainHeading = body.shift() as RichBlock;
  }

  // 1. Main Heading FIRST (only when there is also a thought to show beneath it)
  const thoughtText = (thought ?? '').trim();
  if (mainHeading && thoughtText) {
    // Hoist heading above thinking block only when thinking block is present
    blocks.push(mainHeading);
  }

  // 2. Thinking block
  if (thoughtText) {
    let summary = '🧠 Thinking Process';
    const infoLines: string[] = [];
    if (opts?.time && Number(opts.time) > 0) infoLines.push(`Thinking Time: ${opts.time} s`);
    if (opts?.tokens && Number(opts.tokens) > 0) infoLines.push(`Thinking Tokens: ${opts.tokens}`);
    if (infoLines.length > 0) summary = `${summary} · ${infoLines.join(' · ')}`;

    const thoughtBlocks = markdownToRichBlocks(thoughtText);
    blocks.push({
      type: 'details',
      summary,
      blocks: thoughtBlocks.length > 0 ? thoughtBlocks : [{ type: 'paragraph', text: thoughtText }],
    });
  }

  // 3. Body blocks: if heading was NOT hoisted (no thought), put it back at the front
  if (mainHeading && !thoughtText) {
    blocks.push(mainHeading);
  }
  blocks.push(...body);

  // 4. Footnotes block: separate paragraph with weakened styling (italic + subscript)
  // before the tokens cost footer, so reading order is: body → references → cost.
  // Each footnote has a forward anchor (fn-N) and a back-link (↩) to the body anchor (body-N).
  if (footnoteDefs.length > 0) {
    const fnTexts: RichText[] = [];
    for (const def of footnoteDefs) {
      if (fnTexts.length > 0) fnTexts.push('\n');
      fnTexts.push(
        { type: 'reference', name: `fn-${def.id}`, text: { type: 'subscript', text: { type: 'italic', text: `[${def.id}] ${def.text}` } } },
        ' ',
        { type: 'reference_link', text: '↩', reference_name: `body-${def.id}` },
      );
    }
    blocks.push({ type: 'paragraph', text: fnTexts.length === 1 ? fnTexts[0] : fnTexts });
  }

  // 5. Footer block LAST: token counts & pricing only
  if (opts?.footerText) {
    blocks.push({ type: 'footer', text: opts.footerText });
  }

  return blocks;
}

/**
 * Build the native 10.2 footer blocks for a finalized message.
 *
 * Two native blocks are produced (in order):
 *  - `InputRichBlockDetails`: a collapsible "🧠 Thinking Process" block holding the
 *    thinking text (rendered natively by Telegram, not hand-rolled <details>).
 *  - `InputRichBlockFooter`: the official info-footer line
 *    ("⚙️ model · In: … · Out: … · Cost: …") — the blocks-mode equivalent of the
 *    `tg://btn_info_footer` HTML anchor used previously.
 *
 * The footer is sent as its own message (after the body), as a single blocks
 * payload, so the collapsible block is never split.
 */
/**
 * Parse a footer rendered as HTML (`___RAW_HTML___` payload) into native 10.2
 * blocks, so the footer benefits from the structured blocks path instead of
 * falling back to HTML. Expected HTML shape (produced by markdownToHtml for a
 * `[footer: …]` marker + thought):
 *   <details>…<summary>🧠 Thinking Process …</summary>…thinking…</details>
 *   <a href="tg://btn_info_footer|MODEL|IN|OUT|COST[|CACHED|THINKING]">⚙️ …</a>
 */
export function buildFooterBlocksFromHtml(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];

  // 1. Thinking <details> block.
  const detailsMatch = html.match(/<details[^>]*>([\s\S]*?)<\/details>/i);
  if (detailsMatch) {
    let inner = detailsMatch[1];
    const rawInnerLen = inner.length;
    inner = inner.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
    inner = inner.replace(/<i>[\s\S]*?<\/i>/gi, '');
    logger.info(`[blocks] Parsed <details> block: rawInnerLen=${rawInnerLen} cleanedInnerLen=${inner.length}`);
    
    // Convert HTML tags to markdown syntax so markdownToRichBlocks produces RichTextBold/RichTextItalic etc.
    let md = inner
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (md) {
      const thoughtBlocks = markdownToRichBlocks(md);
      blocks.push({
        type: 'details',
        summary: '🧠 Thinking Process',
        blocks: thoughtBlocks.length > 0 ? thoughtBlocks : [{ type: 'paragraph', text: md }],
      });
    }
  }

  // 2. Native info footer (tg://btn_info_footer|MODEL|IN|OUT|COST|CACHED|THINKING).
  const footerMatch = html.match(/tg:\/\/btn_info_footer\|([^"'>]+)/i);
  if (footerMatch) {
    const [model, input, output, cost, cached, thinking] = footerMatch[1].split('|');
    const parts: string[] = [];
    if (model) parts.push(model);
    if (input || output) {
      let s = `In: ${input ?? ''}`;
      if (cached && cached !== '0') s += ` (Cached: ${cached})`;
      s += ` · Out: ${output ?? ''}`;
      if (thinking && thinking !== '0') s += ` (Reasoning: ${thinking})`;
      parts.push(s);
    }
    if (cost) parts.push(`Cost: ${cost}`);
    if (parts.length > 0) {
      blocks.push({ type: 'footer', text: `⚙️ ${parts.join(' · ')}` });
    }
  }

  return blocks;
}

// ── RichBlock payload splitter (AST-level, no regex on structure) ──────────────

function richTextLength(rt: unknown): number {
  if (!rt) return 0;
  if (typeof rt === 'string') return rt.length;
  if (Array.isArray(rt)) {
    return rt.reduce((sum, item) => sum + richTextLength(item), 0);
  }
  if (typeof rt === 'object' && 'text' in rt) {
    return richTextLength(rt.text);
  }
  return 0;
}

function getBlockLength(block: RichBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'thinking':
    case 'pullquote':
      return richTextLength(block.text);
    case 'pre':
    case 'footer':
      return richTextLength(block.text);
    case 'blockquote':
    case 'slideshow':
    case 'collage':
      return block.blocks.reduce((sum, child) => sum + getBlockLength(child), 0);
    case 'details':
      return richTextLength(block.summary) + block.blocks
        .reduce((sum, child) => sum + getBlockLength(child), 0);
    case 'list':
      return block.items.reduce((sum, item) =>
        sum + item.blocks.reduce((itemSum, child) => itemSum + getBlockLength(child), 0), 0);
    case 'table':
      return block.cells.reduce((sum, row) =>
        sum + row.reduce((rowSum, cell) => rowSum + richTextLength(cell.text), 0), 0);
    case 'photo':
    case 'video':
    case 'animation':
    case 'audio':
    case 'voice_note':
    case 'map':
    case 'divider':
    case 'anchor':
    case 'mathematical_expression':
      return 1;
  }
}

function splitRichTextByLength(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = remaining.indexOf(' ', maxLen);
    if (cut <= 0 || cut >= maxLen) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Split an InputRichBlock[] payload into chunks that each fit within maxChars.
 *
 * Operates entirely at the AST node level — never converts blocks to/from strings.
 *
 * Rules:
 *  1. Top-level blocks are the atomic unit. When the next block would overflow
 *     the current part, a new part is started at the block boundary.
 *  2. `type: 'details'` containers whose inner `blocks` array exceeds maxChars
 *     are split into multiple details nodes each holding a subset of the inner blocks.
 *  3. As a last resort, a single `paragraph` whose text exceeds maxChars is
 *     split into smaller paragraph nodes at word boundaries.
 *  4. A single `pre` block whose text exceeds maxChars is split at line
 *     boundaries (hard-splitting any individual over-long line).
 */
export function splitRichBlocks(
  blocks: RichBlock[],
  maxChars = 3800,
): RichBlock[][] {
  const parts: RichBlock[][] = [[]];
  let currentLen = 0;

  const finishPart = () => {
    if (parts[parts.length - 1].length > 0) {
      parts.push([]);
    }
    currentLen = 0;
  };

  for (const block of blocks) {
    const blockLen = getBlockLength(block);

    // Rule 2: details node with oversized inner blocks
    if (block.type === 'details' && blockLen > maxChars) {
      const inner = block.blocks;
      const summary = block.summary;

      // Partition inner blocks into multiple groups, each within maxChars
      const groups: RichBlock[][] = [[]];
      let gIdx = 0;
      let gLen = 0;
      for (const ib of inner) {
        const ibLen = getBlockLength(ib);
        if (gLen + ibLen > maxChars && groups[gIdx].length > 0) {
          groups.push([]);
          gIdx++;
          gLen = 0;
        }
        groups[gIdx].push(ib);
        gLen += ibLen;
      }

      const detailsBlocks: RichBlock[] = groups
        .filter((g): g is RichBlock[] => g.length > 0)
        .map((g, idx, arr): RichBlock => ({
          type: 'details',
          blocks: g,
          summary: arr.length > 1
            ? `🧠 Thinking Process (${idx + 1}/${arr.length})`
            : summary,
        }));

      // Distribute resulting details blocks across parts
      for (const db of detailsBlocks) {
        const dbLen = getBlockLength(db);
        if (currentLen + dbLen > maxChars) finishPart();
        parts[parts.length - 1].push(db);
        currentLen += dbLen;
      }
      continue;
    }

    // Rule 3: single paragraph that alone exceeds maxChars
    if (block.type === 'paragraph' && blockLen > maxChars) {
      const raw = extractStringFromRichText(block.text);
      const chunks = splitRichTextByLength(raw, maxChars);
      for (const chunk of chunks) {
        if (currentLen + chunk.length > maxChars) finishPart();
        parts[parts.length - 1].push({ type: 'paragraph', text: chunk } as RichBlock);
        currentLen += chunk.length;
      }
      continue;
    }

    // Rule 4: single pre block that alone exceeds maxChars — split by lines
    if (block.type === 'pre' && blockLen > maxChars) {
      const lines = extractStringFromRichText(block.text).split('\n');
      const lang = block.language;
      let currentLines: string[] = [];
      let currentPreLen = 0;
      for (const line of lines) {
        const lineLen = line.length + 1;
        // A single line longer than maxChars (e.g. base64 blobs, long URLs)
        // cannot be kept whole — hard-split it so the part stays under the
        // server cap instead of producing an oversized part.
        if (lineLen > maxChars && currentLines.length === 0) {
          const rawChunks = splitRichTextByLength(line, maxChars);
          for (const chunk of rawChunks) {
            if (currentLen + chunk.length + 1 > maxChars && currentLen > 0) finishPart();
            parts[parts.length - 1].push({ type: 'pre', text: chunk, language: lang } as RichBlock);
            currentLen += chunk.length + 1;
          }
          continue;
        }
        if (currentPreLen + lineLen > maxChars && currentLines.length > 0) {
          if (currentLen > 0) finishPart();
          parts[parts.length - 1].push({ type: 'pre', text: currentLines.join('\n'), language: lang } as RichBlock);
          currentLen = currentPreLen;
          currentLines = [];
          currentPreLen = 0;
        }
        currentLines.push(line);
        currentPreLen += lineLen;
      }
      if (currentLines.length > 0) {
        if (currentLen > 0 && currentPreLen > maxChars) finishPart();
        parts[parts.length - 1].push({ type: 'pre', text: currentLines.join('\n'), language: lang } as RichBlock);
        currentLen += currentPreLen;
      }
      continue;
    }

    // Rule 1: normal block — start new part if it doesn't fit
    if (currentLen + blockLen > maxChars) finishPart();

    parts[parts.length - 1].push(block);
    currentLen += blockLen;
  }

  return parts.filter(p => p.length > 0);
}
