/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file blocks.ts
 * @description Rich Text Blocks (Bot API 10.2) conversion and splitting.
 * Converts markdown to native RichBlock structures, handles math placeholder
 * extraction, and splits oversized block payloads.
 */

import type { RichBlock } from '../richMessage.js';
import type { RichText, InputRichBlockListItem } from '@grammyjs/types/rich.js';
import {
  md,
  getAttr,
  normalizeMarkdownFences,
  normalizeMarkdownStructure,
  extractStringFromRichText,
  isEligibleMainHeading,
} from './core.js';
import { mediaStore, nextMediaId, resetMediaStore } from './media.js';
import type { MarkdownToken } from './core.js';

// ── Rich Text Blocks (Bot API 10.2) ──

type RichTextEntity =
  | { type: 'bold'; text: RichText }
  | { type: 'italic'; text: RichText }
  | { type: 'underline'; text: RichText }
  | { type: 'strikethrough'; text: RichText }
  | { type: 'spoiler'; text: RichText }
  | { type: 'marked'; text: RichText }
  | { type: 'subscript'; text: RichText }
  | { type: 'superscript'; text: RichText }
  | { type: 'code'; text: RichText }
  | { type: 'url'; text: string; url: string }
  | { type: 'custom_emoji'; text: string; custom_emoji_id: string; alternative_text: string }
  | { type: 'datetime'; text: string; unix_time: number; date_time_format: string }
  | { type: 'email_address'; text: string; email_address: string }
  | { type: 'phone_number'; text: string; phone_number: string }
  | { type: 'text_mention'; text: string; user: { id: number } }
  | { type: 'reference'; text: string; name: string }
  | { type: 'reference_link'; text: string; reference_name: string };

/**
 * Convert markdown-it inline tokens into a native 10.2 `RichText` value
 * (either a plain string, or an array of styled entities). This makes inline
 * styling (bold/italic/code/links) fully native instead of relying on Telegram
 * re-parsing raw markdown — which also renders CJK bold correctly at word
 * boundaries.
 */
/**
 * Trim leading/trailing whitespace from a `RichText` value. A plain string is
 * trimmed directly; an array of entities is trimmed at its ends (passing
 * through inner entities unchanged).
 */
function trimRichText(rt: RichText): RichText {
  if (typeof rt === 'string') return rt.trim();
  if (!Array.isArray(rt)) return rt;
  const out: RichText[] = [];
  let started = false;
  for (const node of rt) {
    let n = node;
    if (!started) {
      if (typeof n === 'string') {
        if (!n.trim()) continue;
        n = n.trimStart();
      }
      started = true;
    }
    out.push(n);
  }
  // Trim trailing plain-string node.
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i];
    if (typeof n === 'string') {
      if (!n.trim()) { out.pop(); continue; }
      out[i] = n.trimEnd();
    }
    break;
  }
  if (out.length === 0) return '';
  if (out.length === 1 && typeof out[0] === 'string') return out[0];
  return out as RichText;
}


function inlineToRichText(inlineTokens: MarkdownToken[] | null | undefined, mathStore: string[] = []): RichText {
  if (!inlineTokens || inlineTokens.length === 0) return '';

  const out: RichText[] = [];
  const textBuf: string[] = [];
  const flush = () => {
    const t = textBuf.join('');
    if (t) out.push(t);
    textBuf.length = 0;
  };

  // Style stack: each entry records the entity type and the index in `out`
  // where its content begins.
  type Open = { type: RichTextEntity['type']; href?: string; start: number };
  const stack: Open[] = [];

  const pushPlainInner = (s: string) => {
    // Convert LaTeX delimiters into native mathematical_expression RichText
    // entities so formulas render natively. Handles $...$ / $$...$$
    // plus \(...\) / \[...\] (DeepSeek Pro Thinking emits these) and the
    // LATEXINLINE/LATEXBLOCK markers that normalizeMarkdownStructure
    // emits from them — otherwise those markers leak as literal text.
    const mathRe = /\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^\$\n\r]*?[^\s$])?)\$|LATEXBLOCKSTART([\s\S]+?)LATEXBLOCKEND|LATEXINLINESTART([\s\S]+?)LATEXINLINEEND|\\\[\s*([\s\S]+?)\s*\\\]|\\\(\s*([\s\S]+?)\s*\\\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = mathRe.exec(s)) !== null) {
      if (m.index > last) textBuf.push(s.slice(last, m.index));
      const expr = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '').trim();
      if (expr) {
        flush();
        out.push({ type: 'mathematical_expression', expression: expr });
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) textBuf.push(s.slice(last));
  };

  // Math formulas are extracted into private-use-area placeholders BEFORE
  // markdown-it parses the text (see markdownToRichBlocks / extractMath), so
  // the parser never splits formula internals like ( ) { } across tokens.
  // Here we swap each placeholder back to a native mathematical_expression
  // entity; any leftover $...$ / \(...\) (e.g. from the HTML path, which does
  // not pre-extract) is still handled by pushPlainInner below.
  const pushPlain = (s: string) => {
    const phRe = new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g');
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = phRe.exec(s)) !== null) {
      if (m.index > last) pushPlainInner(s.slice(last, m.index));
      const idx = Number(m[1]);
      const expr = ((mathStore && mathStore[idx]) ?? (mathPlaceholderStore && mathPlaceholderStore[idx]) ?? '').trim();
      if (expr) {
        flush();
        out.push({ type: 'mathematical_expression', expression: expr });
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) pushPlainInner(s.slice(last));
  };
  const open = (type: Open['type'], href?: string) => {
    flush();
    stack.push({ type, href, start: out.length });
  };
  const close = (type: Open['type']) => {
    const idx = [...stack].reverse().findIndex((s) => s.type === type);
    if (idx === -1) return;
    const realIdx = stack.length - 1 - idx;
    const top = stack.splice(realIdx, 1)[0];
    flush();
    const inner: RichText = out.slice(top.start);
    out.length = top.start;
    let node: RichTextEntity;
    switch (top.type) {
      case 'bold': node = { type: 'bold', text: inner }; break;
      case 'italic': node = { type: 'italic', text: inner }; break;
      case 'underline': node = { type: 'underline', text: inner }; break;
      case 'strikethrough': node = { type: 'strikethrough', text: inner }; break;
      case 'spoiler': node = { type: 'spoiler', text: inner }; break;
      case 'marked': node = { type: 'marked', text: inner }; break;
      case 'subscript': node = { type: 'subscript', text: inner }; break;
      case 'superscript': node = { type: 'superscript', text: inner }; break;
      case 'code': node = { type: 'code', text: inner }; break;
      case 'url': node = { type: 'url', text: String(inner).replace(/\n/g, ' '), url: top.href ?? '' }; break;
      case 'email_address': node = { type: 'email_address', text: String(inner), email_address: top.href ?? '' }; break;
      case 'phone_number': node = { type: 'phone_number', text: String(inner), phone_number: top.href ?? '' }; break;
      case 'text_mention': node = { type: 'text_mention', text: String(inner), user: { id: Number(top.href) } }; break;
      case 'reference': node = { type: 'reference', text: String(inner), name: top.href ?? '' }; break;
      case 'reference_link': node = { type: 'reference_link', text: String(inner), reference_name: top.href ?? '' }; break;
      case 'custom_emoji': node = { type: 'custom_emoji', text: String(inner), custom_emoji_id: top.href ?? '', alternative_text: String(inner) }; break;
      case 'datetime': {
        const [unix, fmt] = (top.href ?? '0:wDT').split(':');
        node = { type: 'datetime', text: String(inner), unix_time: Number(unix), date_time_format: fmt || 'wDT' };
        break;
      }
    }
    out.push(node as RichText);
  };

  const walk = (tk: MarkdownToken[]) => {
    for (const token of tk) {
      switch (token.type) {
        case 'inline':
          if (token.children) walk(token.children);
          break;
        case 'text':
        case 'code_inline':
          pushPlain(token.content ?? '');
          break;
        case 'softbreak':
        case 'hardbreak':
          pushPlain('\n');
          break;
        case 'em_open': open('italic'); break;
        case 'em_close': close('italic'); break;
        case 'strong_open': open('bold'); break;
        case 'strong_close': close('bold'); break;
        case 's_open': open('strikethrough'); break;
        case 's_close': close('strikethrough'); break;
        case 'spoiler_open': open('spoiler'); break;
        case 'spoiler_close': close('spoiler'); break;
        case 'code_open': open('code'); break;
        case 'code_close': close('code'); break;
        case 'link_open': {
          const href = getAttr(token, 'href') ?? '';
          // Classify link type by href scheme to construct appropriate Telegram RichText nodes.
          if (href.startsWith('mailto:')) open('email_address', href.slice(7));
          else if (href.startsWith('tel:')) open('phone_number', href.slice(4));
          else if (href.startsWith('tg://user?id=')) open('text_mention', href.slice(13));
          else if (href.startsWith('#')) open('reference_link', href.slice(1));
          else open('url', href);
          break;
        }
        case 'link_close': {
          // Determine what link type was opened by looking at the stack in reverse order.
          const lastLink = [...stack].reverse().find(s => s.type === 'url' || s.type === 'email_address' || s.type === 'phone_number' || s.type === 'text_mention' || s.type === 'reference_link');
          if (lastLink) close(lastLink.type);
          break;
        }
        case 'image':
          // Best-effort: represent image alt text as plain text.
          pushPlain(token.content ?? '');
          break;
        default: {
          // Process inline HTML tags which match specific Telegram rich-text formatting tags (e.g. underline, marked) 
          // or proprietary attributes (e.g. custom emojis, time stamps, reference links).
          if (token.type === 'html_inline' && token.content) {
            const tag = token.content;
            const openMatch = tag.match(/^<([\w-]+)(?:\s+([^>]*))?\/?>$/i);
            const closeMatch = tag.match(/^<\/([\w-]+)>$/i);
            if (openMatch) {
              const tagName = openMatch[1].toLowerCase();
              const attrs = openMatch[2] ?? '';
              
              // Standard styling tags.
              if (tagName === 'u' || tagName === 'ins') { open('underline'); break; }
              if (tagName === 'mark') { open('marked'); break; }
              if (tagName === 'sub') { open('subscript'); break; }
              if (tagName === 'sup') { open('superscript'); break; }
              
              // Custom Telegram entities.
              if (tagName === 'tg-emoji') {
                const emojiId = attrs.match(/emoji-id="([^"]*)"/)?.[1] ?? '';
                open('custom_emoji', emojiId);
                break;
              }
              if (tagName === 'tg-time') {
                const unix = attrs.match(/unix="(\d+)"/)?.[1] ?? '0';
                const fmt = attrs.match(/format="([^"]*)"/)?.[1] ?? 'wDT';
                open('datetime', `${unix}:${fmt}`);
                break;
              }
              if (tagName === 'tg-reference') {
                const name = attrs.match(/name="([^"]*)"/)?.[1] ?? '';
                open('reference', name);
                break;
              }
              
              // Media tags (self-closing). These are parsed, registered in the media store,
              // and replaced by a proprietary tg:// URI reference to be processed during message sending.
              if (tagName === 'img') {
                const src = attrs.match(/src="([^"]*)"/)?.[1] ?? '';
                if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
                  const id = nextMediaId();
                  mediaStore.push({ id, url: src, type: 'photo' });
                  pushPlain(`tg://photo?id=${id}`);
                }
                break;
              }
              if (tagName === 'video') {
                const src = attrs.match(/src="([^"]*)"/)?.[1] ?? '';
                if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
                  const id = nextMediaId();
                  mediaStore.push({ id, url: src, type: 'video' });
                  pushPlain(`tg://video?id=${id}`);
                }
                break;
              }
              if (tagName === 'audio') {
                const src = attrs.match(/src="([^"]*)"/)?.[1] ?? '';
                if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
                  const id = nextMediaId();
                  mediaStore.push({ id, url: src, type: 'audio' });
                  pushPlain(`tg://audio?id=${id}`);
                }
                break;
              }
              
              // Anchor elements (<a>) featuring specialized schemes.
              if (tagName === 'a') {
                const href = attrs.match(/href="([^"]*)"/)?.[1] ?? '';
                if (href.startsWith('mailto:')) open('email_address', href.slice(7));
                else if (href.startsWith('tel:')) open('phone_number', href.slice(4));
                else if (href.startsWith('tg://user?id=')) open('text_mention', href.slice(13));
                else if (href.startsWith('#')) open('reference_link', href.slice(1));
                else open('url', href);
                break;
              }
            }
            if (closeMatch) {
              const tagName = closeMatch[1].toLowerCase();
              if (tagName === 'u' || tagName === 'ins') { close('underline'); break; }
              if (tagName === 'mark') { close('marked'); break; }
              if (tagName === 'sub') { close('subscript'); break; }
              if (tagName === 'sup') { close('superscript'); break; }
              if (tagName === 'tg-emoji') { close('custom_emoji'); break; }
              if (tagName === 'tg-time') { close('datetime'); break; }
              if (tagName === 'tg-reference') { close('reference'); break; }
              if (tagName === 'a') {
                const lastLink = [...stack].reverse().find(s => 
                  s.type === 'url' || s.type === 'email_address' || 
                  s.type === 'phone_number' || s.type === 'text_mention' || 
                  s.type === 'reference_link'
                );
                if (lastLink) close(lastLink.type);
                break;
              }
            }
          }
          if (token.children) walk(token.children);
          break;
        }
      }
    }
  };

  walk(inlineTokens);
  flush();

  // Unclosed styles: wrap remaining as the topmost open entity if any.
  while (stack.length) close(stack[stack.length - 1].type);

  if (out.length === 0) return '';
  if (out.length === 1 && typeof out[0] === 'string') return out[0];
  return out as RichText;
}


// --- Math placeholder extraction (RichBlocks path) -------------------------
// DeepSeek Pro Thinking emits standard LaTeX delimiters \(...\) / \[...\].
// markdown-it's inline tokenizer splits formula internals containing ( ) { }
// across multiple text tokens, so the math regex in inlineToRichText never
// sees a complete delimiter pair and rendering fails. To avoid that we extract
// every formula into a private-use-area placeholder BEFORE parsing, then
// restore it as a native `mathematical_expression` entity afterwards.
// Synchronous execution makes a module-level store safe: markdownToRichBlocks
// populates it and inlineToRichText consumes it within the same call.
const MATH_OPEN = '\uE000';
const MATH_CLOSE = '\uE001';
let mathPlaceholderStore: string[] = [];

const MATH_EXTRACT_RE = /\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^\$\n\r]*?[^\s$])?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

function extractMath(source: string): { text: string; math: string[] } {
  const math: string[] = [];
  const text = source.replace(MATH_EXTRACT_RE, (_full, dBlock, dInline, bBlock, bInline) => {
    const expr = (dBlock ?? dInline ?? bBlock ?? bInline ?? '').trim();
    const idx = math.length;
    math.push(expr);
    return `${MATH_OPEN}${idx}${MATH_CLOSE}`;
  });
  return { text, math };
}

/**
 * Extract standalone `$$...$$` block math and `<a name="...">` / `<aside>` /
 * `<tg-math-block>` HTML blocks that markdown-it emits as `html_block` tokens,
 * converting them into native 10.2 blocks. Returns the block (or null) plus the
 * matched token length so the caller can skip the raw html_block token.
 */
function tryHtmlBlockToRichBlock(
  token: MarkdownToken,
): { block: RichBlock | null; advance: number } {
  const content = (token.content ?? '').trim();
  if (!content) return { block: null, advance: 1 };

  // `<a name="...">` → native anchor block.
  const anchorMatch = content.match(/^<a\s+name="([^"]*)"\s*\/?>\s*<\/a>\s*$/i)
    ?? content.match(/^<a\s+name="([^"]*)"\s*>\s*<\/a>\s*$/i);
  if (anchorMatch) {
    // Telegram's API server requires a `url` field on anchor blocks even though
    // @grammyjs/types does not declare it; cast to include it so the payload is
    // accepted (otherwise the whole message 400s and falls back to HTML).
    return { block: { type: 'anchor', name: anchorMatch[1], url: '' } as RichBlock, advance: 1 };
  }

  // `<tg-math-block>...</tg-math-block>` → native math block.
  const mathBlockMatch = content.match(/^<tg-math-block>([\s\S]*?)<\/tg-math-block>\s*$/i);
  if (mathBlockMatch) {
    return { block: { type: 'mathematical_expression', expression: mathBlockMatch[1].trim() }, advance: 1 };
  }

  // `<aside>...</aside>` → native pullquote block.
  const asideMatch = content.match(/^<aside>([\s\S]*?)<\/aside>\s*$/i);
  if (asideMatch) {
    const inner = trimRichText(inlineToRichText(md.parseInline(asideMatch[1], {}) as any as MarkdownToken[]));
    if (inner) {
      return { block: { type: 'pullquote', text: inner }, advance: 1 };
    }
  }

  return { block: null, advance: 1 };
}

function parseRichListToken(
  tokens: MarkdownToken[],
  startIndex: number,
  math: string[]
): { block: RichBlock; nextIndex: number } {
  const openToken = tokens[startIndex];
  const closeType = openToken.type.replace('open', 'close');
  const items: InputRichBlockListItem<never>[] = [];

  let idx = startIndex + 1;
  while (idx < tokens.length && tokens[idx].type !== closeType) {
    if (tokens[idx].type === 'list_item_open') {
      idx++;
      const itemBlocks: RichBlock[] = [];
      while (idx < tokens.length && tokens[idx].type !== 'list_item_close') {
        const tk = tokens[idx];
        if (tk.type === 'bullet_list_open' || tk.type === 'ordered_list_open') {
          const res = parseRichListToken(tokens, idx, math);
          itemBlocks.push(res.block);
          idx = res.nextIndex;
        } else if (tk.type === 'inline' && tk.children) {
          const rt = trimRichText(inlineToRichText(tk.children, math));
          if (rt) {
            itemBlocks.push({ type: 'paragraph', text: rt });
          }
          idx++;
        } else {
          idx++;
        }
      }
      if (idx < tokens.length && tokens[idx].type === 'list_item_close') {
        idx++;
      }
      if (itemBlocks.length > 0) {
        // Detect checkbox prefix [x] or [ ] in the first paragraph
        let hasCheckbox: true | undefined;
        let isChecked: true | undefined;
        const firstBlock = itemBlocks[0];
        if (firstBlock && firstBlock.type === 'paragraph') {
          const rawText = extractStringFromRichText(firstBlock.text).trim();
          const cbMatch = rawText.match(/^\[([ xX])\]\s*/);
          if (cbMatch) {
            hasCheckbox = true;
            if (cbMatch[1] !== ' ') isChecked = true;
            // Strip checkbox prefix from the RichText
            const prefixLen = cbMatch[0].length;
            if (typeof firstBlock.text === 'string') {
              firstBlock.text = firstBlock.text.slice(prefixLen);
            } else if (Array.isArray(firstBlock.text)) {
              const arr = firstBlock.text;
              const first = arr[0];
              if (typeof first === 'string' && first.startsWith(cbMatch[0])) {
                arr[0] = first.slice(prefixLen);
              }
            }
          }
        }
        const item: InputRichBlockListItem<never> = { blocks: itemBlocks };
        if (hasCheckbox) {
          item.has_checkbox = true;
          if (isChecked) item.is_checked = true;
        }
        items.push(item);
      }
    } else {
      idx++;
    }
  }

  const openType = tokens[startIndex].type;
  const isOrdered = openType === 'ordered_list_open';

  return {
    block: { type: 'list', is_ordered: isOrdered, items } as RichBlock,
    nextIndex: idx,
  };
}

/**
 * Convert markdown to Bot API 10.2 `InputRichBlock<never>[]` (media-free).
 *
 * Supported native block types:
 * - `heading` (size 1-6), `paragraph`, `pre` (with language)
 * - `list` / `list_item` (blocks), `table` (RichBlockTableCell[][])
 * - `blockquote`, `pullquote` (from `<aside>`), `details`
 * - `divider`, `mathematical_expression` (LaTeX), `anchor`
 *
 * Inline text uses native `RichText` entities (bold/italic/code/link/...) via
 * `inlineToRichText`, so styling — including CJK bold at word boundaries —
 * renders natively without relying on Telegram re-parsing raw markdown.
 */
function markdownTokensToRichBlocks(tokens: MarkdownToken[], math: string[]): RichBlock[] {
  const blocks: RichBlock[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token.type) {
      case 'html_block':
      case 'html_inline': {
        const { block } = tryHtmlBlockToRichBlock(token);
        if (block) blocks.push(block);
        break;
      }
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(token.tag.slice(1)) || 1));
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') {
          const text = trimRichText(inlineToRichText(inline.children, math));
          if (text) {
            const plainStr = extractStringFromRichText(text).trim();
            // Lines ending with punctuation (full stops/colons/exclamation) or longer than 40 chars
            // are intro paragraphs/sentences wrongly prefixed with `## `, not true short titles.
            const isSentenceOrParagraph = /[。！？!?：:]$/.test(plainStr) || plainStr.length > 40;
            if (isSentenceOrParagraph) {
              blocks.push({ type: 'paragraph', text });
            } else {
              blocks.push({ type: 'heading', size: level as 1 | 2 | 3 | 4 | 5 | 6, text });
            }
          }
          i += 2;
        }
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') {
          const text = trimRichText(inlineToRichText(inline.children, math));
          if (text) {
            blocks.push({ type: 'paragraph', text });
          }
          i += 2;
        }
        break;
      }
      case 'fence':
      case 'code_block': {
        blocks.push({
          type: 'pre',
          text: token.content ?? '',
          language: token.info || undefined,
        });
        break;
      }
      case 'blockquote_open': {
        let j = i + 1;
        let isDetails = false;
        let detailsSummary = '点击展开';
        
        let depth = 1;
        const innerTokens: MarkdownToken[] = [];
        while (j < tokens.length) {
          const nextToken = tokens[j];
          if (nextToken.type === 'blockquote_open') depth++;
          if (nextToken.type === 'blockquote_close') depth--;
          if (depth === 0) break;
          innerTokens.push(nextToken);
          j++;
        }

        const parsedInner = markdownTokensToRichBlocks(innerTokens, math);

        if (parsedInner.length > 0 && parsedInner[0].type === 'paragraph') {
          const firstPara = parsedInner[0] as any;
          const rawText = extractStringFromRichText(firstPara.text).trim();
          if (rawText.startsWith('[details]')) {
            isDetails = true;
            detailsSummary = rawText.replace(/^\[details\]\s*/i, '') || '点击展开';
            parsedInner.shift();
          }
        }

        if (isDetails) {
          blocks.push({
            type: 'details',
            summary: detailsSummary,
            blocks: parsedInner.length > 0 ? parsedInner : [{ type: 'paragraph', text: ' ' }],
          });
        } else {
          blocks.push({
            type: 'blockquote',
            blocks: parsedInner,
          });
        }
        i = j;
        break;
      }
      case 'hr': {
        blocks.push({ type: 'divider' });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const res = parseRichListToken(tokens, i, math);
        blocks.push(res.block);
        i = res.nextIndex - 1;
        break;
      }
      case 'table_open': {
        const cells: Array<Array<{ text?: RichText; is_header?: true; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle' | 'bottom' }>> = [];
        let currentRow: Array<{ text?: RichText; is_header?: true; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle' | 'bottom' }> = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== 'table_close') {
          const tk = tokens[j];
          if (tk.type === 'tr_open') {
            currentRow = [];
          } else if (tk.type === 'tr_close') {
            cells.push(currentRow);
          } else if (tk.type === 'td_open' || tk.type === 'th_open') {
            const inline = tokens[j + 1];
            const text = inline?.type === 'inline' ? trimRichText(inlineToRichText(inline.children, math)) : '';
            currentRow.push({
              text: text || undefined,
              is_header: tk.type === 'th_open' ? true : undefined,
              align: 'left',
              valign: 'middle',
            });
            j += 2;
          }
          j++;
        }
        if (cells.length > 0) {
          blocks.push({
            type: 'table',
            cells: cells as any,
            is_bordered: true,
            is_striped: true,
          });
        }
        i = j;
        break;
      }
    }
  }

  return blocks;
}

export function markdownToRichBlocks(markdown: string): RichBlock[] {
  // Reset media store for this conversion
  resetMediaStore();
  // Extract every LaTeX formula into a private-use-area placeholder BEFORE
  // parsing so markdown-it never splits formula internals ( ) { } across
  // tokens. Restored as mathematical_expression entities in inlineToRichText.
  const { text: placeholderText, math } = extractMath(markdown ?? '');
  mathPlaceholderStore = math;
  // Normalize fences (isolate ` ``` ` glued to text, surround with blank lines)
  // BEFORE structure normalization so markdown-it recognizes them as real fences.
  // The HTML path (markdownToHtmlSnippet) already does this; the RichBlocks path
  // was missing this step, causing fence code blocks with nested backticks or
  // language annotations like ````markdown` to fail parsing.
  const fenced = normalizeMarkdownFences(placeholderText);
  // Normalize structure (heading/bullet spacing, mid-line bullet splits,
  // glued `---` separators) BEFORE parsing — without this the streaming
  // render path parsed the raw markdown directly and collapsed bullets
  // that the model joined on a single line. The HTML path already runs
  // its own normalization; this keeps the RichBlocks path consistent.
  const tokens = md.parse(normalizeMarkdownStructure(fenced), {}) as any as MarkdownToken[];
  const blocks = markdownTokensToRichBlocks(tokens, math);

  if (blocks.length === 0 && markdown && markdown.trim()) {
    blocks.push({ type: 'paragraph', text: markdown.trim() });
  }

  // ── Post-processing ──

  // 1. Standalone checkbox conversion: paragraphs starting with [x] or [ ]
  //    that are NOT inside a list are wrapped into a single-item list block so
  //    Telegram renders them as native checkboxes instead of plain text.
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
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
            strippedText = (strippedText[0] as string);
          }
        }
        blocks[bi] = {
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

  // 2. Empty node protection: filter out any block whose text/content is
  //    empty or whitespace-only. This prevents Telegram from rejecting the
  //    payload (empty block bodies cause 400 errors).
  const MAX_DEPTH = 16;

  function isMeaningfulBlock(blk: RichBlock, depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    const b = blk as unknown as Record<string, unknown>;
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
    if (type === 'blockquote' || type === 'details') {
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
      const hasAnyItem = items.some(item => item.blocks.length > 0);
      return hasAnyItem;
    }
    if (type === 'anchor' || type === 'divider' || type === 'mathematical_expression') {
      return true;
    }
    if (type === 'table') {
      return true;
    }
    if (type === 'thinking') {
      return true;
    }
    return true;
  }

  const filtered = blocks.filter(b => isMeaningfulBlock(b, 0));

  // 3. Depth flattening: Telegram enforces a maximum nesting depth (16).
  //    Any nested list/blockquote beyond this limit is flattened one level.
  function flattenDepth(blk: RichBlock, depth: number): RichBlock {
    if (depth < MAX_DEPTH) return blk;
    if (blk.type === 'list') {
      const items = (blk as any).items as InputRichBlockListItem<never>[];
      for (const item of items) {
        item.blocks = item.blocks.flatMap(child => {
          if (child.type === 'list') {
            const nestedItems = (child as any).items as InputRichBlockListItem<never>[];
            return nestedItems.flatMap(ni => ni.blocks);
          }
          return [flattenDepth(child, depth + 1)];
        });
      }
    }
    if (blk.type === 'blockquote' || blk.type === 'details') {
      const inner = (blk as any).blocks as RichBlock[];
      (blk as any).blocks = inner.flatMap(child => {
        if (child.type === 'blockquote') return (child as any).blocks as RichBlock[];
        return [flattenDepth(child, depth + 1)];
      });
    }
    return blk;
  }

  const flattened = filtered.map(b => flattenDepth(b, 0));

  mathPlaceholderStore = [];
  return flattened;
}


/**
 * Format a structured message with optional thought into Telegram RichBlocks.
 * The returned blocks array is suitable for `sendRichMessage` / `editMessageText`
 * (final, persisted messages). For streaming drafts use
 * `buildStreamingBlocks` instead.
 */
export function buildFinalBlocks(
  content: string,
  thought?: string,
  opts?: { time?: string; tokens?: string; isClosed?: boolean; footerText?: string },
): RichBlock[] {
  const blocks: RichBlock[] = [];

  const body = markdownToRichBlocks(content);

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
    let summary = '🧠 思考过程 (Thinking Process)';
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

  // 4. Footer block LAST
  if (opts?.footerText) {
    blocks.push({ type: 'footer', text: opts.footerText });
  }

  return blocks;
}

/**
 * Build blocks for a streaming draft (Bot API 10.2, draft-only).
 *
 * - While the model is thinking (thought non-empty, no body yet):
 *   emits a native `thinking` placeholder block with the live thought text.
 * - When body arrives alongside thought:
 *   emits a collapsed `thinking` block showing thought, followed by body blocks.
 * - When only body (no thought): emits body blocks directly (no thinking block).
 * - When both empty: emits a static `thinking` placeholder ("正在思考...").
 */
export function buildStreamingBlocks(input: {
  content?: string;
  thought?: string;
}): RichBlock[] {
  const thought = (input.thought ?? '').trim();
  const content = (input.content ?? '').trim();

  if (thought && content) {
    const body = markdownToRichBlocks(content);
    return [
      { type: 'thinking', text: thought, collapsed: true } as RichBlock,
      ...body,
    ];
  }

  if (thought && !content) {
    return [{ type: 'thinking', text: thought } as RichBlock];
  }

  if (!thought && content) {
    return markdownToRichBlocks(content);
  }

  // Both empty
  return [{ type: 'thinking', text: '正在思考...' } as RichBlock];
}

/**
 * Build the native 10.2 footer blocks for a finalized message.
 *
 * Two native blocks are produced (in order):
 *  - `InputRichBlockDetails`: a collapsible "🧠 思考过程" block holding the
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
 *   <details>…<summary>🧠 思考过程 …</summary>…thinking…</details>
 *   <a href="tg://btn_info_footer|MODEL|IN|OUT|COST[|CACHED|THINKING]">⚙️ …</a>
 */
export function buildFooterBlocksFromHtml(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];

  // 1. Thinking <details> block.
  const detailsMatch = html.match(/<details[^>]*>([\s\S]*?)<\/details>/i);
  if (detailsMatch) {
    let inner = detailsMatch[1];
    inner = inner.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
    // Strip any stray <i>...</i> tags inside details (e.g. leftover stats text)
    // since the native footer block carries stats separately.
    inner = inner.replace(/<i>[\s\S]*?<\/i>/gi, '');
    
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
        summary: '🧠 思考过程 (Thinking Process)',
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
  if (typeof rt === 'object' && 'text' in (rt as any)) {
    return richTextLength((rt as any).text);
  }
  return 0;
}

function getBlockLength(block: RichBlock): number {
  const b = block as any;
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return richTextLength(b.text);
    case 'pre':
    case 'footer':
      return (b.text || '').length;
    case 'blockquote':
      return (b.blocks || []).reduce((s: number, child: RichBlock) => s + getBlockLength(child), 0);
    case 'details':
      return richTextLength(b.summary) + (b.blocks || [])
        .reduce((s: number, child: RichBlock) => s + getBlockLength(child), 0);
    case 'thinking':
      return richTextLength(b.text);
    case 'list':
      return (b.items || []).reduce((s: number, item: any) =>
        s + (item.blocks || []).reduce((s2: number, child: RichBlock) => s2 + getBlockLength(child), 0), 0);
    case 'table': {
      const cells: any[][] = b.cells || [];
      return cells.reduce((s: number, row: any[]) =>
        s + row.reduce((s2: number, cell: any) => s2 + richTextLength(cell.text), 0), 0);
    }
    case 'divider':
    case 'anchor':
    case 'mathematical_expression':
    default:
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
      const d = block as any;
      const inner = (d.blocks as RichBlock[]) || [];

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

      const detailsBlocks = groups
        .filter((g): g is RichBlock[] => g.length > 0)
        .map((g, idx, arr) => ({
          type: 'details' as const,
          blocks: g,
          summary: arr.length > 1
            ? `🧠 思考过程 (${idx + 1}/${arr.length})`
            : d.summary,
        }));

      // Distribute resulting details blocks across parts
      for (const db of detailsBlocks) {
        const dbLen = getBlockLength(db as unknown as RichBlock);
        if (currentLen + dbLen > maxChars) finishPart();
        parts[parts.length - 1].push(db as unknown as RichBlock);
        currentLen += dbLen;
      }
      continue;
    }

    // Rule 3: single paragraph that alone exceeds maxChars
    if (block.type === 'paragraph' && blockLen > maxChars) {
      const p = block as any;
      const raw = extractStringFromRichText(p.text);
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
      const p = block as any;
      const lines = (p.text || '').split('\n');
      const lang = p.language;
      let currentLines: string[] = [];
      let currentPreLen = 0;
      for (const line of lines) {
        const lineLen = line.length + 1;
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
