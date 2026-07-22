/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file core.ts
 * @description Core Markdown→IR→HTML conversion engine, markdown-it instance,
 * IR state helpers, style rendering, and markdown normalization utilities.
 */

import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import { escapeHtml } from '../ui.js';

export const TELEGRAM_HTML_MAX_LENGTH = 4096;
export const TELEGRAM_RICH_MAX_LENGTH = 30000;

// ── Types ──

export type MarkdownStyle =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'underline'
  | 'code'
  | 'code_block'
  | 'blockquote'
  | 'spoiler';

export type StyleSpan = { start: number; end: number; style: MarkdownStyle; info?: string };
export type LinkSpan = { start: number; end: number; href: string };
export type MarkdownIR = { text: string; styles: StyleSpan[]; links: LinkSpan[]; tables?: string[] };

export type MarkdownToken = {
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
  tables?: string[];
};

type RenderState = RenderTarget & {
  listStack: ListState[];
};

export function getAlignAttr(token: MarkdownToken): string | null {
  const style = getAttr(token, 'style');
  if (style) {
    if (style.includes('text-align:center') || style.includes('text-align: center')) return 'center';
    if (style.includes('text-align:right') || style.includes('text-align: right')) return 'right';
    if (style.includes('text-align:left') || style.includes('text-align: left')) return 'left';
  }
  const align = getAttr(token, 'align');
  if (align) return align;
  return null;
}


// ── HTML escaping ──
// escapeHtml is imported from ui.ts; escapeHtmlAttr extends it with quote escaping.

export function escapeMarkdownV2(text: string): string {
  return text.replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// ── Markdown → IR (using markdown-it) ──

export function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) return token.attrGet(name);
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) return value;
    }
  }
  return null;
}

export const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});
md.enable(['strikethrough', 'table']);

// Treat CJK characters as emphasis boundaries so that `**加粗**` and
// `**"中文"**` adjacent to CJK text/punctuation render correctly (CommonMark
// otherwise requires spaces around the `**` delimiters and fails for CJK).
md.use(markdownItCjkFriendly);

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

function appendListPrefix(state: RenderState, nextText?: string) {
  const top = state.listStack[state.listStack.length - 1];
  if (!top) return;
  top.index += 1;
  const indent = '\u00A0\u00A0\u00A0\u00A0'.repeat(Math.max(0, state.listStack.length - 1));
  let prefix = '';
  if (top.type === 'ordered') {
    prefix = `${top.index}. `;
  } else {
    const isTask = nextText && /^\s*(?:\[[xX]\]|\[\s*\]|☑|☐|✔|✖)/.test(nextText);
    prefix = isTask ? '' : '\u2022 ';
  }
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


export function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
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
      case 'heading_open': {
        const hLevel = parseInt(token.tag.slice(1), 10) || 1;
        let prefix = '';
        if (hLevel === 1) {
          prefix = '📌 ';
        } else if (hLevel === 2) {
          prefix = '📍 ';
        } else if (hLevel === 3) {
          prefix = '🔹 ';
        } else {
          prefix = '• ';
        }
        appendText(state, prefix);
        openStyle(state, 'bold');
        break;
      }
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
      case 'list_item_open': {
        let nextText = '';
        if (tokens[i + 1]?.type === 'inline' && tokens[i + 1]?.children?.[0]?.content) {
          nextText = tokens[i + 1].children![0].content || '';
        } else if (tokens[i + 2]?.type === 'inline' && tokens[i + 2]?.children?.[0]?.content) {
          nextText = tokens[i + 2].children![0].content || '';
        }
        appendListPrefix(state, nextText);
        break;
      }
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
          style: 'code_block',
          info: token.info || undefined,
        });
        if (state.listStack.length === 0) state.text += '\n';
        break;
      }
      case 'table_open': {
        if (state.tables !== undefined) {
          let tableHtml = '<table bordered striped>';
          let j = i + 1;
          let currentAlign: string | null = null;
          let isHeader = false;

          while (j < tokens.length && tokens[j].type !== 'table_close') {
            const t = tokens[j];
            if (t.type === 'thead_open') {
              tableHtml += '<thead>';
            } else if (t.type === 'thead_close') {
              tableHtml += '</thead>';
            } else if (t.type === 'tbody_open') {
              tableHtml += '<tbody>';
            } else if (t.type === 'tbody_close') {
              tableHtml += '</tbody>';
            } else if (t.type === 'tr_open') {
              tableHtml += '<tr>';
            } else if (t.type === 'tr_close') {
              tableHtml += '</tr>';
            } else if (t.type === 'th_open' || t.type === 'td_open') {
              isHeader = t.type === 'th_open';
              currentAlign = getAlignAttr(t);
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
              const cellHtml = renderIRToHtml(cellState);
              const tag = isHeader ? 'th' : 'td';
              const alignAttr = currentAlign ? ` align="${currentAlign}"` : '';
              tableHtml += `<${tag}${alignAttr}>${cellHtml}</${tag}>`;
            }
            j++;
          }
          i = j;
          tableHtml += '</table>';

          const placeholderIdx = state.tables.length;
          state.tables.push(tableHtml);
          state.text += `\n___TELEGRAM_TABLE_PLACEHOLDER_${placeholderIdx}___\n`;
        } else {
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

export function markdownToIR(markdown: string, isHtml = false): MarkdownIR {
  let processed = markdown ?? '';
  if (isHtml) {
    processed = processed.replace(/\\\[([\s\S]+?)\\\]/g, 'LATEXBLOCKSTART$1LATEXBLOCKEND');
    processed = processed.replace(/\\\(([\s\S]+?)\\\)/g, 'LATEXINLINESTART$1LATEXINLINEEND');
  }
  processed = normalizeMarkdownStructure(processed);
  const tokens = md.parse(processed, {}) as any as MarkdownToken[];
  const state: RenderState = {
    text: '',
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    listStack: [],
    tables: isHtml ? [] : undefined,
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
  return { text: trimmed, styles: state.styles, links: state.links, tables: state.tables };
}


// ── IR → Telegram HTML ──

export const STYLE_ORDER: MarkdownStyle[] = [
  'blockquote',
  'code_block',
  'code',
  'bold',
  'italic',
  'strikethrough',
  'underline',
  'spoiler',
];

export const STYLE_RANK = new Map(STYLE_ORDER.map((s, i) => [s, i]));

export const STYLE_MARKERS: Record<
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

export function renderIRToHtml(ir: MarkdownIR): string {
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
        let openMarker = '';
        let closeMarker = '';
        if (span.style === 'code_block') {
          const lang = span.info ? escapeHtmlAttr(span.info) : '';
          const classAttr = lang ? ` class="language-${lang}"` : '';
          openMarker = `<pre><code${classAttr}>`;
          closeMarker = '</code></pre>';
        } else {
          const m = STYLE_MARKERS[span.style];
          openMarker = m.open;
          closeMarker = m.close;
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


export function formatTokenCount(count: string | number): string {
  const num = Number(count);
  if (isNaN(num)) return String(count);
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return String(num);
}

export function formatSummaryWithMetadata(time?: string, tokens?: string, isStreaming?: boolean): string {
  const parts: string[] = ['🧠 Gemini Thinking'];
  if (time) {
    const formattedTime = /^\d+(\.\d+)?$/.test(time) ? `${time}s` : time;
    parts.push(formattedTime);
  }
  if (tokens) {
    const formattedTokens = formatTokenCount(tokens);
    parts.push(formattedTokens);
  }
  if (!time && !tokens) {
    if (isStreaming) {
      parts.push('正在思考...');
    } else {
      parts.push('(点击展开)');
    }
  }
  return parts.join(' · ');
}

export function safeHtmlSlice(html: string, maxLength: number): { sliced: string; wasTruncated: boolean } {
  if (html.length <= maxLength) {
    return { sliced: html, wasTruncated: false };
  }

  let result = '';
  let count = 0;
  const tagStack: string[] = [];
  let i = 0;

  while (i < html.length && count < maxLength) {
    const char = html[i];
    if (char === '<') {
      const endIdx = html.indexOf('>', i);
      if (endIdx !== -1) {
        const tag = html.slice(i, endIdx + 1);
        result += tag;
        
        const isCloseTag = tag.startsWith('</');
        const isSelfClosing = tag.endsWith('/>');
        if (!isSelfClosing) {
          const match = tag.match(/^<\/?([a-zA-Z0-9-]+)/);
          if (match) {
            const tagName = match[1].toLowerCase();
            const isSelfClosingHtml = tagName === 'br' || tagName === 'hr' || tagName === 'img';
            if (!isSelfClosingHtml) {
              if (isCloseTag) {
                if (tagStack[tagStack.length - 1] === tagName) {
                  tagStack.pop();
                }
              } else {
                tagStack.push(tagName);
              }
            }
          }
        }
        i = endIdx + 1;
        continue;
      }
    } else if (char === '&') {
      const endIdx = html.indexOf(';', i);
      if (endIdx !== -1 && endIdx - i < 10) {
        const entity = html.slice(i, endIdx + 1);
        result += entity;
        count += entity.length;
        i = endIdx + 1;
        continue;
      }
    }
    
    result += char;
    count++;
    i++;
  }

  while (tagStack.length > 0) {
    const tag = tagStack.pop();
    result += `</${tag}>`;
  }

  return {
    sliced: result,
    wasTruncated: i < html.length,
  };
}

/**
 * Find a safe cut point in raw markdown text at or before `maxLen` such that the
 * slice is NOT split mid-structure. A cut is only allowed right after a blank
 * line (paragraph boundary) that lies OUTSIDE any fenced code block, table, or
 * run of heading lines. This keeps code blocks, tables and headings intact
 * across streamed-chunk boundaries.
 */
export function findSafeCutPoint(markdown: string, maxLen: number): number {
  if (markdown.length <= maxLen) return markdown.length;
  const text = markdown.slice(0, maxLen);

  // Track fenced code blocks (``` ... ```) so we never cut inside one.
  let inFence = false;
  let lastSafe = 0;
  const lines = text.split('\n');
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // toggle fence state on lines that are exactly a fence delimiter
    if (/^\s*```[a-zA-Z0-9_+#.-]*\s*$/.test(line)) {
      inFence = !inFence;
    }
    const lineEnd = acc + line.length; // index of '\n' after this line
    // A blank line ends a paragraph; safe to cut after it if not in a fence.
    if (!inFence && line.trim() === '' && i > 0) {
      // cut right after this blank line (include the '\n')
      lastSafe = Math.min(lineEnd + 1, text.length);
    }
    acc = lineEnd + 1; // +1 for the '\n'
  }

  if (lastSafe > 0) return lastSafe;

  // No paragraph boundary found before maxLen (e.g. one giant paragraph or
  // everything is inside a code block). Fall back to maxLen — better to overshoot
  // slightly than to mangle a code block by cutting mid-line.
  return maxLen;
}

export function trimHtmlBr(html: string): string {
  let result = html.trim();
  while (result.startsWith('<br>') || result.startsWith('<br/>') || result.startsWith('<br />')) {
    if (result.startsWith('<br>')) result = result.slice(4);
    else if (result.startsWith('<br/>')) result = result.slice(5);
    else if (result.startsWith('<br />')) result = result.slice(6);
    result = result.trim();
  }
  while (result.endsWith('<br>') || result.endsWith('<br/>') || result.endsWith('<br />')) {
    if (result.endsWith('<br>')) result = result.slice(0, -4);
    else if (result.endsWith('<br/>')) result = result.slice(0, -5);
    else if (result.endsWith('<br />')) result = result.slice(0, -6);
    result = result.trim();
  }
  return result;
}

export function normalizeMarkdownFences(markdown: string): string {
  if (!markdown) return markdown;
  let inputLines = markdown.split('\n');
  for (let i = 0; i < inputLines.length; i++) {
    inputLines[i] = inputLines[i].replace(/(^|.+?)(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)/g, (match, before, fence, info) => {
      if (/[^ \t>]/.test(before)) {
        return before + '\n' + fence + info;
      }
      return match;
    });
  }
  let text = inputLines.join('\n');
  text = text.replace(/(`{3,})([a-zA-Z0-9_+#.-]*)\n?([^\n`])/g, '$1$2\n$3');
  // 2. Isolate every fence delimiter (a line that is only ````` + optional lang)
  //    with blank lines so markdown-it parses it as a real fence instead of
  //    leaving raw ```` (which Telegram renders as one giant code block).
  //    Fence-count-aware: skips inner fences (lower backtick count) when inside
  //    an outer fence so that ````markdown` containing ```python is preserved.
  const lines = text.split('\n');
  const fenceRe = /^(\s*)(`{3,})([a-zA-Z0-9_+#.-]*)?\s*$/;
  const out: string[] = [];
  let prevWasBlank = true;
  let openFenceBackticks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(fenceRe);
    const isFence = !!fenceMatch;
    if (isFence) {
      const backtickCount = fenceMatch![2].length;
      if (openFenceBackticks === 0) {
        // Not inside a fence — this is a real fence opener
        openFenceBackticks = backtickCount;
        if (!prevWasBlank) {
          out.push('');
          prevWasBlank = true;
        }
        out.push(line);
        if (i + 1 < lines.length && lines[i + 1].trim() !== '' && !fenceRe.test(lines[i + 1])) {
          out.push('');
          prevWasBlank = true;
        } else {
          prevWasBlank = line.trim() === '';
        }
      } else if (backtickCount >= openFenceBackticks) {
        // Closing fence: same or more backticks than opener
        openFenceBackticks = 0;
        if (!prevWasBlank) {
          out.push('');
        }
        out.push(line);
        prevWasBlank = false;
      } else {
        // Inner fence (fewer backticks than outer) — treat as code content
        out.push(line);
        prevWasBlank = false;
      }
    } else {
      out.push(line);
      prevWasBlank = line.trim() === '';
    }
  }
  // 3. Collapse excessive blank lines.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Fix common markdown structural mistakes produced by LLM output so that
 * markdown-it renders them as intended:
 *  - ATX headings without a space after the hashes (e.g. `###1. 标题`,
 *    `#### 3.1 标题`) are not recognized as headings by the parser; insert the
 *    missing space so they become real headings.
 *  - A horizontal rule `---` on its own line that is missing surrounding blank
 *    lines (so it merges with adjacent text instead of becoming an `<hr>`) is
 *    given the blank lines it needs to be recognized as a separator.
 */
export function normalizeNestedCodeFences(markdown: string): string {
  if (!markdown) return markdown;
  const lines = markdown.split('\n');

  type FenceLine = { index: number; char: string; count: number; indent: string; info: string };
  const fenceLines: FenceLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    if (match) {
      const indent = match[1];
      const fenceStr = match[2];
      const char = fenceStr[0];
      const count = fenceStr.length;
      const info = match[3];
      // Per CommonMark spec (sec 4.5), a code fence info string cannot contain backticks or tildes.
      if (info.includes('`') || info.includes('~')) continue;
      fenceLines.push({ index: i, char, count, indent, info });
    }
  }

  if (fenceLines.length < 4) return markdown;

  const stack: { fence: FenceLine; maxInnerCount: number }[] = [];
  const upgrades = new Map<number, number>();

  for (const f of fenceLines) {
    if (stack.length === 0) {
      stack.push({ fence: f, maxInnerCount: 0 });
    } else {
      const top = stack[stack.length - 1];
      const isClosingCandidate = f.char === top.fence.char && f.info.trim() === '';

      // Update maxInnerCount for all active parent fences in the stack.
      // If f is closing the top fence, f is not an inner fence for top, but it is an inner fence for outer parents.
      for (let i = 0; i < stack.length; i++) {
        const item = stack[i];
        const isTopClosing = isClosingCandidate && i === stack.length - 1;
        if (!isTopClosing && f.char === item.fence.char && f.count >= item.fence.count) {
          item.maxInnerCount = Math.max(item.maxInnerCount, f.count);
        }
      }

      if (isClosingCandidate) {
        const closed = stack.pop()!;
        if (closed.maxInnerCount >= closed.fence.count) {
          const requiredCount = closed.maxInnerCount + 1;
          upgrades.set(closed.fence.index, requiredCount);
          upgrades.set(f.index, requiredCount);
          // Propagate requiredCount to all outer parent fences in the stack
          for (const item of stack) {
            item.maxInnerCount = Math.max(item.maxInnerCount, requiredCount);
          }
        }
      } else {
        stack.push({ fence: f, maxInnerCount: 0 });
      }
    }
  }

  if (upgrades.size === 0) return markdown;

  const result = [...lines];
  for (const [lineIdx, newCount] of upgrades.entries()) {
    const f = fenceLines.find(x => x.index === lineIdx)!;
    result[lineIdx] = `${f.indent}${f.char.repeat(newCount)}${f.info}`;
  }
  return result.join('\n');
}

export function normalizeMarkdownStructure(markdown: string): string {
  if (!markdown) return markdown;
  markdown = normalizeNestedCodeFences(markdown);

  // Process line-by-line to extract fenced code blocks (````) into placeholders so
  // subsequent normalizations (heading spacing, HR isolation, etc.) never corrupt code.
  // Uses backtick-count-aware matching: a ````markdown` fence (4+ backticks) correctly
  // contains inner ```python fences (3 backticks) without premature closing.
  // Unclosed fences are closed at EOF, not heuristically — headings inside Python/YAML
  // code (`# comment`) would otherwise trigger false auto-close and split the block.
  const lines = markdown.split('\n');
  const resultLines: string[] = [];
  const codeBlocks: string[] = [];

  let openFenceChar: string | null = null;
  let openFenceCount = 0;
  let currentBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      const fenceStr = fenceMatch[2];
      const fenceChar = fenceStr[0];
      const fenceCount = fenceStr.length;
      const info = fenceMatch[3];

      // CommonMark spec: info string cannot contain backticks/tildes
      if (openFenceCount === 0 && (info.includes('`') || info.includes('~'))) {
        resultLines.push(line);
        continue;
      }

      if (openFenceCount === 0) {
        openFenceChar = fenceChar;
        openFenceCount = fenceCount;
        currentBlockLines = [line];
      } else if (fenceChar === openFenceChar && fenceCount >= openFenceCount) {
        currentBlockLines.push(line);
        openFenceChar = null;
        openFenceCount = 0;
        const blockText = currentBlockLines.join('\n');
        codeBlocks.push(blockText);
        resultLines.push(`__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length - 1}__`);
        currentBlockLines = [];
      } else {
        currentBlockLines.push(line);
      }
    } else {
      if (openFenceCount > 0) {
        currentBlockLines.push(line);
      } else {
        resultLines.push(line);
      }
    }
  }

  if (openFenceCount > 0 && openFenceChar) {
    const closeFence = openFenceChar.repeat(openFenceCount);
    currentBlockLines.push(closeFence);
    const blockText = currentBlockLines.join('\n');
    codeBlocks.push(blockText);
    resultLines.push(`__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length - 1}__`);
  }

  let text = resultLines.join('\n');

  // Detect table headers where the model prepended a caption as the first cell
  // without a leading pipe (e.g. `1.人员信息表|员工编号|姓名|...`) causing a
  // column-count mismatch (header has 1 more cell than separator). Split the
  // caption onto its own line so markdown-it can parse the table.
  let tableLines = text.split('\n');
  for (let i = 0; i < tableLines.length - 1; i++) {
    const line = tableLines[i];
    const nextLine = tableLines[i + 1];
    if (line.includes('|') && !line.startsWith('|') &&
        nextLine.startsWith('|') && /^\|[-:\s]+\|/.test(nextLine)) {
      const headerCells = line.split('|').filter(Boolean).length;
      const sepCells = nextLine.split('|').filter(Boolean).length;
      if (headerCells === sepCells + 1) {
        const firstPipe = line.indexOf('|');
        tableLines.splice(i, 1, line.slice(0, firstPipe), line.slice(firstPipe));
        i++;
      }
    }
  }
  text = tableLines.join('\n');

  // Fix ordered list items missing space after dot (e.g. `1.第一阶段` → `1. 第一阶段`)
  // so markdown-it recognizes them as ordered list items.
  text = text.replace(/^(\s*\d+)\.([^\s\d])/gm, '$1. $2');

  // Normalize GFM checklist items (`- [x]`, `- [ ]`, `- ☑ [x]`, `- ☐ [ ]`, `- ☑`, `- ☐`)
  // into clean native GFM task list markdown (`- [x] ` and `- [ ] `).
  text = text.replace(/^([ \t]*)[*+\-]?\s*(?:☑|☑️|✔|✔️|\[[xX]\])\s*(?:\[[xX]\]|☑|☑️|✔|✔️)?\s*/gm, '$1- [x] ');
  text = text.replace(/^([ \t]*)[*+\-]?\s*(?:☐|☐️|\[\s*\])\s*(?:\[\s*\]|☐|☐️)?\s*/gm, '$1- [ ] ');

  // Convert model-emitted collapsible details prompts like `点击展开...` / `▶ ...` / `▼ ...`
  // followed by a blockquote `> ...` into `> [details] Summary\n> Content` so they render
  // as native Telegram <details> elements instead of being rendered as plain text + quote.
  text = text.replace(/^([ \t]*(?:点击展开|▶|▼|\[details\])[^\n]*)\n+[ \t]*>\s*([^\n]+)/gm, (match, summaryLine, firstQuoteLine) => {
    const cleanSummary = summaryLine.trim();
    return `> [details] ${cleanSummary}\n> ${firstQuoteLine}`;
  });

  // `###1.` / `## 2.1` already spaced is fine; fix `###1.`, `#### 3.1`,
  // `##标题` where the hash run is immediately followed by a non-space char.
  text = text.replace(/^(#{1,6})(?=[^\s#>])/gm, '$1 ');
  // Convert LaTeX display/inline delimiters \[...\] and \(...\) into the
  // LATEX* markers so BOTH the HTML and RichBlocks paths treat them as
  // math. (DeepSeek Pro Thinking emits these rather than $...$ / $$...$$.)
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, 'LATEXBLOCKSTART$1LATEXBLOCKEND');
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, 'LATEXINLINESTART$1LATEXINLINEEND');

  // Normalize indented decimal sub-numbering like `   1.1 ` or `      1.1.1 `
  // into standard Markdown list items `   1. ` so markdown-it parses them into 3-level lists.
  text = text.replace(/^([ \t]+)\d+(?:\.\d+)+\s+/gm, (_, indent: string) => `${indent}1. `);

  // Process bullet markers line by line, skipping table lines (containing '|') from bullet splitting
  // so cell values like `+15.4%`, `-5%`, `+85%` are never broken into newlines or bullet points.
  // We only split mid-line bullets preceded by sentence-ending punctuation (。！？）；) to avoid breaking inline code `*code*`.
  text = text.split('\n').map(line => {
    if (line.includes('|')) return line;
    let l = line.replace(/^([ \t]*)([*+\-])(?=[^\s*+\-])/g, '$1$2 ');
    l = l.replace(/([。！？）；])(\s*)([*+\-])(\s*)(?=[㐀-鿿0-9：:])/g, '$1\n$3 ');
    return l;
  }).join('\n');

  // Horizontal rules `---` / `———` emitted by the model are often glued to the
  // surrounding text without newlines (e.g. `问句？---总结来说` or `正文---### 4.`).
  // Split them onto their own line with surrounding blank lines so markdown-it parses them as <hr>.
  // We skip table and ASCII diagram lines (containing `|`, `+`, `-->`, `<--`) and word-internal dashes (`a---b`).
  text = text.split('\n').map(line => {
    if (line.includes('|') || line.includes('+') || line.includes('-->') || line.includes('<--')) return line;
    return line.replace(/([^\n])(---|———)(?=[^\n])/g, (match, p1, p2, offset, string) => {
      const nextChar = string[offset + match.length];
      if (/[a-zA-Z0-9]/.test(p1) && /[a-zA-Z0-9]/.test(nextChar || '')) {
        return match;
      }
      return p1 + '\n\n' + p2 + '\n\n';
    });
  }).join('\n');
  text = text.replace(/(\n|^)([ \t]*---[ \t]*|[ \t]*———[ \t]*)(?=\n|$)/g, '$1\n\n$2\n\n');
  // A heading (`#`..`######` + space) glued to the end of the previous line
  // (e.g. `## 1. 范式转移...AGI）### 1.1 大模型...`) is not recognized by the
  // parser because the `#` is not at line start. Split it onto its own line so
  // it renders as a real sub-heading instead of being swallowed into the prior
  // heading's text. We skip table lines (containing '|') so `#` inside table cells
  // (e.g. `# 欢迎使用`) is never broken onto a new line.
  text = text.split('\n').map(line => {
    if (line.includes('|')) return line;
    return line.replace(/([^\n\s#])(#{1,6}\s+[^\n]+)/g, '$1\n$2');
  }).join('\n');
  // Collapse the excessive blank lines we may have introduced.
  text = text.replace(/\n{3,}/g, '\n\n');

  // Restore protected code blocks
  text = text.replace(/__CODE_BLOCK_PLACEHOLDER_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);

  return text;
}

export function extractStringFromRichText(rt: any): string {
  if (!rt) return '';
  if (typeof rt === 'string') return rt;
  if (Array.isArray(rt)) return rt.map(extractStringFromRichText).join('');
  if (typeof rt === 'object' && 'text' in rt) return extractStringFromRichText(rt.text);
  return '';
}

export function isEligibleMainHeading(blk: { type: string; size?: number; text?: any } | undefined): boolean {
  if (!blk || blk.type !== 'heading') return false;
  // 1. Only H1 and H2 (size 1 or 2) can be main titles. H3..H6 (size >= 3) are sub-headings.
  if ((blk.size ?? 0) > 2) return false;

  const trimmed = extractStringFromRichText(blk.text).trim();

  // 2. Titles cannot be excessively long (> 40 chars). Long text is an intro paragraph.
  if (trimmed.length > 40) return false;

  // 3. Sentences/lead-in lines ending with full stops, exclamation marks, or colons are body text, not titles.
  if (/[。！？!?：:]$/.test(trimmed)) return false;

  // 4. Numbered list headers (e.g. `1.`, `2.`, `一、`, `（一）`, `(1)`, `第1`) are item section headers, not overall titles.
  if (/^(\d+[\.\、\)]|[一二三四五六七八九十]+[\、\)]|[\(\（]\d+[\)\）]|第\d+)/.test(trimmed)) return false;

  return true;
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
        if (span.style === 'code_block') {
          const lang = span.info ? escapeMarkdownV2(span.info) : '';
          openMarker = `\`\`\`${lang}\n`;
          closeMarker = '```';
        } else if (span.style === 'code') {
          openMarker = '`';
          closeMarker = '`';
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
      const isInsideCode = stack.some(item => item.style === 'code' || item.style === 'code_block');
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
