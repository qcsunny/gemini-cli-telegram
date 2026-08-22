/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file blocksRender.ts
 * @description Token-level rendering engine for Rich Text Blocks (Bot API 10.2),
 * extracted from blocks.ts: markdown-it inline/block token → native RichBlock
 * conversion (styled entities, math placeholders, media, lists, html tables),
 * including the markdownTokensToRichBlocks top-level token walk.
 */

import type { RichBlock } from '../richMessage.js';
import type { RichText, InputRichBlockListItem } from '@grammyjs/types/rich.js';
import { md, getAttr, extractStringFromRichText } from './core.js';
import { mediaStore, nextMediaId } from './media.js';
import type { MarkdownToken } from './core.js';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

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
  | { type: 'hashtag'; text: RichText; hashtag: string }
  | { type: 'cashtag'; text: RichText; cashtag: string }
  | { type: 'reference'; text: RichText; name: string }
  | { type: 'reference_link'; text: RichText; reference_name: string };

/**
 * Trim leading/trailing whitespace from a `RichText` value. A plain string is
 * trimmed directly; an array of entities is trimmed at its ends (passing
 * through inner entities unchanged).
 */
export function trimRichText(rt: RichText): RichText {
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

/**
 * Convert markdown-it inline tokens into a native 10.2 `RichText` value
 * (either a plain string, or an array of styled entities). This makes inline
 * styling (bold/italic/code/links) fully native instead of relying on Telegram
 * re-parsing raw markdown — which also renders CJK bold correctly at word
 * boundaries.
 */
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
    const mathRe = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$(?!\s)((?:\\\$|[^\$\n\r])+?)(?<![\s\\])\$|LATEXBLOCKSTART([\s\S]+?)LATEXBLOCKEND|LATEXINLINESTART([\s\S]+?)LATEXINLINEEND|\\\[\s*([\s\S]+?)\s*\\\]|\\\(\s*([\s\S]+?)\s*\\\)/g;
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
      case 'reference': node = { type: 'reference', text: inner, name: top.href ?? '' }; break;
      case 'reference_link': node = { type: 'reference_link', text: inner, reference_name: top.href ?? '' }; break;
      case 'hashtag': node = { type: 'hashtag', text: inner, hashtag: top.href ?? '' }; break;
      case 'cashtag': node = { type: 'cashtag', text: inner, cashtag: top.href ?? '' }; break;
      case 'custom_emoji': node = { type: 'custom_emoji', text: String(inner), custom_emoji_id: top.href ?? '', alternative_text: String(inner) }; break;
      case 'datetime': {
        const [unix, fmt] = (top.href ?? '0:wDT').split(':');
        node = { type: 'datetime', text: String(inner), unix_time: Number(unix), date_time_format: fmt || 'wDT' };
        break;
      }
    }
    out.push(node as RichText);
  };

  const walk = (tk: MarkdownToken[], depth = 0) => {
    if (depth > 64) return;
    for (const token of tk) {
      switch (token.type) {
        case 'inline':
          if (token.children) walk(token.children, depth + 1);
          break;
        case 'text':
          pushPlain(token.content ?? '');
          break;
        // markdown-it emits inline code as ONE self-closing token, so it has to be
        // wrapped here — the code_open/code_close pair below never fires for it.
        // Without this, every `backticked` span silently degrades to plain text.
        case 'code_inline':
          open('code');
          pushPlain(token.content ?? '');
          close('code');
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
              if (tagName === 'tg-hashtag') {
                const tagVal = attrs.match(/tag="([^"]*)"/)?.[1] ?? '';
                open('hashtag', tagVal);
                break;
              }
              if (tagName === 'tg-cashtag') {
                const tagVal = attrs.match(/tag="([^"]*)"/)?.[1] ?? '';
                open('cashtag', tagVal);
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
              if (tagName === 'tg-hashtag') { close('hashtag'); break; }
              if (tagName === 'tg-cashtag') { close('cashtag'); break; }
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
            // Unrecognized inline HTML tag (e.g. a literal <details> mentioned in
            // prose): keep the raw tag as plain text instead of silently dropping
            // it, matching the HTML path (markdownToIR appends html_inline content).
            // This point is only reached when no branch above matched a known tag.
            pushPlain(token.content);
          }
          if (token.children) walk(token.children, depth + 1);
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

const MATH_EXTRACT_RE = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$(?!\s)((?:\\\$|[^\$\n\r])+?)(?<![\s\\])\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

export function extractMath(source: string): { text: string; math: string[] } {
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
 * Convert standalone `<a name="...">` / `<aside>` / `<tg-math-block>` and media
 * HTML tags (`<img>`, `<video>`, `<audio>`, `<tg-slideshow>`, `<tg-collage>`,
 * `<tg-map>`) that markdown-it emits as `html_block` tokens into native 10.2
 * blocks. Returns the block (or null) plus the matched token length so the
 * caller can skip the raw html_block token. (`$$...$$` math is handled by the
 * separate math extraction path in markdownTokensToRichBlocks.)
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
  const asideMatch = content.match(/<aside>([\s\S]*?)<\/aside>/i);
  if (asideMatch) {
    const inner = trimRichText(inlineToRichText(md.parseInline(asideMatch[1].trim(), {}) as unknown as MarkdownToken[]));
    if (inner) {
      return { block: { type: 'pullquote', text: inner }, advance: 1 };
    }
  }

  // Standalone `<img src="https://...">` (own line) → native photo block.
  const imgMatch = content.match(/^<img\s+([^>]*?)\/?>\s*$/i);
  if (imgMatch) {
    const src = imgMatch[1].match(/src="([^"]*)"/)?.[1] ?? '';
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      return { block: mediaBlockFromUrl('img', src), advance: 1 };
    }
  }

  // `<tg-slideshow>...</tg-slideshow>` → native slideshow block containing
  // the media blocks parsed from the inner `<img>/<video>/<audio>` tags.
  const slideshowMatch = content.match(/^<tg-slideshow>([\s\S]*?)<\/tg-slideshow>\s*$/i);
  if (slideshowMatch) {
    const mediaBlocks = parseMediaBlocksFromHtml(slideshowMatch[1]);
    if (mediaBlocks.length > 0) {
      return { block: { type: 'slideshow', blocks: mediaBlocks } as RichBlock, advance: 1 };
    }
  }

  // `<tg-collage>...</tg-collage>` → native collage block containing the media
  // blocks parsed from the inner `<img>/<video>/<audio>` tags (same structure
  // as slideshow; the only difference is the block `type` value).
  const collageMatch = content.match(/^<tg-collage>([\s\S]*?)<\/tg-collage>\s*$/i);
  if (collageMatch) {
    const mediaBlocks = parseMediaBlocksFromHtml(collageMatch[1]);
    if (mediaBlocks.length > 0) {
      return { block: { type: 'collage', blocks: mediaBlocks } as RichBlock, advance: 1 };
    }
  }

  // `<tg-map ...>...</tg-map>` → native map block.
  const mapMatch = content.match(/^<tg-map\s+([^>]*)>\s*(?:<\/tg-map>)?\s*$/i);
  if (mapMatch) {
    const block = mapBlockFromAttrs(mapMatch[1]);
    if (block) return { block, advance: 1 };
  }

  return { block: null, advance: 1 };
}

/**
 * Build a native media RichBlock from a media HTML tag name and a remote URL.
 * `<video>` maps to `animation` for GIF/WebM sources, `video` otherwise;
 * `<audio>` maps to `voice_note` for OGG/Opus sources, `audio` otherwise.
 */
function mediaBlockFromUrl(tagName: 'img' | 'video' | 'audio', src: string): RichBlock {
  const path = src.split('?')[0].toLowerCase();
  const ext = path.endsWith('.gif') || path.endsWith('.webm') ? 'gif' : path.split('.').pop() ?? '';
  if (tagName === 'img') {
    return { type: 'photo', photo: { type: 'photo', media: src } } as RichBlock;
  }
  if (tagName === 'video') {
    if (ext === 'gif' || ext === 'webm') {
      return { type: 'animation', animation: { type: 'animation', media: src } } as RichBlock;
    }
    return { type: 'video', video: { type: 'video', media: src } } as RichBlock;
  }
  if (ext === 'ogg' || ext === 'opus') {
    return { type: 'voice_note', voice_note: { type: 'voice_note', media: src } } as RichBlock;
  }
  return { type: 'audio', audio: { type: 'audio', media: src } } as RichBlock;
}

/**
 * Parse media blocks out of the inner HTML of a `<tg-slideshow>`/`<tg-collage>`
 * container. Supports `<img>`, `<video>` and `<audio>` tags with `src="https://..."`
 * plus markdown image syntax `![alt](https://...)`.
 */
function parseMediaBlocksFromHtml(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const tagRe = /<(img|video|audio)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tagName = m[1].toLowerCase() as 'img' | 'video' | 'audio';
    const attrs = m[2] ?? '';
    const src = attrs.match(/src="([^"]*)"/)?.[1] ?? '';
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      blocks.push(mediaBlockFromUrl(tagName, src));
    }
  }
  const mdImgRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  while ((m = mdImgRe.exec(html)) !== null) {
    const src = m[1];
    if (!blocks.some(b => b.type === 'photo' && typeof b.photo === 'object' && b.photo !== null && 'media' in b.photo && b.photo.media === src)) {
      blocks.push(mediaBlockFromUrl('img', src));
    }
  }
  return blocks;
}

/**
 * Detect a standalone media tag pair inside a paragraph's inline children and
 * convert it to a native media RichBlock. Returns null when the paragraph
 * contains any other meaningful content (inline media stays as-is).
 *
 * Handles `<img src="...">` (self-closing) and paired `<video>/<audio>/<tg-map>`
 * tags; `<tg-map>` becomes a native map block.
 */
function tryInlineMediaToRichBlock(children: MarkdownToken[] | null | undefined): RichBlock | null {
  if (!children || children.length === 0) return null;

  // A standalone media paragraph must be exactly [openTag, closeTag] or a
  // single self-closing tag. Filter whitespace-only text tokens.
  const meaningful = children.filter(t => {
    if (t.type === 'text') return (t.content ?? '').trim() !== '';
    return true;
  });
  if (meaningful.length === 0) return null;

  // Self-closing `<img src="..."/>`
  if (meaningful.length === 1) {
    const t = meaningful[0];
    if (t.type === 'html_inline' && t.content) {
      const m = t.content.match(/^<img\b([^>]*?)\/?\s*>$/i);
      if (m) {
        const src = m[1].match(/src="([^"]*)"/)?.[1] ?? '';
        if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
          return mediaBlockFromUrl('img', src);
        }
      }
    }
    return null;
  }

  // Paired open + close tags.
  if (meaningful.length === 2) {
    const [openT, closeT] = meaningful;
    if (openT.type !== 'html_inline' || closeT.type !== 'html_inline') return null;
    const openContent = openT.content ?? '';
    const closeContent = closeT.content ?? '';
    const openMatch = openContent.match(/^<(video|audio|tg-map)\b([^>]*)>/i);
    const closeMatch = closeContent.match(/^<\/(video|audio|tg-map)>\s*$/i);
    if (!openMatch || !closeMatch) return null;
    if (openMatch[1].toLowerCase() !== closeMatch[1].toLowerCase()) return null;
    const tagName = openMatch[1].toLowerCase() as 'video' | 'audio' | 'tg-map';
    const attrs = openMatch[2] ?? '';

    if (tagName === 'tg-map') {
      return mapBlockFromAttrs(attrs);
    }

    const src = attrs.match(/src="([^"]*)"/)?.[1] ?? '';
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      return mediaBlockFromUrl(tagName, src);
    }
  }

  return null;
}

/**
 * Build a native map block from the attributes of a `<tg-map>` tag:
 * `location="lat,lng"`, optional `zoom`, `width` and `height`.
 * Returns null when location is missing or invalid.
 */
function mapBlockFromAttrs(attrs: string): RichBlock | null {
  const locationRaw = attrs.match(/location="([^"]*)"/)?.[1] ?? '';
  const [lat, lng] = locationRaw.split(',').map(s => Number(s.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const zoom = clampNumber(Number(attrs.match(/zoom="(\d+)"/)?.[1]), 0, 24, 13);
  const width = clampNumber(Number(attrs.match(/width="(\d+)"/)?.[1]), 1, 10000, 640);
  const height = clampNumber(Number(attrs.match(/height="(\d+)"/)?.[1]), 1, 10000, 480);
  return {
    type: 'map',
    location: { latitude: lat, longitude: lng },
    zoom,
    width,
    height,
  } as RichBlock;
}

/** Clamp a possibly-NaN number into [min, max], returning `def` when invalid. */
function clampNumber(value: number, min: number, max: number, def: number): number {
  if (!Number.isFinite(value)) return def;
  return Math.min(max, Math.max(min, value));
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
 * - media: `photo`, `video`, `animation`, `audio`, `voice_note`, `document`,
 *   `slideshow`, `collage`, `map` (from HTML media tags / markdown images)
 *
 * Inline text uses native `RichText` entities (bold/italic/code/link/...) via
 * `inlineToRichText`, so styling — including CJK bold at word boundaries —
 * renders natively without relying on Telegram re-parsing raw markdown.
 */
export function markdownTokensToRichBlocks(tokens: MarkdownToken[], math: string[]): RichBlock[] {
  const blocks: RichBlock[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token.type) {
      case 'html_block':
      case 'html_inline': {
        const { block } = tryHtmlBlockToRichBlock(token);
        if (block) {
          blocks.push(block);
        } else {
          // Fallback for unrecognized HTML/XML blocks: strip outer HTML/XML tags
          // and emit as a paragraph if there is non-empty content.
          const stripped = (token.content ?? '')
            .replace(/<[^>]*>/g, '')
            .trim();
          if (stripped) {
            const inner = trimRichText(inlineToRichText(md.parseInline(stripped, {}) as unknown as MarkdownToken[], math));
            if (inner) {
              blocks.push({ type: 'paragraph', text: inner });
            }
          }
        }
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
          // Standalone media tag pair (`<video>`/`<audio>`/`<tg-map>` open+close,
          // or a self-closing `<img>`) that is the only content of the paragraph
          // becomes a native media block instead of an inline-text placeholder.
          const mediaBlock = tryInlineMediaToRichBlock(inline.children);
          if (mediaBlock) {
            blocks.push(mediaBlock);
            i += 2;
            break;
          }
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
        let detailsSummary = 'Click to expand';
        
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

        // Detect a `> [details] <summary>` blockquote whose FIRST inline content
        // is the `[details]` marker. Detect it from the raw inline tokens so the
        // folded body keeps its original RichText formatting (bold/italic/code
        // etc.) instead of being re-parsed from a plain-text extract.
        const firstInlineIdx = innerTokens.findIndex(t => t.type === 'inline');
        if (firstInlineIdx !== -1) {
          const firstInline = innerTokens[firstInlineIdx] as MarkdownToken;
          const children = (firstInline.children ?? []) as MarkdownToken[];
          const firstTextNode = children.find(c => c.type === 'text');
          const firstText = firstTextNode?.content ?? '';
          if (firstText.startsWith('[details]')) {
            isDetails = true;
            const rest = firstText.replace(/^\[details\]\s*/i, '');
            const nl = rest.search(/\n/);
            if (nl === -1) {
              detailsSummary = rest.trim() || 'Click to expand';
            } else {
              detailsSummary = rest.slice(0, nl).trim() || 'Click to expand';
            }
            // Rebuild the paragraph's inline children WITHOUT the summary line:
            // drop the leading text node (summary) and the softbreak after it,
            // keeping every following formatted child intact.
            const summaryLen = firstText.length;
            const rebuiltChildren: MarkdownToken[] = [];
            let cursor = summaryLen;
            for (const child of children) {
              if (child.type === 'text' && cursor > 0) {
                const childContent = child.content ?? '';
                let cut = Math.min(cursor, childContent.length);
                if (cut > 0 && cut < childContent.length && /[\uD800-\uDBFF]/.test(childContent[cut - 1])) {
                  cut--;
                }
                const remainder = childContent.slice(cut);
                cursor -= cut;
                if (remainder) rebuiltChildren.push({ ...child, content: remainder });
              } else if (cursor > 0) {
                // Still consuming the summary line — skip softbreak/markers.
                cursor = 0;
              } else {
                rebuiltChildren.push(child);
              }
            }
            const rebuiltInline: MarkdownToken = { ...firstInline, children: rebuiltChildren, content: (firstInline.content ?? '').slice(summaryLen) };
            innerTokens[firstInlineIdx] = rebuiltInline;
          }
        }

        const parsedInner = markdownTokensToRichBlocks(innerTokens, math);

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
            cells,
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

/**
 * Sets the module-level math placeholder store. markdownToRichBlocks (in
 * blocks.ts) populates it synchronously before the token walk; inlineToRichText
 * consumes it within the same call, so a module-level store is safe.
 */
export function setMathPlaceholderStore(value: string[]): void {
  mathPlaceholderStore = value;
}
