/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import type { MessageFormatter, StructuredMessage } from '../../core/types.js';
import type { RichBlock } from './richMessage.js';
import type { RichText } from '@grammyjs/types/rich.js';
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
  const tokens: HtmlToken[] = [];
  let index = 0;
  
  const tagStartRegex = /<(details|pre|table|tg-math-block|blockquote)([\s>])/gi;
  
  while (index < htmlText.length) {
    tagStartRegex.lastIndex = index;
    const match = tagStartRegex.exec(htmlText);
    
    if (!match) {
      const remaining = htmlText.substring(index);
      if (remaining) {
        pushTextTokens(remaining, tokens);
      }
      break;
    }
    
    const matchStart = match.index;
    const tagName = match[1].toLowerCase();
    
    if (matchStart > index) {
      pushTextTokens(htmlText.substring(index, matchStart), tokens);
    }
    
    let depth = 1;
    let scanIndex = matchStart + match[0].length;
    const tagPairRegex = new RegExp(`<(/)?${tagName}([\\s>])`, 'gi');
    
    while (depth > 0 && scanIndex < htmlText.length) {
      tagPairRegex.lastIndex = scanIndex;
      const pairMatch = tagPairRegex.exec(htmlText);
      if (!pairMatch) {
        scanIndex = htmlText.length;
        break;
      }
      
      const isClose = !!pairMatch[1];
      if (isClose) {
        depth--;
      } else {
        depth++;
      }
      scanIndex = pairMatch.index + pairMatch[0].length;
    }
    
    const blockValue = htmlText.substring(matchStart, scanIndex);
    const typeMap: Record<string, HtmlToken['type']> = {
      details: 'details',
      pre: 'pre',
      table: 'table',
      'tg-math-block': 'math_block',
      blockquote: 'blockquote'
    };
    tokens.push({ type: typeMap[tagName] || 'text', value: blockValue });
    index = scanIndex;
  }
  
  return tokens;
}

function pushTextTokens(text: string, tokens: HtmlToken[]) {
  const subParts = text.split(/(<br\s*\/?>\s*<br\s*\/?>|<br\s*\/?>)/gi);
  for (const subPart of subParts) {
    if (!subPart) continue;
    if (subPart.toLowerCase().startsWith('<br')) {
      tokens.push({ type: 'break', value: subPart });
    } else {
      tokens.push({ type: 'text', value: subPart });
    }
  }
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
  const baseLen = preStart.length + preEnd.length;
  const lineMaxLength = maxLength - baseLen;
  
  const lines = content.split('\n');
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentChunkLen = 0;
  
  for (const line of lines) {
    if (line.length > lineMaxLength) {
      if (currentLines.length > 0) {
        chunks.push(preStart + currentLines.join('\n') + preEnd);
        currentLines = [];
        currentChunkLen = 0;
      }
      let lineIdx = 0;
      while (lineIdx < line.length) {
        const take = Math.min(lineMaxLength, line.length - lineIdx);
        const slice = line.substring(lineIdx, lineIdx + take);
        chunks.push(preStart + slice + preEnd);
        lineIdx += take;
      }
    } else {
      if (currentChunkLen + line.length + (currentLines.length > 0 ? 1 : 0) > lineMaxLength) {
        chunks.push(preStart + currentLines.join('\n') + preEnd);
        currentLines = [line];
        currentChunkLen = line.length;
      } else {
        currentLines.push(line);
        currentChunkLen += line.length + (currentLines.length > 1 ? 1 : 0);
      }
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
  const trRegex = /<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi;
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
      // Safety: if a sub-chunk still exceeds the limit (e.g. an unhandled token
      // type), fall back to tag-aware text splitting so we never emit a message
      // over Telegram's ~4096 char cap (which would otherwise get truncated
      // mid-tag, breaking rendering).
      if (subChunks.some((c) => c.length > maxLength)) {
        chunks.length = 0;
        for (const sub of splitTextWithOpenTags(val, maxLength)) {
          chunks.push(sub);
        }
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

  /**
   * Streaming-only truncation. Telegram caps a single message (incl. a draft)
   * at ~4096 chars, so the live draft cannot grow past that. Instead of freezing
   * on the head (first 4096) and hiding everything after, we show a sliding
   * window: the opening of the answer (so the title/structure stays visible)
   * plus the most recently generated text (the live writing frontier), with a
   * short marker in between. The full, correct message replaces this at finalize.
   */
  truncateForStream(text: string): string {
    if (text.length <= TELEGRAM_MAX_LENGTH) {
      return text;
    }
    const headLen = 1600;
    const tailLen = TELEGRAM_MAX_LENGTH - headLen - 60;
    const head = text.substring(0, headLen);
    const tail = text.substring(text.length - tailLen);
    const omitted = text.length - headLen - tailLen;
    return `${head}\n\n︙ …（中间省略约 ${omitted} 字，生成中）… ︙\n\n${tail}`;
  },

  findSafeCutPoint(markdown: string, maxLen: number): number {
    return findSafeCutPoint(markdown, maxLen);
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

// Treat CJK characters as emphasis boundaries so that `**加粗**` and
// `**“中文”**` adjacent to CJK text/punctuation render correctly (CommonMark
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

export function normalizeMarkdownFences(markdown: string): string {
  if (!markdown) return markdown;
  // 1. Split a fence delimiter that is glued to text on the same line onto its
  //    own line, in both directions:
  //    - opener glued to preceding text: `正文```python` -> `正文\n```python`
  //    - closing fence glued to following text: `code```后面` -> `code\n```\n后面`
  let text = markdown.replace(/(^|[^`\n])```([a-zA-Z0-9_+#.-]*)/g, '$1\n```$2');
  text = text.replace(/```([a-zA-Z0-9_+#.-]*)\n?([^\n`])/g, '```$1\n$2');
  // 2. Isolate every fence delimiter (a line that is only ``` + optional lang)
  //    with blank lines so markdown-it parses it as a real fence instead of
  //    leaving raw ``` (which Telegram renders as one giant code block).
  const lines = text.split('\n');
  const fenceRe = /^(\s*)```([a-zA-Z0-9_+#.-]*)?\s*$/;
  const out: string[] = [];
  let prevWasBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFence = fenceRe.test(line);
    if (isFence) {
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
export function normalizeMarkdownStructure(markdown: string): string {
  if (!markdown) return markdown;
  let text = markdown;
  // `###1.` / `## 2.1` already spaced is fine; fix `###1.`, `#### 3.1`,
  // `##标题` where the hash run is immediately followed by a non-space char.
  text = text.replace(/^(#{1,6})(?=[^\s#>])/gm, '$1 ');
  // Horizontal rules `---` / `———` emitted by the model are often glued to the
  // surrounding text (e.g. `正文---### 4.` or `---` without blank lines), so
  // markdown-it does not treat them as <hr>. Only lines that consist solely of
  // the separator (with optional surrounding whitespace) are normalized, and a
  // separator glued to a heading on the same line is split onto its own line.
  // This avoids touching `---` that appears inside words or code.
  text = text.replace(/(\n|^)([ \t]*---[ \t]*|[ \t]*———[ \t]*)(?=\n|#|$)/g, '$1\n\n$2\n\n');
  text = text.replace(/([^\n#])(---|———)(?=\s*#)/g, '$1\n\n$2\n\n');
  // A heading (`#`..`######` + space) glued to the end of the previous line
  // (e.g. `## 1. 范式转移...AGI）### 1.1 大模型...`) is not recognized by the
  // parser because the `#` is not at line start. Split it onto its own line so
  // it renders as a real sub-heading instead of being swallowed into the prior
  // heading's text.
  text = text.replace(/([^\n\s#])(#{1,6}\s+[^\n]+)/g, '$1\n$2');
  // Collapse the excessive blank lines we may have introduced.
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

function markdownToHtmlSnippet(markdown: string): string {
  const normalized = normalizeMarkdownFences(markdown);
  const ir = markdownToIR(normalized, true);
  let html = renderIRToHtml(ir);

  if (ir.tables && ir.tables.length > 0) {
    for (let idx = 0; idx < ir.tables.length; idx++) {
      html = html.replace(`___TELEGRAM_TABLE_PLACEHOLDER_${idx}___`, ir.tables[idx]);
    }
  }

  html = html.replace(/<blockquote>([\s\S]*?)\[details\]\s*([^\n<]*)(?:<br\s*\/?>|\n)?([\s\S]*?)<\/blockquote>/gi, (match, p1, p2, p3) => {
    const summary = p2.trim() || '点击展开';
    const cleanContent = p3.replace(/<\/?blockquote>/gi, '').trim();
    return `<details><summary>${summary}</summary>${cleanContent}</details>`;
  });

  html = html.replace(/\[footer:\s*(.*?)\|\s*(.*?)\|\s*(.*?)\|\s*(.*?)(?:\s*\|\s*(.*?)\|\s*(.*?))?\]/gi, (match, model, inputTokens, outputTokens, cost, cachedTokens, thinkingTokens) => {
    const m = model.trim();
    const i = inputTokens.trim();
    const o = outputTokens.trim();
    const c = cost.trim();
    const cached = cachedTokens ? cachedTokens.trim() : '';
    const thinking = thinkingTokens ? thinkingTokens.trim() : '';

    let inStr = i;
    if (cached && cached !== '0') {
      inStr += ` (Cached: ${cached})`;
    }
    let outStr = o;
    if (thinking && thinking !== '0') {
      outStr += ` (Reasoning: ${thinking})`;
    }

    const extra = (cached || thinking) ? `|${cached || '0'}|${thinking || '0'}` : '';
    const callbackData = `${m}|${i}|${o}|${c}${extra}`;
    return `<a href="tg://btn_info_footer|${callbackData}">⚙️ ${m} · In: ${inStr} · Out: ${outStr} · Cost: ${c}</a>`;
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
  if (isStreaming) {
    const maxThoughtLength = Math.max(200, 3900 - nonThoughtHtmlLength);
    const { sliced, wasTruncated } = safeHtmlSlice(finalContent, maxThoughtLength);
    finalContent = sliced;
    if (wasTruncated) {
      finalContent += '\n\n……（已省略后续内容，超长思考摘要已被截断）';
    }
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

  return `${detailsTag}<summary>${summary}</summary>${infoBlock}${innerHtml}</details>`;
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

// ── Rich Text Blocks (Bot API 10.2) ──

type RichTextEntity =
  | { type: 'bold'; text: RichText }
  | { type: 'italic'; text: RichText }
  | { type: 'strikethrough'; text: RichText }
  | { type: 'spoiler'; text: RichText }
  | { type: 'code'; text: RichText }
  | { type: 'url'; text: string; url: string };

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

function inlineToRichText(inlineTokens: MarkdownToken[] | null | undefined): RichText {
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

  const pushPlain = (s: string) => {
    // Convert $...$ (inline) and $$...$$ (block) LaTeX into native
    // mathematical_expression RichText entities so formulas render natively.
    const mathRe = /\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^$\n\r]*?[^\s$])?)\$/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = mathRe.exec(s)) !== null) {
      if (m.index > last) textBuf.push(s.slice(last, m.index));
      const expr = (m[1] ?? m[2]).trim();
      if (expr) out.push({ type: 'mathematical_expression', expression: expr });
      last = m.index + m[0].length;
    }
    if (last < s.length) textBuf.push(s.slice(last));
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
      case 'strikethrough': node = { type: 'strikethrough', text: inner }; break;
      case 'spoiler': node = { type: 'spoiler', text: inner }; break;
      case 'code': node = { type: 'code', text: inner }; break;
      case 'url': node = { type: 'url', text: String(inner).replace(/\n/g, ' '), url: top.href ?? '' }; break;
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
          open('url', href);
          break;
        }
        case 'link_close': close('url'); break;
        case 'image':
          // Best-effort: represent image alt text as plain text.
          pushPlain(token.content ?? '');
          break;
        default:
          if (token.children) walk(token.children);
          break;
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
    return { block: { type: 'anchor', name: anchorMatch[1] }, advance: 1 };
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

export function markdownToRichBlocks(markdown: string): RichBlock[] {
  const tokens = md.parse(markdown ?? '', {}) as any as MarkdownToken[];
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
          const text = trimRichText(inlineToRichText(inline.children));
          if (text) {
            blocks.push({ type: 'heading', size: level as 1 | 2 | 3 | 4 | 5 | 6, text });
          }
          i += 2;
        }
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') {
          const text = trimRichText(inlineToRichText(inline.children));
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
        // Telegram does NOT allow blockquote nested inside details.
        // Render as plain paragraphs instead to avoid nesting conflicts.
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== 'blockquote_close') {
          if (tokens[j].type === 'inline' && tokens[j].children) {
            const rt = trimRichText(inlineToRichText(tokens[j].children));
            if (rt) blocks.push({ type: 'paragraph', text: rt });
          }
          j++;
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
        const items: Array<{ blocks: RichBlock[] }> = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type !== (token.type.replace('open', 'close'))) {
          if (tokens[j].type === 'list_item_open') {
            let k = j + 1;
            const itemInner: RichText[] = [];
            while (k < tokens.length && tokens[k].type !== 'list_item_close') {
              if (tokens[k].type === 'inline' && tokens[k].children) {
                const rt = trimRichText(inlineToRichText(tokens[k].children));
                if (rt) itemInner.push(rt);
              }
              k++;
            }
            if (itemInner.length > 0) {
              items.push({ blocks: itemInner.map((rt) => ({ type: 'paragraph', text: rt })) });
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
            const text = inline?.type === 'inline' ? trimRichText(inlineToRichText(inline.children)) : '';
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

  if (blocks.length === 0 && markdown && markdown.trim()) {
    blocks.push({ type: 'paragraph', text: markdown.trim() });
  }

  return blocks;
}

/**
 * Incremental body converter for the append-only streaming state machine.
 *
 * Given the body markdown converted so far (`alreadyConverted`) and the full
 * current body markdown (`full`), it converts only the *new* tail into native
 * 10.2 blocks and returns them. The split point is chosen at the last
 * double-newline in the overlap region so we never cut a block (paragraph /
 * list / table / fence) in half — a half-converted block would otherwise
 * briefly render as literal text before the next tick completes it.
 *
 * This keeps the body region of the message strictly append-only: each tick we
 * only PUSH new blocks computed from bytes not seen before, never rebuild or
 * reorder the existing ones.
 */
export function markdownToRichBlocksDelta(
  alreadyConverted: string,
  full: string,
): RichBlock[] {
  if (!full || full.length <= alreadyConverted.length) return [];
  if (alreadyConverted.length === 0) {
    return markdownToRichBlocks(full);
  }
  // Find a safe cut in the overlap (the last blank line before the end of the
  // already-converted portion) so we re-convert from a block boundary.
  const overlap = full.slice(0, alreadyConverted.length);
  const cut = overlap.lastIndexOf('\n\n');
  const safe = cut < 0 ? alreadyConverted.length : cut;
  const delta = full.slice(safe).replace(/^\n+/, '');
  if (!delta.trim()) return [];
  return markdownToRichBlocks(delta);
}

/**
 * Build the 10.2 `InputRichMessage.blocks` payload for a StructuredMessage.
 *
 * - Body markdown is converted to native blocks.
 * - The thinking/thought text (if any) is appended as a native collapsible
 *   `details` block ("🧠 思考过程") at the END of the message, matching the
 *   existing UX decision. Optional time/tokens metadata is shown in the summary.
 *
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

  // Extract first heading to hoist above thinking block
  let mainHeading: RichBlock | undefined;
  if (body.length > 0 && body[0].type === 'heading') {
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

    blocks.push({
      type: 'details',
      summary,
      blocks: [{ type: 'paragraph', text: thoughtText }],
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
 * Build blocks for a streaming draft. While the model is still thinking we emit
 * a native `thinking` placeholder block (Bot API 10.2, draft-only). Once the body
 * starts arriving, the thinking block is omitted and body blocks are streamed.
 */
export function buildStreamingBlocks(
  content: string,
  hasThought: boolean,
  isStreaming: boolean,
): RichBlock[] {
  const body = markdownToRichBlocks(content);
  if (isStreaming && hasThought && body.length === 0) {
    return [{ type: 'thinking', text: '正在思考...' }];
  }
  return body;
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
export function buildNativeFooterBlocks(opts: {
  model?: string;
  inputTokens?: string | number;
  outputTokens?: string | number;
  cost?: string;
  cachedTokens?: string | number;
  thinkingTokens?: string | number;
  thought?: string;
}): RichBlock[] {
  const blocks: RichBlock[] = [];

  const thoughtText = (opts.thought ?? '').trim();
  if (thoughtText) {
    blocks.push({
      type: 'details',
      summary: '🧠 思考过程 (Thinking Process)',
      blocks: [{ type: 'paragraph', text: thoughtText }],
    });
  }

  const parts: string[] = [];
  if (opts.model) parts.push(opts.model);
  const inStr = opts.inputTokens !== undefined ? String(opts.inputTokens) : '';
  const outStr = opts.outputTokens !== undefined ? String(opts.outputTokens) : '';
  if (inStr || outStr) {
    parts.push(`In: ${inStr}${opts.cachedTokens ? ` (Cached: ${opts.cachedTokens})` : ''} · Out: ${outStr}${opts.thinkingTokens ? ` (Reasoning: ${opts.thinkingTokens})` : ''}`);
  }
  if (opts.cost) parts.push(`Cost: ${opts.cost}`);
  if (parts.length > 0) {
    blocks.push({ type: 'footer', text: `⚙️ ${parts.join(' · ')}` });
  }

  return blocks;
}

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
    // Strip the trailing stats line if it was appended inside the details by the
    // old renderer; the native footer block carries stats separately.
    inner = inner.replace(/<i>[\s\S]*?<\/i>/gi, '');
    const text = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    if (text) {
      blocks.push({
        type: 'details',
        summary: '🧠 思考过程 (Thinking Process)',
        blocks: [{ type: 'paragraph', text }],
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

function convertMath(html: string): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/gi);
  return parts.map(part => {
    if (/^<pre/i.test(part.trim())) return part;
    let content = part;
    
    // 1. Convert custom LaTeX placeholders to Telegram math tags
    content = content.replace(/LATEXBLOCKSTART([\s\S]+?)LATEXBLOCKEND/g, '<tg-math-block>$1</tg-math-block>');
    content = content.replace(/LATEXINLINESTART([\s\S]+?)LATEXINLINEEND/g, '<tg-math>$1</tg-math>');

    // 2. Convert standard $$ ... $$ and $ ... $
    content = content.replace(/\$\$([\s\S]+?)\$\$/g, '<tg-math-block>$1</tg-math-block>');
    content = content.replace(/\$([^\s$](?:[^$\n\r]*?[^\s$])?)\$/g, '<tg-math>$1</tg-math>');

    // 3. Convert any leftover direct block or inline LaTeX delimiters
    content = content.replace(/\\\[([\s\S]+?)\\\]/g, '<tg-math-block>$1</tg-math-block>');
    content = content.replace(/\\\(([\s\S]+?)\\\)/g, '<tg-math>$1</tg-math>');
    
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

