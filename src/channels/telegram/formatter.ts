/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';
import type { MessageFormatter, StructuredMessage } from '../../core/types.js';
import type { RichBlock, RichText } from './richMessage.js';
import { extractThoughtBlocksAndSegments } from '../../agy/agyCli.js';

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

type StyleSpan = { start: number; end: number; style: MarkdownStyle; info?: string };
type LinkSpan = { start: number; end: number; href: string };
type MarkdownIR = { text: string; styles: StyleSpan[]; links: LinkSpan[]; tables?: string[] };

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
  tables?: string[];
};

type RenderState = RenderTarget & {
  listStack: ListState[];
};

function getAlignAttr(token: MarkdownToken): string | null {
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

// ── Telegram formatter (message chunking) ──

type HtmlToken = {
  type: 'details' | 'pre' | 'table' | 'math_block' | 'blockquote' | 'text' | 'break';
  value: string;
};

export function tokenizeHtml(htmlText: string): HtmlToken[] {
  const blockRegex = /(<details[\s>][\s\S]*?<\/details>|<pre[\s>][\s\S]*?<\/pre>|<table[\s>][\s\S]*?<\/table>|<tg-math-block>[\s\S]*?<\/tg-math-block>|<blockquote>[\s\S]*?<\/blockquote>)/gi;
  const parts = htmlText.split(blockRegex);
  const tokens: HtmlToken[] = [];
  
  for (const part of parts) {
    if (!part) continue;
    
    if (part.toLowerCase().startsWith('<details')) {
      tokens.push({ type: 'details', value: part });
    } else if (part.toLowerCase().startsWith('<pre')) {
      tokens.push({ type: 'pre', value: part });
    } else if (part.toLowerCase().startsWith('<table')) {
      tokens.push({ type: 'table', value: part });
    } else if (part.toLowerCase().startsWith('<tg-math-block')) {
      tokens.push({ type: 'math_block', value: part });
    } else if (part.toLowerCase().startsWith('<blockquote')) {
      tokens.push({ type: 'blockquote', value: part });
    } else {
      const subParts = part.split(/(<br\s*\/?>\s*<br\s*\/?>|<br\s*\/?>)/gi);
      for (const subPart of subParts) {
        if (!subPart) continue;
        if (subPart.toLowerCase().startsWith('<br')) {
          tokens.push({ type: 'break', value: subPart });
        } else {
          tokens.push({ type: 'text', value: subPart });
        }
      }
    }
  }
  
  return tokens;
}

export function splitDetails(detailsHtml: string, maxLength: number): string[] {
  const match = detailsHtml.match(/<details([^>]*)>([\s\S]*?)<\/details>/i);
  if (!match) return [detailsHtml];
  
  const attrs = match[1];
  const innerContent = match[2];
  
  const summaryMatch = innerContent.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summaryText = summaryMatch ? summaryMatch[1] : '点击展开';
  
  const bodyStartIdx = summaryMatch ? innerContent.indexOf(summaryMatch[0]) + summaryMatch[0].length : 0;
  const bodyContent = innerContent.substring(bodyStartIdx);
  
  const detailsStartBase = `<details${attrs}><summary>${summaryText}</summary>`;
  const detailsEnd = '</details>';
  const baseLen = detailsStartBase.length + detailsEnd.length;
  
  const subMaxLength = maxLength - baseLen - 5;
  if (subMaxLength <= 10) {
    return splitTextWithOpenTags(detailsHtml, maxLength);
  }
  
  const bodyChunks = chunkAnswerBody(bodyContent, subMaxLength);
  return bodyChunks.map((chunk, idx) => {
    const suffix = idx > 0 ? ' (续)' : '';
    const newSummary = `<summary>${summaryText}${suffix}</summary>`;
    return `<details${attrs}>${newSummary}${chunk}${detailsEnd}`;
  });
}

export function splitCodeBlock(codeBlockHtml: string, maxLength: number): string[] {
  const match = codeBlockHtml.match(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/i);
  if (!match) return [codeBlockHtml];
  
  const attrs = match[1];
  const content = match[2];
  
  const preStart = `<pre><code${attrs}>`;
  const preEnd = '</code></pre>';
  
  const lines = content.split('\n');
  const chunks: string[] = [];
  let currentLines: string[] = [];
  
  for (const line of lines) {
    const currentChunkHtml = preStart + [...currentLines, line].join('\n') + preEnd;
    if (currentChunkHtml.length > maxLength && currentLines.length > 0) {
      chunks.push(preStart + currentLines.join('\n') + preEnd);
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  
  if (currentLines.length > 0) {
    chunks.push(preStart + currentLines.join('\n') + preEnd);
  }
  
  return chunks;
}

export function splitTable(tableHtml: string, maxLength: number): string[] {
  const theadMatch = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/i);
  const tbodyMatch = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  
  const thead = theadMatch ? theadMatch[0] : '';
  const tbodyContent = tbodyMatch ? tbodyMatch[1] : '';
  
  const rows: string[] = [];
  const trRegex = /<tr>[\s\S]*?<\/tr>/gi;
  let match;
  while ((match = trRegex.exec(tbodyContent)) !== null) {
    rows.push(match[0]);
  }
  
  if (rows.length === 0) {
    return [tableHtml];
  }
  
  const chunks: string[] = [];
  let currentRows: string[] = [];
  
  const tableStart = '<table bordered striped>';
  const tableEnd = '</table>';
  
  for (const row of rows) {
    const currentChunkHtml = tableStart + thead + '<tbody>' + [...currentRows, row].join('') + '</tbody>' + tableEnd;
    if (currentChunkHtml.length > maxLength && currentRows.length > 0) {
      chunks.push(tableStart + thead + '<tbody>' + currentRows.join('') + '</tbody>' + tableEnd);
      currentRows = [row];
    } else {
      currentRows.push(row);
    }
  }
  
  if (currentRows.length > 0) {
    chunks.push(tableStart + thead + '<tbody>' + currentRows.join('') + '</tbody>' + tableEnd);
  }
  
  return chunks;
}

export function splitMathBlock(mathBlockHtml: string, maxLength: number): string[] {
  const match = mathBlockHtml.match(/<tg-math-block>([\s\S]*?)<\/tg-math-block>/i);
  if (!match) return [mathBlockHtml];
  const content = match[1];
  
  const chunks: string[] = [];
  const startTag = '<tg-math-block>';
  const endTag = '</tg-math-block>';
  
  const parts = content.split(/(\\\\|\n)/);
  let currentParts: string[] = [];
  
  for (const part of parts) {
    const currentChunkHtml = startTag + [...currentParts, part].join('') + endTag;
    if (currentChunkHtml.length > maxLength && currentParts.length > 0) {
      chunks.push(startTag + currentParts.join('') + endTag);
      currentParts = [part];
    } else {
      currentParts.push(part);
    }
  }
  if (currentParts.length > 0) {
    chunks.push(startTag + currentParts.join('') + endTag);
  }
  return chunks;
}

export function splitTextWithOpenTags(htmlText: string, maxLength: number): string[] {
  const tagRegex = /<[^>]+>/g;
  let match;
  const elements: { type: 'tag' | 'text'; value: string }[] = [];
  let lastIdx = 0;
  
  while ((match = tagRegex.exec(htmlText)) !== null) {
    if (match.index > lastIdx) {
      elements.push({ type: 'text', value: htmlText.substring(lastIdx, match.index) });
    }
    elements.push({ type: 'tag', value: match[0] });
    lastIdx = tagRegex.lastIndex;
  }
  if (lastIdx < htmlText.length) {
    elements.push({ type: 'text', value: htmlText.substring(lastIdx) });
  }
  
  const chunks: string[] = [];
  let currentChunk = '';
  const openTags: { tagName: string; fullTag: string }[] = [];
  
  for (const el of elements) {
    if (el.type === 'tag') {
      const tag = el.value;
      const isClosing = tag.startsWith('</');
      const isSelfClosing = tag.endsWith('/>') || tag.toLowerCase().startsWith('<br');
      
      if (isClosing) {
        openTags.pop();
      } else if (!isSelfClosing) {
        const tagNameMatch = tag.match(/<([a-zA-Z0-9-]+)/);
        if (tagNameMatch) {
          openTags.push({ tagName: tagNameMatch[1], fullTag: tag });
        }
      }
      
      const closeTagsHtml = openTags.map(t => `</${t.tagName}>`).reverse().join('');
      const openTagsHtml = openTags.map(t => t.fullTag).join('');
      
      if (currentChunk.length + tag.length + closeTagsHtml.length > maxLength && currentChunk.length > 0) {
        chunks.push(currentChunk + closeTagsHtml);
        currentChunk = openTagsHtml + tag;
      } else {
        currentChunk += tag;
      }
    } else {
      const textVal = el.value;
      let textIdx = 0;
      
      while (textIdx < textVal.length) {
        const closeTagsHtml = openTags.map(t => `</${t.tagName}>`).reverse().join('');
        const openTagsHtml = openTags.map(t => t.fullTag).join('');
        
        const budget = maxLength - currentChunk.length - closeTagsHtml.length;
        if (budget <= 5 && currentChunk.length > openTagsHtml.length) {
          chunks.push(currentChunk + closeTagsHtml);
          currentChunk = openTagsHtml;
          continue;
        }
        
        const take = Math.max(1, Math.min(budget, textVal.length - textIdx));
        let slice = textVal.substring(textIdx, textIdx + take);
        
        if (textIdx + take < textVal.length) {
          const lastSpace = slice.lastIndexOf(' ');
          if (lastSpace > 0) {
            slice = slice.substring(0, lastSpace);
          }
        }
        
        currentChunk += slice;
        textIdx += slice.length;
        
        if (textIdx < textVal.length) {
          chunks.push(currentChunk + closeTagsHtml);
          currentChunk = openTagsHtml;
        }
      }
    }
  }
  
  if (currentChunk.trim().length > 0) {
    const closeTagsHtml = openTags.map(t => `</${t.tagName}>`).reverse().join('');
    chunks.push(currentChunk + closeTagsHtml);
  }
  
  return chunks.map(c => c.trim()).filter(Boolean);
}

export function chunkAnswerBody(htmlText: string, maxLength: number): string[] {
  if (htmlText.length <= maxLength) {
    return [htmlText];
  }
  
  const tokens = tokenizeHtml(htmlText);
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const token of tokens) {
    const val = token.value;
    
    if (val.length > maxLength) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      
      let subChunks: string[] = [];
      if (token.type === 'details') {
        subChunks = splitDetails(val, maxLength);
      } else if (token.type === 'pre') {
        subChunks = splitCodeBlock(val, maxLength);
      } else if (token.type === 'table') {
        subChunks = splitTable(val, maxLength);
      } else if (token.type === 'math_block') {
        subChunks = splitMathBlock(val, maxLength);
      } else {
        subChunks = splitTextWithOpenTags(val, maxLength);
      }
      
      for (const subChunk of subChunks) {
        chunks.push(subChunk);
      }
    } else {
      if (currentChunk.length + val.length > maxLength) {
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk);
        }
        currentChunk = val;
      } else {
        currentChunk += val;
      }
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks.map(c => c.trim()).filter(Boolean);
}

export const telegramFormatter: MessageFormatter = {
  chunkText(text: string): string[] {
    if (text.startsWith('___RAW_HTML___')) {
      const htmlText = text.substring('___RAW_HTML___'.length);
      return chunkAnswerBody(htmlText, TELEGRAM_MAX_LENGTH).map(c => '___RAW_HTML___' + c);
    }
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

function markdownToIR(markdown: string, isHtml = false): MarkdownIR {
  const tokens = md.parse(markdown ?? '', {}) as any as MarkdownToken[];
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

function formatTokenCount(count: string | number): string {
  const num = Number(count);
  if (isNaN(num)) return String(count);
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return String(num);
}

function formatSummaryWithMetadata(time?: string, tokens?: string, isStreaming?: boolean): string {
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
        count++;
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

function trimHtmlBr(html: string): string {
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

function markdownToHtmlSnippet(markdown: string): string {
  const ir = markdownToIR(markdown, true);
  let html = renderIRToHtml(ir);

  if (ir.tables && ir.tables.length > 0) {
    for (let idx = 0; idx < ir.tables.length; idx++) {
      html = html.replace(`___TELEGRAM_TABLE_PLACEHOLDER_${idx}___`, ir.tables[idx]);
    }
  }

  html = html.replace(/<blockquote>([\s\S]*?)\[details\]\s*([^\n<]*)(?:<br\s*\/?>|\n)?([\s\S]*?)<\/blockquote>/gi, (match, p1, p2, p3) => {
    const summary = p2.trim() || '点击展开';
    return `<details><summary>${summary}</summary>${p3}</details>`;
  });

  html = html.replace(/\[footer:\s*(.*?)\|\s*(.*?)\|\s*(.*?)\|\s*(.*?)\]/gi, (match, model, inputTokens, outputTokens, cost) => {
    const m = model.trim();
    const i = inputTokens.trim();
    const o = outputTokens.trim();
    const c = cost.trim();
    return `<a href="tg://btn_info_footer|${m}|${i}|${o}|${c}">⚙️ ${m} · In: ${i} · Out: ${o} · Cost: ${c}</a>`;
  });

  return html;
}

function renderThoughtBlockToHtml(
  content: string,
  isClosed: boolean,
  isStreaming: boolean,
  time?: string,
  tokens?: string,
  nonThoughtHtmlLength = 0
): string {
  const isOpen = isStreaming || !isClosed;
  const detailsTag = isOpen ? '<details open>' : '<details>';
  
  let finalContent = trimHtmlBr(markdownToHtmlSnippet(content));
  const maxThoughtLength = Math.max(200, 3900 - nonThoughtHtmlLength);
  const { sliced, wasTruncated } = safeHtmlSlice(finalContent, maxThoughtLength);
  finalContent = sliced;
  if (wasTruncated) {
    finalContent += '\n\n……（已省略后续内容，超长思考摘要已被截断）';
  }

  const innerHtml = finalContent;

  let summary = '🧠 思考过程 (Thinking Process)';
  let infoBlock = '';

  if (time !== undefined || tokens !== undefined) {
    summary = formatSummaryWithMetadata(time, tokens, isOpen && !isClosed);
    const infoLines: string[] = [];
    if (time && Number(time) > 0) {
      infoLines.push(`Thinking Time: ${time} s`);
    }
    if (tokens && Number(tokens) > 0) {
      infoLines.push(`Thinking Tokens: ${tokens}`);
    }
    if (infoLines.length > 0) {
      infoBlock = `<i>${infoLines.join('\n')}</i>\n\n`;
    }
  } else {
    summary = isClosed ? '🧠 思考过程 (Thinking Process)' : '🧠 正在思考... (Thinking...)';
  }

  return `${detailsTag}<summary>${summary}</summary>${infoBlock}<i>${innerHtml}</i></details>`;
}

export function normalizeSpacingAroundDetails(html: string): string {
  let processed = html.replace(/(?:(?:\s|<br\s*\/?>|<p>|<\/p>)*)(<details(?:\s+open)?>)/gi, (match, details) => {
    return `<br><br>${details}`;
  });
  processed = processed.replace(/(<\/details>)(?:(?:\s|<br\s*\/?>|<p>|<\/p>)*)/gi, (match, details) => {
    return `${details}<br><br>`;
  });
  
  // Trim first to handle leading/trailing whitespace before checking boundaries
  processed = processed.trim();
  
  // Clean up boundaries
  while (processed.startsWith('<br>') || processed.startsWith('<br/>') || processed.startsWith('<br />')) {
    if (processed.startsWith('<br>')) processed = processed.substring(4).trim();
    else if (processed.startsWith('<br/>')) processed = processed.substring(5).trim();
    else if (processed.startsWith('<br />')) processed = processed.substring(6).trim();
  }
  while (processed.endsWith('<br>') || processed.endsWith('<br/>') || processed.endsWith('<br />')) {
    if (processed.endsWith('<br>')) processed = processed.substring(0, processed.length - 4).trim();
    else if (processed.endsWith('<br/>')) processed = processed.substring(0, processed.length - 5).trim();
    else if (processed.endsWith('<br />')) processed = processed.substring(0, processed.length - 6).trim();
  }
  return processed;
}

export function markdownToHtml(input: string | StructuredMessage, isStreaming = false): string {
  if (input && typeof input === 'object') {
    const contentHtml = markdownToHtmlSnippet(input.content);
    let html = contentHtml;
    if (input.thought && input.thought.trim()) {
      const thoughtHtml = renderThoughtBlockToHtml(
        input.thought.trim(),
        !isStreaming,
        isStreaming,
        input.geminiTime,
        input.geminiTokens
      );
      if (contentHtml.trim()) {
        html = `${contentHtml.trim()}<br><br>${thoughtHtml}`;
      } else {
        html = thoughtHtml;
      }
    }
    html = normalizeSpacingAroundDetails(html);
    html = convertMath(html);
    html = convertNewlines(html);
    return html;
  } else {
    let html = '';
    const parseResult = extractThoughtBlocksAndSegments(input);
    
    let nonThoughtHtmlLength = 0;
    for (const segment of parseResult.segments) {
      if (segment.type === 'text') {
        nonThoughtHtmlLength += markdownToHtmlSnippet(segment.value).length;
      }
    }

    for (const segment of parseResult.segments) {
      if (segment.type === 'text') {
        html += markdownToHtmlSnippet(segment.value);
      } else {
        const block = segment.block!;
        const blockHtml = renderThoughtBlockToHtml(
          segment.value,
          block.isClosed,
          isStreaming,
          block.time,
          block.tokens,
          nonThoughtHtmlLength
        );
        html += blockHtml;
      }
    }

    html = normalizeSpacingAroundDetails(html);
    html = convertMath(html);
    html = convertNewlines(html);
    return html;
  }
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

function convertMath(html: string): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/gi);
  return parts.map(part => {
    if (/^<pre/i.test(part.trim())) return part;
    let content = part;
    content = content.replace(/\$\$([\s\S]+?)\$\$/g, '<tg-math-block>$1</tg-math-block>');
    content = content.replace(/\$([^\s$](?:[^$\n\r]*?[^\s$])?)\$/g, '<tg-math>$1</tg-math>');
    return content;
  }).join('');
}

function convertNewlines(html: string): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<table[\s\S]*?<\/table>|<tg-math-block[\s\S]*?<\/tg-math-block>)/gi);
  return parts.map(part => {
    if (/^<(pre|table|tg-math-block)/i.test(part.trim())) return part;
    let content = part;
    content = content.replace(/\n/g, '<br>');
    return content;
  }).join('');
}

