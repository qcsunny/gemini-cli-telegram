/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';
import type { MessageFormatter } from '../../core/types.js';
import type { RichBlock, RichText } from './richMessage.js';

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

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
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

// ── IR → Telegram HTML ──

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

const STYLE_MARKERS: Record<
  MarkdownStyle,
  { open: string; close: string }
> = {
  bold: { open: '<b>', close: '</b>' },
  italic: { open: '<i>', close: '</i>' },
  strikethrough: { open: '<s>', close: '</s>' },
  code: { open: '<code>', close: '</code>' },
  code_block: { open: '<pre><code>', close: '</code></pre>' },
  blockquote: { open: '<blockquote>', close: '</blockquote>' },
  underline: { open: '<u>', close: '</u>' },
  spoiler: { open: '<span class="tg-spoiler">', close: '</span>' },
};

function renderIRToHtml(ir: MarkdownIR): string {
  const { text, styles, links } = ir;
  if (!text) return '';

  const boundaries = new Set<number>([0, text.length]);

  const sorted = styles
    .filter((s) => STYLE_MARKERS[s.style] && s.end > s.start)
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
    const safeHref = escapeHtmlAttr(link.href);
    const rl: RenderLink = {
      start: link.start,
      end: link.end,
      open: `<a href="${safeHref}">`,
      close: '</a>',
    };
    boundaries.add(rl.start);
    boundaries.add(rl.end);
    const bucket = linkStarts.get(rl.start);
    if (bucket) bucket.push(rl);
    else linkStarts.set(rl.start, [rl]);
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const stack: { close: string; end: number }[] = [];

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
        const m = STYLE_MARKERS[span.style];
        openItems.push({
          end: span.end,
          open: m.open,
          close: m.close,
          kind: 'style',
          style: span.style,
          index,
        });
      }
    }

    if (openItems.length > 0) {
      openItems.sort((a, b) => {
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
        stack.push({ close: item.close, end: item.end });
      }
    }

    const next = points[i + 1];
    if (next === undefined) break;
    if (next > pos) {
      out += escapeHtml(text.slice(pos, next));
    }
  }

  return out;
}

export function markdownToHtml(markdown: string): string {
  const ir = markdownToIR(markdown);
  let html = renderIRToHtml(ir);
  // Convert blockquotes with [details] marker into expandable blockquotes, stripping the marker
  html = html.replace(/<blockquote>([\s\S]*?)\s*\[details\]\s*([\s\S]*?)<\/blockquote>/gi, '<blockquote expandable>$1$2</blockquote>');
  return html;
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

// ── Rich Text Blocks (API 10.1) ──

export function markdownToRichBlocks(markdown: string): RichBlock[] {
  const tokens = md.parse(markdown ?? '', {}) as any as MarkdownToken[];
  const blocks: RichBlock[] = [];

  const parseRichText = (inlineTokens: MarkdownToken[] | null | undefined): RichText => {
    if (!inlineTokens || inlineTokens.length === 0) return { text: '' };
    
    const state: RenderState = {
      text: '',
      styles: [],
      openStyles: [],
      links: [],
      linkStack: [],
      listStack: [],
    };
    renderTokens(inlineTokens, state);
    
    return { text: state.text };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    switch (token.type) {
      case 'heading_open': {
        const level = (Number(token.tag.slice(1)) || 1) as 1 | 2 | 3;
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') {
          blocks.push({
            type: 'section_heading',
            level: level > 3 ? 3 : level as 1 | 2 | 3,
            text: parseRichText(inline.children)
          });
          i += 2;
        }
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') {
          const rt = parseRichText(inline.children);
          if (rt.text.trim()) {
            blocks.push({
              type: 'paragraph',
              text: rt
            });
          }
          i += 2;
        }
        break;
      }
      case 'fence':
      case 'code_block': {
        blocks.push({
          type: 'preformatted',
          text: token.content ?? '',
          language: token.info || undefined
        });
        break;
      }
      case 'blockquote_open': {
        let content = '';
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== 'blockquote_close') {
          if (tokens[j].content) content += tokens[j].content;
          if (tokens[j].type === 'inline') content += tokens[j].content;
          j++;
        }
        if (content.trim()) {
          blocks.push({
            type: 'block_quotation',
            text: { text: content.trim() },
            is_collapsible: content.includes('[details]')
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
        const items: any[] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== (token.type.replace('open', 'close'))) {
          if (tokens[j].type === 'list_item_open') {
             let k = j + 1;
             while (k < tokens.length && tokens[k].type !== 'list_item_close') {
               if (tokens[k].type === 'inline') {
                 const rt = parseRichText(tokens[k].children);
                 if (rt.text.trim()) {
                   items.push({ type: 'list_item', text: rt });
                 }
               }
               k++;
             }
             j = k;
          }
          j++;
        }
        if (items.length > 0) {
          blocks.push({ type: 'list', items });
        }
        i = j;
        break;
      }
      case 'table_open': {
         const cells: any[][] = [];
         let currentRow: any[] = [];
         let j = i + 1;
         while (j < tokens.length && tokens[j].type !== 'table_close') {
           const token = tokens[j];
           if (token.type === 'tr_open') {
             currentRow = [];
           } else if (token.type === 'tr_close') {
             cells.push(currentRow);
           } else if (token.type === 'td_open' || token.type === 'th_open') {
             const inline = tokens[j + 1];
             if (inline?.type === 'inline') {
               currentRow.push({
                 text: parseRichText(inline.children),
                 is_header: token.type === 'th_open' ? true : undefined,
                 align: 'left',
                 valign: 'middle',
               });
             }
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

  if (blocks.length === 0 && markdown && markdown.trim()) {
     blocks.push({
       type: 'paragraph',
       text: { text: markdown.trim() }
     });
  }

  return blocks;
}
