/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';
import type { MessageFormatter } from '../../core/types.js';
const TELEGRAM_MAX_LENGTH = 4096;

// ── Types ──

type MarkdownStyle =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'underline'
  | 'code'
  | 'code_block'
  | 'blockquote'
  | 'spoiler';

type StyleSpan = { start: number; end: number; style: MarkdownStyle };
type LinkSpan = { start: number; end: number; href: string };
type MarkdownIR = { text: string; styles: StyleSpan[]; links: LinkSpan[] };

type MarkdownToken = {
  type: string;
  content?: string;
  children?: MarkdownToken[] | null;
  tag: string;
  info?: string;
  markup?: string;
  map?: [number, number] | null;
  attrs?: [string, string][] | null;
  attrGet?: (name: string) => string | null;
};

type ListState = { type: 'bullet' | 'ordered'; index: number };

type RenderTarget = {
  text: string;
  styles: StyleSpan[];
  openStyles: { style: MarkdownStyle; start: number }[];
  links: LinkSpan[];
  linkStack: { href: string; labelStart: number }[];
};

type RenderState = RenderTarget & {
  listStack: ListState[];
};

// ── Telegram formatter (message chunking) ──

export const telegramFormatter: MessageFormatter = {
  chunkText(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_LENGTH) {
      return [text];
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= TELEGRAM_MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', TELEGRAM_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        splitAt = TELEGRAM_MAX_LENGTH;
      }
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  },

  truncateForEdit(text: string): string {
    if (text.length <= TELEGRAM_MAX_LENGTH) {
      return text;
    }
    return text.substring(0, TELEGRAM_MAX_LENGTH - 4) + '\n...';
  },
};

// ── HTML escaping ──

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ── Markdown → IR (using markdown-it) ──

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) return token.attrGet(name);
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) return value;
    }
  }
  return null;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});
md.enable(['strikethrough', 'table']);

md.inline.ruler.at('text', (state, silent) => {
  const pos = state.pos;
  const idx = state.src.slice(pos).search(/[\n!#$&*+\-:<=>@[\\\]^_`{}~|]/);

  if (idx === 0) { return false; }
  
  let end = pos + idx;
  if (idx < 0) {
    end = state.posMax;
  }

  if (!silent) {
    state.pending += state.src.slice(pos, end);
  }

  state.pos = end;
  return true;
});

md.inline.ruler.after('escape', 'spoiler', (state, silent) => {
  const max = state.posMax;
  const start = state.pos;

  if (state.src.charCodeAt(start) !== 0x7C/* | */) return false;
  if (start + 1 >= max || state.src.charCodeAt(start + 1) !== 0x7C/* | */) return false;

  // Find closing ||
  let matchStart = start + 2;
  let matchEnd = -1;
  while (matchStart < max) {
    if (state.src.charCodeAt(matchStart) === 0x7C && matchStart + 1 < max && state.src.charCodeAt(matchStart + 1) === 0x7C) {
      matchEnd = matchStart;
      break;
    }
    matchStart++;
  }

  if (matchEnd === -1) return false;

  if (silent) return true;

  const oldMax = state.posMax;

  state.pos = start + 2;
  state.posMax = matchEnd;

  state.push('spoiler_open', 'span', 1);
  state.md.inline.tokenize(state);
  state.push('spoiler_close', 'span', -1);

  state.pos = matchEnd + 2;
  state.posMax = oldMax;
  return true;
});

function appendText(state: RenderState, value: string) {
  if (value) state.text += value;
}

function openStyle(state: RenderState, style: MarkdownStyle) {
  state.openStyles.push({ style, start: state.text.length });
}

function closeStyle(state: RenderState, style: MarkdownStyle) {
  for (let i = state.openStyles.length - 1; i >= 0; i--) {
    if (state.openStyles[i]?.style === style) {
      const start = state.openStyles[i].start;
      state.openStyles.splice(i, 1);
      if (state.text.length > start) {
        state.styles.push({ start, end: state.text.length, style });
      }
      return;
    }
  }
}

function appendParagraphSeparator(state: RenderState) {
  if (state.listStack.length > 0) return;
  state.text += '\n\n';
}

function appendListPrefix(state: RenderState) {
  const top = state.listStack[state.listStack.length - 1];
  if (!top) return;
  top.index += 1;
  const indent = '  '.repeat(Math.max(0, state.listStack.length - 1));
  const prefix = top.type === 'ordered' ? `${top.index}. ` : '\u2022 ';
  state.text += `${indent}${prefix}`;
}

function handleLinkClose(state: RenderState) {
  const link = state.linkStack.pop();
  if (!link?.href) return;
  const start = link.labelStart;
  const end = state.text.length;
  if (end > start) {
    state.links.push({ start, end, href: link.href.trim() });
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'inline':
        if (token.children) renderTokens(token.children, state);
        break;
      case 'text':
        appendText(state, token.content ?? '');
        break;
      case 'em_open':
        openStyle(state, 'italic');
        break;
      case 'em_close':
        closeStyle(state, 'italic');
        break;
      case 'strong_open':
        openStyle(state, 'bold');
        break;
      case 'strong_close':
        closeStyle(state, 'bold');
        break;
      case 's_open':
        openStyle(state, 'strikethrough');
        break;
      case 's_close':
        closeStyle(state, 'strikethrough');
        break;
      case 'spoiler_open':
        openStyle(state, 'spoiler');
        break;
      case 'spoiler_close':
        closeStyle(state, 'spoiler');
        break;
      case 'code_inline':
        if (token.content) {
          const start = state.text.length;
          state.text += token.content;
          state.styles.push({
            start,
            end: start + token.content.length,
            style: 'code',
          });
        }
        break;
      case 'link_open': {
        const href = getAttr(token, 'href') ?? '';
        state.linkStack.push({ href, labelStart: state.text.length });
        break;
      }
      case 'link_close':
        handleLinkClose(state);
        break;
      case 'image':
        appendText(state, token.content ?? '');
        break;
      case 'softbreak':
      case 'hardbreak':
        appendText(state, '\n');
        break;
      case 'paragraph_close':
        appendParagraphSeparator(state);
        break;
      case 'heading_open':
        openStyle(state, 'bold');
        break;
      case 'heading_close':
        closeStyle(state, 'bold');
        appendParagraphSeparator(state);
        break;
      case 'blockquote_open':
        openStyle(state, 'blockquote');
        break;
      case 'blockquote_close':
        closeStyle(state, 'blockquote');
        break;
      case 'bullet_list_open':
        if (state.listStack.length > 0) state.text += '\n';
        state.listStack.push({ type: 'bullet', index: 0 });
        break;
      case 'bullet_list_close':
        state.listStack.pop();
        if (state.listStack.length === 0) state.text += '\n';
        break;
      case 'ordered_list_open': {
        if (state.listStack.length > 0) state.text += '\n';
        const start = Number(getAttr(token, 'start') ?? '1');
        state.listStack.push({ type: 'ordered', index: start - 1 });
        break;
      }
      case 'ordered_list_close':
        state.listStack.pop();
        if (state.listStack.length === 0) state.text += '\n';
        break;
      case 'list_item_open':
        appendListPrefix(state);
        break;
      case 'list_item_close':
        if (!state.text.endsWith('\n')) state.text += '\n';
        break;
      case 'fence':
      case 'code_block': {
        let code = token.content ?? '';
        if (!code.endsWith('\n')) code += '\n';
        const start = state.text.length;
        state.text += code;
        state.styles.push({
          start,
          end: start + code.length,
          style: 'code',
        });
        if (state.listStack.length === 0) state.text += '\n';
        break;
      }
      case 'table_open': {
        const grid: string[][] = [];
        let currentRow: string[] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== 'table_close') {
          const t = tokens[j];
          if (t.type === 'tr_open') {
            currentRow = [];
          } else if (t.type === 'tr_close') {
            grid.push(currentRow);
          } else if (t.type === 'inline') {
            const cellState: RenderState = {
              text: '',
              styles: [],
              openStyles: [],
              links: [],
              linkStack: [],
              listStack: [],
            };
            if (t.children) {
              renderTokens(t.children, cellState);
            }
            currentRow.push(cellState.text.trim());
          }
          j++;
        }
        i = j;

        if (grid.length > 0) {
          const colWidths: number[] = [];
          for (const row of grid) {
            for (let c = 0; c < row.length; c++) {
              colWidths[c] = Math.max(colWidths[c] || 0, (row[c] || '').length);
            }
          }

          let tableText = '';
          for (let r = 0; r < grid.length; r++) {
            const row = grid[r];
            const formattedCells = row.map((cell, c) => cell.padEnd(colWidths[c]));
            tableText += '| ' + formattedCells.join(' | ') + ' |\n';
            if (r === 0) {
              const separatorCells = colWidths.map(w => '-'.repeat(w));
              tableText += '| ' + separatorCells.join(' | ') + ' |\n';
            }
          }

          const start = state.text.length;
          const wrappedTableText = `\n${tableText}`;
          state.text += wrappedTableText;
          state.styles.push({
            start: start + 1,
            end: start + wrappedTableText.length,
            style: 'code',
          });
          state.text += '\n';
        }
        break;
      }
      case 'html_block':
      case 'html_inline':
        appendText(state, token.content ?? '');
        break;
      case 'hr':
        state.text += '───\n\n';
        break;
      default:
        if (token.children) renderTokens(token.children, state);
        break;
    }
  }
}

function markdownToIR(markdown: string): MarkdownIR {
  const tokens = md.parse(markdown ?? '', {}) as any as MarkdownToken[];
  const state: RenderState = {
    text: '',
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    listStack: [],
  };

  renderTokens(tokens as MarkdownToken[], state);

  // Close any remaining open styles
  for (let i = state.openStyles.length - 1; i >= 0; i--) {
    const open = state.openStyles[i];
    if (state.text.length > open.start) {
      state.styles.push({
        start: open.start,
        end: state.text.length,
        style: open.style,
      });
    }
  }

  const trimmed = state.text.trimEnd();
  return { text: trimmed, styles: state.styles, links: state.links };
}

const STYLE_ORDER: MarkdownStyle[] = [
  'blockquote',
  'code_block',
  'code',
  'bold',
  'italic',
  'strikethrough',
  'underline',
  'spoiler',
];

const STYLE_RANK = new Map(STYLE_ORDER.map((s, i) => [s, i]));

const mdHtml = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});
mdHtml.enable(['table', 'strikethrough']);

// Custom rule for inline code block rendering to make sure it strictly uses <code>
mdHtml.renderer.rules.code_inline = (tokens, idx) => {
  return `<code>${escapeHtml(tokens[idx].content)}</code>`;
};

// Custom rule for fenced code block rendering to strictly use <pre><code class="language-...">
mdHtml.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = token.info ? token.info.trim() : '';
  const langClass = info ? ` class="language-${info}"` : '';
  return `<pre><code${langClass}>${escapeHtml(token.content)}</code></pre>`;
};

const ALLOWED_NAMED_ENTITIES = new Set([
  'lt', 'gt', 'amp', 'quot', 'apos', 'nbsp', 'hellip', 'mdash', 'ndash', 'lsquo', 'rsquo', 'ldquo', 'rdquo'
]);

const ENTITY_MAP: Record<string, string> = {
  'times': '&#215;',
  'bull': '&#8226;',
  'trade': '&#8482;',
  'reg': '&#174;',
  'copy': '&#169;',
  'cent': '&#162;',
  'pound': '&#163;',
  'yen': '&#165;',
  'euro': '&#8364;',
  'sect': '&#167;',
  'middot': '&#183;',
  'deg': '&#176;',
  'plusmn': '&#177;',
  'para': '&#182;',
  'divide': '&#247;',
  'raquo': '&#187;',
  'laquo': '&#171;',
};

export function sanitizeHtmlForTelegram(html: string): string {
  // Pre-process unsupported named entities
  html = html.replace(/&([a-zA-Z0-9]+);/g, (match, entityName) => {
    if (ALLOWED_NAMED_ENTITIES.has(entityName)) {
      return match;
    }
    return ENTITY_MAP[entityName] ?? `&#${entityName.charCodeAt(0)};`;
  });

  const ALLOWED_TAGS = new Set([
    'a', 'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'mark',
    'sub', 'sup', 'tg-spoiler', 'tg-reference', 'tg-emoji', 'img', 'tg-time', 'tg-math',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'footer', 'hr', 'ul', 'ol', 'li',
    'input', 'blockquote', 'cite', 'aside', 'video', 'audio', 'figure', 'figcaption',
    'tg-map', 'tg-collage', 'tg-slideshow', 'table', 'tr', 'th', 'td', 'caption',
    'details', 'summary', 'tg-math-block', 'tg-thinking'
  ]);

  const ALLOWED_ATTRS: Record<string, Set<string>> = {
    'a': new Set(['href', 'name']),
    'tg-reference': new Set(['name']),
    'tg-emoji': new Set(['emoji-id']),
    'img': new Set(['src', 'alt', 'tg-spoiler']),
    'video': new Set(['src', 'tg-spoiler']),
    'audio': new Set(['src']),
    'tg-time': new Set(['unix', 'format']),
    'ol': new Set(['start', 'type', 'reversed']),
    'li': new Set(['value', 'type']),
    'input': new Set(['type', 'checked']),
    'tg-map': new Set(['lat', 'long', 'zoom']),
    'table': new Set(['bordered', 'striped']),
    'td': new Set(['colspan', 'rowspan', 'align', 'valign']),
    'th': new Set(['colspan', 'rowspan', 'align', 'valign']),
    'details': new Set(['open']),
    'code': new Set(['class'])
  };

  const tagRegex = /<(\/?[a-zA-Z0-9\-]+)([^>]*?)(\/?>)/g;

  return html.replace(tagRegex, (fullMatch, tagNameWithSlash, attrsPart, closingSlash) => {
    const isClosing = tagNameWithSlash.startsWith('/');
    const tagName = (isClosing ? tagNameWithSlash.slice(1) : tagNameWithSlash).toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      return '';
    }

    if (isClosing) {
      return `</${tagName}>`;
    }

    const allowedAttrs = ALLOWED_ATTRS[tagName];
    let sanitizedAttrs = '';

    if (allowedAttrs) {
      const attrRegex = /([a-zA-Z0-9\-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let match;
      while ((match = attrRegex.exec(attrsPart)) !== null) {
        const attrName = match[1].toLowerCase();
        const attrValue = match[2] ?? match[3] ?? match[4] ?? '';

        if (allowedAttrs.has(attrName)) {
          if (attrName === 'class' && tagName === 'code') {
            if (attrValue.startsWith('language-')) {
              sanitizedAttrs += ` class="${attrValue}"`;
            }
          } else if (match[2] !== undefined || match[3] !== undefined || match[4] !== undefined) {
            sanitizedAttrs += ` ${attrName}="${attrValue}"`;
          } else {
            sanitizedAttrs += ` ${attrName}`;
          }
        }
      }
    }

    const isSelfClosing = closingSlash.trim() === '/' || tagName === 'img' || tagName === 'hr' || tagName === 'input' || tagName === 'tg-map';
    return `<${tagName}${sanitizedAttrs}${isSelfClosing ? ' /' : ''}>`;
  });
}

export function markdownToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';

  let text = markdown;

  const mathBlocks: string[] = [];
  const mathInlines: string[] = [];

  text = text.replace(/```math\n([\s\S]*?)```/g, (_, formula) => {
    mathBlocks.push(formula.trim());
    return `\n\nMATHBLOCKLH${mathBlocks.length - 1}LH\n\n`;
  });

  text = text.replace(/\$\$(.+?)\$\$/gs, (_, formula) => {
    mathBlocks.push(formula.trim());
    return `\n\nMATHBLOCKLH${mathBlocks.length - 1}LH\n\n`;
  });

  text = text.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_, formula) => {
    mathInlines.push(formula.trim());
    return `MATHINLINELH${mathInlines.length - 1}LH`;
  });

  text = text.replace(/\|\|([\s\S]*?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');

  let html = mdHtml.render(text);

  for (let i = 0; i < mathBlocks.length; i++) {
    const placeholder = `MATHBLOCKLH${i}LH`;
    const regex = new RegExp(`<p>\\s*${placeholder}\\s*</p>`, 'gi');
    if (regex.test(html)) {
      html = html.replace(regex, `<tg-math-block>${mathBlocks[i]}</tg-math-block>`);
    } else {
      html = html.replace(new RegExp(placeholder, 'g'), `<tg-math-block>${mathBlocks[i]}</tg-math-block>`);
    }
  }

  for (let i = 0; i < mathInlines.length; i++) {
    html = html.replace(new RegExp(`MATHINLINELH${i}LH`, 'g'), `<tg-math>${mathInlines[i]}</tg-math>`);
  }

  html = html
    .replace(/<table>/gi, '<table bordered striped>')
    .replace(/<\/?thead>/gi, '')
    .replace(/<\/?tbody>/gi, '');

  html = html
    .replace(/<li>\[ \] /gi, '<li><input type="checkbox">')
    .replace(/<li>\[x\] /gi, '<li><input type="checkbox" checked>');

  html = html.replace(/<blockquote>\s*<p>\s*\[details\]\s*(.*?)\s*[\r\n]+([\s\S]*?)<\/p>\s*<\/blockquote>/gi, '<details><summary>$1</summary><p>$2</p></details>');
  html = html.replace(/<blockquote>\s*<p>\s*\[details\]\s*(.*?)\s*<br>\s*([\s\S]*?)<\/p>\s*<\/blockquote>/gi, '<details><summary>$1</summary><p>$2</p></details>');
  html = html.replace(/<blockquote>\s*<p>\s*\[details\]\s*(.*?)\s*<\/p>\s*([\s\S]*?)<\/blockquote>/gi, '<details><summary>$1</summary>$2</details>');

  // Post-process HTML to merge adjacent image elements
  // 1. Merge adjacent paragraphs containing ONLY images
  let prev;
  let current = html;
  do {
    prev = current;
    current = current.replace(/(<p>(?:\s*<img[^>]+>\s*)+<\/p>)\s*(<p>(?:\s*<img[^>]+>\s*)+<\/p>)/gi, (m, p1, p2) => {
      const imgs1 = p1.replace(/<\/?p>/gi, '').trim();
      const imgs2 = p2.replace(/<\/?p>/gi, '').trim();
      return `<p>${imgs1}\n${imgs2}</p>`;
    });
  } while (current !== prev);
  html = current;

  // 2. Wrap contiguous images inside paragraphs into <tg-collage>
  html = html.replace(/<p>(\s*(?:<img[^>]+>\s*){2,})<\/p>/gi, (match, imgs) => {
    return `<tg-collage>${imgs.trim()}</tg-collage>`;
  });

  // 3. Wrap any remaining contiguous images outside of paragraphs (or separated by <br>) into <tg-collage>
  html = html.replace(/(?<!<tg-collage>)(?:^|\s*)(<img[^>]+>)(?:\s*(?:<br\s*\/?>)?\s*(<img[^>]+>))+(?!\s*<\/tg-collage>)/gi, (match) => {
    return `<tg-collage>${match.trim()}</tg-collage>`;
  });

  return sanitizeHtmlForTelegram(html);
}

// ── IR → Telegram MarkdownV2 ──

function renderIRToMarkdownV2(ir: MarkdownIR): string {
  const { text, styles, links } = ir;
  if (!text) return '';

  const boundaries = new Set<number>([0, text.length]);

  const sorted = styles
    .filter((s) => s.end > s.start)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return b.end - a.end;
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });

  const startsAt = new Map<number, StyleSpan[]>();
  for (const span of sorted) {
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) bucket.push(span);
    else startsAt.set(span.start, [span]);
  }

  for (const spans of startsAt.values()) {
    spans.sort((a, b) => {
      if (a.end !== b.end) return b.end - a.end;
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });
  }

  type RenderLink = {
    start: number;
    end: number;
    open: string;
    close: string;
  };
  const linkStarts = new Map<number, RenderLink[]>();
  for (const link of links) {
    if (!link.href || link.start >= link.end) continue;
    const escapedUrl = escapeMarkdownV2(link.href);
    const rl: RenderLink = {
      start: link.start,
      end: link.end,
      open: '[',
      close: `](${escapedUrl})`,
    };
    boundaries.add(rl.start);
    boundaries.add(rl.end);
    const bucket = linkStarts.get(rl.start);
    if (bucket) bucket.push(rl);
    else linkStarts.set(rl.start, [rl]);
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const stack: { close: string; end: number; style?: MarkdownStyle }[] = [];

  type OpenItem =
    | { end: number; open: string; close: string; kind: 'link'; index: number }
    | {
        end: number;
        open: string;
        close: string;
        kind: 'style';
        style: MarkdownStyle;
        index: number;
      };

  let out = '';

  for (let i = 0; i < points.length; i++) {
    const pos = points[i];

    while (stack.length && stack[stack.length - 1]?.end === pos) {
      const item = stack.pop();
      if (item) out += item.close;
    }

    const openItems: OpenItem[] = [];

    const openLinks = linkStarts.get(pos);
    if (openLinks) {
      for (const [index, link] of openLinks.entries()) {
        openItems.push({ ...link, kind: 'link', index });
      }
    }

    const openStyles = startsAt.get(pos);
    if (openStyles) {
      for (const [index, span] of openStyles.entries()) {
        let openMarker = '';
        let closeMarker = '';
        if (span.style === 'code') {
          const codeContent = text.slice(span.start, span.end);
          if (codeContent.includes('\n')) {
            openMarker = '```\n';
            closeMarker = '```';
          } else {
            openMarker = '`';
            closeMarker = '`';
          }
        } else if (span.style === 'bold') {
          openMarker = '*';
          closeMarker = '*';
        } else if (span.style === 'italic') {
          openMarker = '_';
          closeMarker = '_';
        } else if (span.style === 'underline') {
          openMarker = '__';
          closeMarker = '__';
        } else if (span.style === 'strikethrough') {
          openMarker = '~';
          closeMarker = '~';
        } else if (span.style === 'spoiler') {
          openMarker = '||';
          closeMarker = '||';
        }

        openItems.push({
          end: span.end,
          open: openMarker,
          close: closeMarker,
          kind: 'style',
          style: span.style,
          index,
        });
      }
    }

    if (openItems.length > 0) {
      openItems.sort((a: any, b: any) => {
        if (a.end !== b.end) return b.end - a.end;
        if (a.kind !== b.kind) return a.kind === 'link' ? -1 : 1;
        if (a.kind === 'style' && b.kind === 'style') {
          return (
            (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0)
          );
        }
        return a.index - b.index;
      });
      for (const item of openItems) {
        out += item.open;
        stack.push({ close: item.close, end: item.end, style: item.kind === 'style' ? item.style : undefined });
      }
    }

    const next = points[i + 1];
    if (next === undefined) break;
    if (next > pos) {
      const segment = text.slice(pos, next);
      const isInsideCode = stack.some(item => item.style === 'code');
      if (isInsideCode) {
        out += segment;
      } else {
        out += escapeMarkdownV2(segment);
      }
    }
  }

  return out;
}

export function markdownToMarkdownV2(markdown: string): string {
  const ir = markdownToIR(markdown);
  return renderIRToMarkdownV2(ir);
}

// Legacy rich blocks parsing has been deprecated in favor of native Rich HTML (Option A).
