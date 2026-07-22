/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file html.ts
 * @description Telegram HTML message formatting, chunking, splitting, and conversion.
 * Handles HTML tokenization, block splitting (details, pre, table, math_block),
 * IR→HTML rendering, and the full markdown-to-HTML pipeline.
 */

import type { MessageFormatter, StructuredMessage } from '../../../core/types.js';
import { extractThoughtBlocksAndSegments } from '../../../agy/agyCli.js';
import {
  TELEGRAM_HTML_MAX_LENGTH,
  markdownToIR,
  renderIRToHtml,
  safeHtmlSlice,
  findSafeCutPoint,
  trimHtmlBr,
  normalizeMarkdownFences,
  formatSummaryWithMetadata,
} from './core.js';

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
      tokens.push({ type: 'text', value: subPart.replace(/<(?!\/?br\s*\/?>|!\[CDATA\[|!--)/gi, '&lt;') });
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
      return chunkAnswerBody(htmlText, TELEGRAM_HTML_MAX_LENGTH).map(c => '___RAW_HTML___' + c);
    }
    if (text.length <= TELEGRAM_HTML_MAX_LENGTH) {
      return [text];
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= TELEGRAM_HTML_MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', TELEGRAM_HTML_MAX_LENGTH);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', TELEGRAM_HTML_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        splitAt = TELEGRAM_HTML_MAX_LENGTH;
      }
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  },

  truncateForEdit(text: string): string {
    if (text.length <= TELEGRAM_HTML_MAX_LENGTH) {
      return text;
    }
    return text.substring(0, TELEGRAM_HTML_MAX_LENGTH - 4) + '\n...';
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
    if (text.length <= TELEGRAM_HTML_MAX_LENGTH) {
      return text;
    }
    const headLen = 1600;
    const tailLen = TELEGRAM_HTML_MAX_LENGTH - headLen - 60;
    const head = text.substring(0, headLen);
    const tail = text.substring(text.length - tailLen);
    const omitted = text.length - headLen - tailLen;
    return `${head}\n\n︙ …（中间省略约 ${omitted} 字，生成中）… ︙\n\n${tail}`;
  },

  findSafeCutPoint(markdown: string, maxLen: number): number {
    return findSafeCutPoint(markdown, maxLen);
  },
};


function markdownToHtmlSnippet(markdown: string): string {
  const normalized = normalizeMarkdownFences(markdown);
  const ir = markdownToIR(normalized, true);
  let html = renderIRToHtml(ir);

  if (ir.tables && ir.tables.length > 0) {
    for (let idx = 0; idx < ir.tables.length; idx++) {
      html = html.replace(`___TELEGRAM_TABLE_PLACEHOLDER_${idx}___`, ir.tables[idx]);
    }
  }

  // Unescape native Telegram Bot API 10.2 HTML tags (<details>, <summary>, <aside>, <tg-thinking>, etc.)
  // that were escaped by markdown-it when html: false was set.
  html = html
    .replace(/&lt;details(\s+open)?&gt;/gi, '<details$1>')
    .replace(/&lt;\/details&gt;/gi, '</details>')
    .replace(/&lt;summary&gt;/gi, '<summary>')
    .replace(/&lt;\/summary&gt;/gi, '</summary>')
    .replace(/&lt;aside&gt;/gi, '<aside>')
    .replace(/&lt;\/aside&gt;/gi, '</aside>')
    .replace(/&lt;tg-thinking&gt;/gi, '<tg-thinking>')
    .replace(/&lt;\/tg-thinking&gt;/gi, '</tg-thinking>')
    .replace(/&lt;tg-math(-block)?&gt;/gi, '<tg-math$1>')
    .replace(/&lt;\/tg-math(-block)?&gt;/gi, '</tg-math$1>')
    .replace(/&lt;kbd&gt;/gi, '<kbd>')
    .replace(/&lt;\/kbd&gt;/gi, '</kbd>')
    .replace(/&lt;u&gt;/gi, '<u>')
    .replace(/&lt;\/u&gt;/gi, '</u>');

  html = html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (fullMatch, innerContent) => {
    if (/\[details\]/i.test(innerContent)) {
      const detailsMatch = innerContent.match(/\[details\]\s*([^\n<]*)(?:<br\s*\/?>|\n)?([\s\S]*)/i);
      if (detailsMatch) {
        const summary = detailsMatch[1].trim() || '点击展开';
        const content = detailsMatch[2].replace(/<\/?blockquote>/gi, '').trim();
        return `<details><summary>${summary}</summary>${content}</details>`;
      }
    }
    return fullMatch;
  });

  // Ensure <details> and <blockquote> are never directly nested per Telegram Bot API spec.
  html = html.replace(/<details(\s+open)?>([\s\S]*?)<\/details>/gi, (match, openAttr, inner) => {
    const cleanInner = inner.replace(/(?:<\/blockquote>|<blockquote[^>]*>|&lt;\/?blockquote&gt;)/gi, '');
    return `<details${openAttr || ''}>${cleanInner}</details>`;
  });

  // Strip auto-linked filenames (e.g. user.py, formatter.py, README.md) generated by markdown-it linkify
  // when the link text is a filename rather than an explicit http(s) URL.
  html = html.replace(/<a\s+href="http:\/\/(.*?)"\s*>([^<]+)<\/a>/gi, (match, url, text) => {
    if (/\.(py|md|js|ts|json|yml|yaml|css|html|cpp|h|c|go|rs|java|sh)$/i.test(text) && !/^https?:\/\//i.test(text) && !/^www\./i.test(text)) {
      return text;
    }
    return match;
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
    summary = formatSummaryWithMetadata(time, tokens, isOpen);
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
    summary = isOpen ? '🧠 正在思考... (Thinking...)' : '🧠 思考过程 (Thinking Process)';
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
        html = `${thoughtHtml}<br><br>${contentHtml.trim()}`;
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
