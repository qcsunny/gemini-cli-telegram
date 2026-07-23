/**
 * @file thoughtParser.ts
 * @description Thought/reasoning tag normalization and extraction utilities.
 * Handles multiple tag variants: <thought-gemini>, <thought>, <thinking>, [thought:...], and canonical <think>.
 */

export interface ParsedBlock {
  type: 'thought' | 'thought-gemini' | 'thinking' | 'think' | 'bracket';
  startTagIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  endTagIndex: number;
  isClosed: boolean;
  time?: string;
  tokens?: string;
}

function cleanInnerText(rawText: string): string {
  let cleanedText = rawText;
  while (cleanedText && (
    cleanedText.startsWith('\ufeff') ||
    (cleanedText.charCodeAt(0) < 32 && 
     cleanedText.charCodeAt(0) !== 9 && 
     cleanedText.charCodeAt(0) !== 10 && 
     cleanedText.charCodeAt(0) !== 13)
  )) {
    cleanedText = cleanedText.slice(1);
  }
  return cleanedText;
}

function getEndTagLength(type: ParsedBlock['type']): number {
  switch (type) {
    case 'thought-gemini': return 17; // '</thought-gemini>'
    case 'thought': return 10;        // '</thought>'
    case 'thinking': return 11;       // '</thinking>'
    case 'think': return 8;           // '</think>'
    case 'bracket': return 1;          // ']'
  }
}

function startsWithIgnoreCase(str: string, index: number, prefix: string): boolean {
  if (index + prefix.length > str.length) return false;
  for (let k = 0; k < prefix.length; k++) {
    if (str[index + k].toLowerCase() !== prefix[k].toLowerCase()) {
      return false;
    }
  }
  return true;
}

function matchTag(str: string, index: number, prefix: string): boolean {
  if (!startsWithIgnoreCase(str, index, prefix)) return false;
  const nextCharIdx = index + prefix.length;
  if (nextCharIdx >= str.length) return true;
  const nextChar = str[nextCharIdx];
  return nextChar === '>' || nextChar === ' ' || nextChar === '\n' || nextChar === '\r' || nextChar === '\t';
}

/**
 * Normalize all thinking-tag variants to the canonical `<think>` / `</think>`.
 *
 * Conversion map:
 *   `<thought-gemini ...>` / `<thought ...>` / `<thinking ...>` / `[thought:`
 *   → `<think ...>`
 *   `</thought-gemini>` / `</thought>` / `</thinking>` → `</think>`
 *   `[thought:content]` → `<think>content</think>`
 *
 * Content inside ``` code fences and inline `` code is skipped.
 */
export function normalizeThinkingTags(text: string): string {
  const out: string[] = [];
  let inCodeBlock = false;
  let inInlineCode = false;
  let i = 0;

  const peek = (prefix: string): boolean => {
    if (i + prefix.length > text.length) return false;
    for (let k = 0; k < prefix.length; k++) {
      if (text[i + k].toLowerCase() !== prefix[k].toLowerCase()) return false;
    }
    return true;
  };

  const isTagBreak = (pos: number): boolean => {
    if (pos >= text.length) return true;
    const c = text[pos];
    return c === '>' || c === ' ' || c === '\n' || c === '\r' || c === '\t';
  };

  while (i < text.length) {
    // Track code fences
    if (text.startsWith('```', i)) {
      inCodeBlock = !inCodeBlock;
      out.push('```');
      i += 3;
      continue;
    }
    // Track inline code (reset at newline)
    if (text[i] === '\n') inInlineCode = false;
    if (text[i] === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      out.push('`');
      i++;
      continue;
    }
    if (inCodeBlock || inInlineCode) {
      out.push(text[i]);
      i++;
      continue;
    }

    // Closing tags
    if (peek('</thought-gemini>')) { out.push('</think>'); i += 17; continue; }
    if (peek('</thought>')) { out.push('</think>'); i += 10; continue; }
    if (peek('</thinking>')) { out.push('</think>'); i += 11; continue; }

    // Opening tags — extract attributes before converting
    // <thought-gemini time="..." tokens="...">
    if (peek('<thought-gemini')) {
      const gtIdx = text.indexOf('>', i);
      if (gtIdx !== -1) {
        const tagContent = text.slice(i, gtIdx + 1);
        const timeMatch = tagContent.match(/time=(?:"|')([^"']*?)(?:"|')/i);
        const tokensMatch = tagContent.match(/tokens=(?:"|')([^"']*?)(?:"|')/i);
        const attrs = [];
        if (timeMatch) attrs.push(`time="${timeMatch[1]}"`);
        if (tokensMatch) attrs.push(`tokens="${tokensMatch[1]}"`);
        out.push(`<think${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
        i = gtIdx + 1;
        continue;
      }
    }
    // <thought time="...">
    if (peek('<thought') && !peek('<thought-') && isTagBreak(i + 8)) {
      const gtIdx = text.indexOf('>', i);
      if (gtIdx !== -1) {
        const tagContent = text.slice(i, gtIdx + 1);
        const timeMatch = tagContent.match(/time=(?:"|')([^"']*?)(?:"|')/i);
        const attrs = [];
        if (timeMatch) attrs.push(`time="${timeMatch[1]}"`);
        out.push(`<think${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
        i = gtIdx + 1;
        continue;
      }
    }
    // <thinking ...>
    if (peek('<thinking')) {
      const gtIdx = text.indexOf('>', i);
      if (gtIdx !== -1) {
        out.push('<think>');
        i = gtIdx + 1;
        continue;
      }
    }
    // [thought:content]
    if (peek('[thought:')) {
      out.push('<think>');
      i += 9; // skip '[thought:'
      // Find closing ']'
      const closeIdx = text.indexOf(']', i);
      if (closeIdx !== -1) {
        out.push(text.slice(i, closeIdx));
        out.push('</think>');
        i = closeIdx + 1;
      } else {
        // No closing bracket — push rest as thought content
        out.push(text.slice(i));
        i = text.length;
      }
      continue;
    }

    out.push(text[i]);
    i++;
  }

  return out.join('');
}

export function extractThoughtBlocksAndSegments(text: string): {
  segments: { type: 'text' | 'thought'; value: string; block?: ParsedBlock }[];
  thought: string;
  content: string;
} {
  // Normalize all thought-tag variants to canonical <think> before parsing.
  const normalized = normalizeThinkingTags(text);

  const blocks: ParsedBlock[] = [];
  let inCodeBlock = false;
  let inInlineCode = false;
  let hasSeenNonWhitespaceContent = false;
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];
    if (char === '\n') {
      inInlineCode = false;
    }

    if (normalized.startsWith('```', i)) {
      inCodeBlock = !inCodeBlock;
      i += 3;
      hasSeenNonWhitespaceContent = true;
      continue;
    }
    if (char === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      i++;
      hasSeenNonWhitespaceContent = true;
      continue;
    }
    if (inCodeBlock || inInlineCode) {
      i++;
      hasSeenNonWhitespaceContent = true;
      continue;
    }

    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      i++;
      continue;
    }

    let matchedType: ParsedBlock['type'] | null = null;
    let matchedPrefix = '';
    let endTagStr = '';

    // Canonical <think> tag (from normalizeThinkingTags) checked FIRST.
    if (matchTag(normalized, i, '<think')) {
      matchedType = 'think';
      matchedPrefix = '<think';
      endTagStr = '</think>';
    } else if (matchTag(normalized, i, '<thought-gemini')) {
      matchedType = 'thought-gemini';
      matchedPrefix = '<thought-gemini';
      endTagStr = '</thought-gemini>';
    } else if (matchTag(normalized, i, '<thought')) {
      matchedType = 'thought';
      matchedPrefix = '<thought';
      endTagStr = '</thought>';
    } else if (matchTag(normalized, i, '<thinking')) {
      matchedType = 'thinking';
      matchedPrefix = '<thinking';
      endTagStr = '</thinking>';
    } else if (startsWithIgnoreCase(normalized, i, '[thought:')) {
      matchedType = 'bracket';
      matchedPrefix = '[thought:';
      endTagStr = ']';
    }

    if (matchedType) {
      let startTagEnd = -1;
      let contentStart = -1;
      let time: string | undefined;
      let tokens: string | undefined;

      if (matchedType === 'bracket') {
        startTagEnd = i + matchedPrefix.length;
        contentStart = startTagEnd;
      } else {
        const gtIdx = normalized.indexOf('>', i);
        if (gtIdx !== -1) {
          startTagEnd = gtIdx + 1;
          contentStart = startTagEnd;

          // Also handle 'think' for metadata extraction
          if (matchedType === 'thought-gemini' || matchedType === 'thought' || matchedType === 'thinking' || matchedType === 'think') {
            const startTagContent = normalized.slice(i + matchedPrefix.length, gtIdx);
            const timeMatch = startTagContent.match(/time=(?:"|')([^"']*?)(?:"|')/i);
            const tokensMatch = startTagContent.match(/tokens=(?:"|')([^"']*?)(?:"|')/i);
            if (timeMatch) time = timeMatch[1];
            if (tokensMatch) tokens = tokensMatch[1];
          }
        } else {
          startTagEnd = normalized.length;
          contentStart = normalized.length;
        }
      }

      let endTagIdx = -1;
      if (startTagEnd < normalized.length) {
        let tempCodeBlock = false;
        let tempInlineCode = false;
        let j = startTagEnd;
        while (j < normalized.length) {
          if (normalized[j] === '\n') {
            tempInlineCode = false;
          }
          if (normalized.startsWith('```', j)) {
            tempCodeBlock = !tempCodeBlock;
            j += 3;
            continue;
          }
          if (normalized[j] === '`' && !tempCodeBlock) {
            tempInlineCode = !tempInlineCode;
            j++;
            continue;
          }
          if (tempCodeBlock || tempInlineCode) {
            j++;
            continue;
          }
          if (startsWithIgnoreCase(normalized, j, endTagStr)) {
            endTagIdx = j;
            break;
          }
          j++;
        }
      }

      const isClosed = endTagIdx !== -1;

      if (isClosed || !hasSeenNonWhitespaceContent) {
        const contentEnd = isClosed ? endTagIdx : normalized.length;
        const endIndex = isClosed ? endTagIdx + endTagStr.length : normalized.length;
        blocks.push({
          type: matchedType,
          startTagIndex: i,
          contentStartIndex: contentStart,
          contentEndIndex: contentEnd,
          endTagIndex: endTagIdx,
          isClosed,
          time,
          tokens,
        });

        i = endIndex;
        continue;
      }
    }

    hasSeenNonWhitespaceContent = true;
    i++;
  }

  const thoughts: string[] = [];
  const segments: { type: 'text' | 'thought'; value: string; block?: ParsedBlock }[] = [];
  let cleanContent = '';
  let lastIdx = 0;

  for (const block of blocks) {
    const preText = normalized.slice(lastIdx, block.startTagIndex);
    if (preText) {
      segments.push({ type: 'text', value: preText });
      cleanContent += preText;
    }

    const rawInner = normalized.slice(block.contentStartIndex, block.contentEndIndex);
    const cleanedInner = cleanInnerText(rawInner);
    thoughts.push(cleanedInner);

    segments.push({
      type: 'thought',
      value: cleanedInner,
      block,
    });

    lastIdx = block.isClosed ? block.endTagIndex + getEndTagLength(block.type) : normalized.length;
  }

  const postText = normalized.slice(lastIdx);
  if (postText) {
    segments.push({ type: 'text', value: postText });
    cleanContent += postText;
  }

  return {
    segments,
    thought: thoughts.join('\n\n').trim(),
    content: cleanContent,
  };
}

export function extractThoughtAndContent(text: string): { 
  thought: string; 
  content: string; 
  geminiTime?: string; 
  geminiTokens?: string; 
} {
  const res = extractThoughtBlocksAndSegments(text);
  let geminiTime: string | undefined;
  let geminiTokens: string | undefined;
  for (const seg of res.segments) {
    if (seg.type === 'thought' && (seg.block?.type === 'thought-gemini' || seg.block?.type === 'think')) {
      if (seg.block.time && !geminiTime) geminiTime = seg.block.time;
      if (seg.block.tokens && !geminiTokens) geminiTokens = seg.block.tokens;
    }
  }
  return {
    thought: res.thought,
    content: res.content,
    geminiTime,
    geminiTokens,
  };
}
