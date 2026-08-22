/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file markdownNormalize.ts
 * @description Pre-parse markdown normalizers for LLM output (extracted from
 * core.ts): fence isolation/closing, nested-fence backtick upgrades, and
 * structural fixes (list spacing, checklists, details prompts, headings,
 * horizontal rules, LaTeX delimiters, Gemini Web XML components).
 */

export function normalizeMarkdownFences(markdown: string): string {
  if (!markdown) return markdown;
  const inputLines = markdown.split('\n');
  // 1. Split code fences glued to preceding inline text (e.g. "代码```python")
  //    onto their own line so markdown-it parses them as a real fence. Track
  //    which fence fragments came from such inline splits so we can demote
  //    them back to literal text when the fence is never closed (the model was
  //    merely quoting "```" in prose, e.g. "I'll use ``` fences for code.",
  //    not opening a code block).
  const inlineFenceFragments = new Set<string>();
  const splitLines: string[] = [];
  for (const line of inputLines) {
    splitLines.push(line.replace(/(^|.+?)(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)/g, (match, before, fence, info) => {
      if (/[^ \t>]/.test(before)) {
        inlineFenceFragments.add(fence + info);
        return before + '\n' + fence + info;
      }
      return match;
    }));
  }
  let text = splitLines.join('\n');
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
  let openFenceChar = '';
  let openFenceOutIdx = -1;
  let openFenceIsInlineSplit = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(fenceRe);
    const isFence = !!fenceMatch;
    if (isFence) {
      const backtickCount = fenceMatch![2].length;
      if (openFenceBackticks === 0) {
        // Not inside a fence — this is a real fence opener
        const core = fenceMatch![2] + (fenceMatch![3] ?? '');
        openFenceBackticks = backtickCount;
        openFenceChar = fenceMatch![2];
        openFenceIsInlineSplit = inlineFenceFragments.has(core);
        if (!prevWasBlank) {
          out.push('');
          prevWasBlank = true;
        }
        out.push(line);
        openFenceOutIdx = out.length - 1;
        if (i + 1 < lines.length && lines[i + 1].trim() !== '' && !fenceRe.test(lines[i + 1])) {
          out.push('');
          prevWasBlank = true;
        } else {
          prevWasBlank = line.trim() === '';
        }
      } else if (backtickCount >= openFenceBackticks) {
        // Closing fence: same or more backticks than opener
        openFenceBackticks = 0;
        openFenceOutIdx = -1;
        openFenceIsInlineSplit = false;
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
  // 3. Handle fences left unclosed.
  if (openFenceBackticks !== 0) {
    if (openFenceIsInlineSplit && openFenceOutIdx >= 0) {
      // The model quoted "```" in prose without ever closing it — demote the
      // opener to literal text so the rest of the message renders as normal
      // content instead of one giant code block swallowing the remainder.
      out[openFenceOutIdx] = out[openFenceOutIdx].replace(/([`~])/g, '\\$1');
    } else {
      // Standalone truncated code block: close it explicitly so downstream
      // processing sees a balanced fence (content before the close stays code).
      if (out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
      out.push(openFenceChar);
    }
  }
  // 4. Collapse excessive blank lines.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Upgrade the backtick count of nested code fences so markdown-it parses them
 * as properly nested blocks instead of treating the inner opening fence as the
 * closing fence of the outer block. Per CommonMark (sec 4.5), a closing fence
 * must be at least as long as the opening one; when inner content opens a
 * fence of equal-or-greater length, the outer fence counts are raised so the
 * nesting stays well-formed.
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

/**
 * Fix common markdown structural mistakes produced by LLM output so that
 * markdown-it renders them as intended:
 *  - Ordered-list items missing a space after the dot (e.g. `1.第一阶段`).
 *  - GFM checklist markers normalized into clean `- [x]` / `- [ ]` items.
 *  - Model-emitted collapsible prompts (`点击展开…` / `▶` / `▼`) followed by a
 *    blockquote converted into native `> [details]` containers.
 *  - ATX headings without a space after the hashes (e.g. `###1. 标题`,
 *    `#### 3.1 标题`) are not recognized as headings by the parser; insert the
 *    missing space so they become real headings.
 *  - A horizontal rule `---` on its own line that is missing surrounding blank
 *    lines (so it merges with adjacent text instead of becoming an `<hr>`) is
 *    given the blank lines it needs to be recognized as a separator.
 *  - LaTeX \[...\] / \(...\) delimiters converted into the LATEX* markers used
 *    by both the HTML and RichBlocks paths.
 */
export function normalizeMarkdownStructure(markdown: string): string {
  if (!markdown) return markdown;
  markdown = normalizeNestedCodeFences(markdown);

  // Convert raw `<details>...<summary>...</summary>...</details>` HTML that models
  // emit (e.g. the Telegram Bot API 10.2 rich-text renderer) into a
  // `> [details] Summary\n> body` blockquote so BOTH the blocks path
  // (blockquote_open → native details block) and the HTML path (html.ts
  // `[details]` detection) render a native Telegram <details> element.
  markdown = markdown.replace(/<details(?:\s+open)?>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (m, summaryHtml, bodyHtml) => {
    const summary = summaryHtml.replace(/<[^>]*>/g, '').trim() || 'Click to expand';
    const body = bodyHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .trim();
    const quotedBody = body.split('\n').map((line: string) => `> ${line.trim()}`).join('\n');
    return `> [details] ${summary}\n${quotedBody}`;
  });

  // Gemini Web2API / Web UI components normalization:
  // 1. Remove GenerateWidget blocks (interactive Canvas micro-app JSON specs not renderable in chat)
  markdown = markdown.replace(/<GenerateWidget[^>]*>[\s\S]*?<\/GenerateWidget>/gi, '');

  // 2. Transform Timeline & TimelineEvent into structured markdown headings + body
  markdown = markdown.replace(/<TimelineEvent(?:\s+[^>]*)?>([\s\S]*?)<\/TimelineEvent>/gi, (m, body) => {
    const timeMatch = m.match(/\btime="([^"]*)"/i);
    const titleMatch = m.match(/\btitle="([^"]*)"/i);
    const time = timeMatch ? timeMatch[1].trim() : '';
    const title = titleMatch ? titleMatch[1].trim() : '';
    const header = [time, title].filter(Boolean).join(' · ');
    const headerPrefix = header ? `\n\n#### 📅 ${header}\n` : '\n\n';
    return `${headerPrefix}${body.trim()}\n\n`;
  });
  markdown = markdown.replace(/<\/?Timeline>/gi, '');

  // 3. Transform Elicitations into suggested questions list
  const elicitations: string[] = [];
  const elicitationRe = /<Elicitation\s+[^>]*\blabel="([^"]*)"[^>]*\/?>/gi;
  let em: RegExpExecArray | null;
  while ((em = elicitationRe.exec(markdown)) !== null) {
    const label = em[1].trim();
    if (label) elicitations.push(label);
  }
  markdown = markdown.replace(/<ElicitationsGroup>[\s\S]*?<\/ElicitationsGroup>/gi, '');
  markdown = markdown.replace(/<Elicitation[^>]*\/?>/gi, '');
  markdown = markdown.replace(/<\/?ElicitationsGroup>/gi, '');

  if (elicitations.length > 0) {
    markdown = markdown.trim() + '\n\n---\n\n💡 **相关推荐与延伸探讨：**\n' + elicitations.map((label) => `• **${label}**`).join('\n');
  }

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
    const fenceMatch = line.match(/^([ \t]*)(?:> ?)?(`{3,}|~{3,})(.*)$/);

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

  // Protect inline code spans (`...`) with placeholders so the line-level
  // normalizations below (heading spacing, HR isolation, bullet splitting)
  // never mangle markdown syntax quoted inside backticks — e.g. a reasoning
  // trace saying "use `# 标题`" or "use `---`" must stay literal inline code,
  // not become a real heading / horizontal rule.
  const inlineCodeSpans: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (match) => {
    inlineCodeSpans.push(match);
    return `__INLINE_CODE_PLACEHOLDER_${inlineCodeSpans.length - 1}__`;
  });

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
  text = text.replace(/^([ \t]*(?:点击展开|Click to expand|▶|▼|\[details\])[^\n]*)\n+[ \t]*>\s*([^\n]+)/gm, (match, summaryLine, firstQuoteLine) => {
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
  // Restore protected inline code spans (after code blocks so their content
  // can never be mistaken for a code-block placeholder).
  text = text.replace(/__INLINE_CODE_PLACEHOLDER_(\d+)__/g, (_, idx) => inlineCodeSpans[parseInt(idx, 10)]);

  return text;
}
