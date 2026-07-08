/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { 
  markdownToHtml, 
  markdownToMarkdownV2, 
  markdownToRichBlocks, 
  telegramFormatter,
  splitTextWithOpenTags,
  splitCodeBlock,
  splitTable,
  splitDetails,
  tokenizeHtml
} from './formatter.js';

describe('Formatter Rich Message Showcase', () => {
  const showcaseMarkdown = `Rich Message Showcase ✨
Welcome to a comprehensive demo of Telegram's rich formatting!

Text Formatting
This is **bold**, this is *italic*, this is ~~strikethrough~~, and this is highlighted text. You can also use \`inline code\` and ||spoiler text|| that hides until tapped.
Subscript like H~2~O and superscript like E=mc^2^ work too.

Links & Mentions
Visit [Telegram's API Docs](https://core.telegram.org/api) for more details.

Blockquote
> "The best way to predict the future is to invent it." — Alan Kay

Math
Inline math: The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$
Block math:
$$
e^{i\\pi} + 1 = 0
$$

Code Block
\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}! 👋"

print(greet("World"))
\`\`\`

Lists
Unordered:
- Bold with **text**
- Italic with *text*
- Spoiler with ||text||

Ordered:
1. Write your message
2. Format with Markdown
3. Send it!

Task List:
- [ ] Learn Markdown
- [ ] Build a bot
- [ ] Take over the world

Table
| Feature | Syntax | Example |
| :--- | :--- | :--- |
| Bold | \`**\` | **Hello** |
| Italic | \`*\` | *Hello* |
| Code | \`\` \` \`\` | \`Hello\` |

Collapsible Section
> [details] Click to expand 👀
> This is hidden content!

Footnotes
Telegram supports Markdown formatting[^1] and HTML formatting[^2] for rich messages.

Spoiler Story
||The hero opened the door and found the treasure was a mirror all along.||

Thanks for reading! 🚀

[^1]: Markdown uses symbols like \`*\`, \`_\`, \`~\`, and more.
[^2]: HTML uses tags like \`<b>\`, \`<i>\`, \`<a>\`, and more.`;

  it('should convert showcase markdown to HTML without throwing errors', () => {
    const html = markdownToHtml(showcaseMarkdown);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    
    // Check some elements that should be rendered to HTML tags
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>italic</i>');
    expect(html).toContain('<s>strikethrough</s>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<span class="tg-spoiler">spoiler text</span>');
    expect(html).toContain('<a href="https://core.telegram.org/api">Telegram\'s API Docs</a>');
  });

  it('should convert showcase markdown to MarkdownV2 without throwing errors', () => {
    const mdV2 = markdownToMarkdownV2(showcaseMarkdown);
    expect(mdV2).toBeDefined();
    expect(typeof mdV2).toBe('string');
    
    // Check elements in MarkdownV2 representation
    expect(mdV2).toContain('*bold*');
    expect(mdV2).toContain('_italic_');
    expect(mdV2).toContain('~strikethrough~');
    expect(mdV2).toContain('`inline code`');
    expect(mdV2).toContain('||spoiler text||');
  });

  it('should convert showcase markdown to RichBlocks without throwing errors', () => {
    const blocks = markdownToRichBlocks(showcaseMarkdown);
    expect(blocks).toBeDefined();
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('should format footers with standard Telegram tags', () => {
    const input = 'This is the main response.\n\n[footer: Gemini 3.5 Flash (Medium) | 120 | 250 | $0.000084]';
    const html = markdownToHtml(input);
    expect(html).toContain('<a href="tg://btn_info_footer|Gemini 3.5 Flash (Medium)|120|250|$0.000084">⚙️ Gemini 3.5 Flash (Medium) · In: 120 · Out: 250 · Cost: $0.000084</a>');
  });

  it('should format headers with distinct visual prefixes', () => {
    const h1Html = markdownToHtml('# Header 1');
    const h2Html = markdownToHtml('## Header 2');
    const h3Html = markdownToHtml('### Header 3');
    expect(h1Html).toContain('📌 <b>Header 1</b>');
    expect(h2Html).toContain('📍 <b>Header 2</b>');
    expect(h3Html).toContain('🔹 <b>Header 3</b>');
  });

  it('should format completed thought blocks as collapsible details', () => {
    const input = 'Pre-text\n<thought>\nLet me analyze the path\n</thought>\nPost-text';
    const html = markdownToHtml(input);
    expect(html).toContain('<details><summary>🧠 思考过程 (Thinking Process)</summary><i>Let me analyze the path</i></details>');
  });

  it('should format streaming unclosed thought blocks as open details', () => {
    const input = '<thought>\nLet me analyze the path';
    const html = markdownToHtml(input);
    expect(html).toContain('<details open><summary>🧠 正在思考... (Thinking...)</summary><i>Let me analyze the path</i></details>');
  });

  it('should format unclosed thought blocks in the middle of a string as normal content, not details', () => {
    const input = 'Pre-text\n<thought>\nLet me analyze the path';
    const html = markdownToHtml(input);
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('🧠');
    expect(html).toContain('Pre-text');
    expect(html).toContain('&lt;thought&gt;');
  });

  it('should format structured messages correctly without duplication', () => {
    const input = {
      content: 'Hello, this is content.',
      thought: 'This is thinking process.',
      geminiTime: '2.5',
      geminiTokens: '1200'
    };
    const html = markdownToHtml(input as any);
    expect(html).toContain('Hello, this is content.');
    expect(html).toContain('<details><summary>🧠 Gemini Thinking · 2.5s · 1.2K</summary>');
    expect(html).toContain('Thinking Time: 2.5 s');
    expect(html).toContain('Thinking Tokens: 1200');
    expect(html).toContain('<i>This is thinking process.</i>');
  });


  it('should format completed thought-gemini blocks with metadata correctly', () => {
    const input = 'Pre-text\n<thought-gemini time="3.4" tokens="1250">\nThinking content\n</thought-gemini>\nPost-text';
    const html = markdownToHtml(input);
    expect(html).toContain('<details><summary>🧠 Gemini Thinking · 3.4s · 1.3K</summary>');
    expect(html).toContain('Thinking Time: 3.4 s');
    expect(html).toContain('Thinking Tokens: 1250');
    expect(html).toContain('<i>Thinking content</i>');
  });

  it('should format streaming thought-gemini blocks with metadata correctly', () => {
    const input = '<thought-gemini time="2.1" tokens="800">\nThinking on the go';
    const html = markdownToHtml(input);
    expect(html).toContain('<details open><summary>🧠 Gemini Thinking · 2.1s · 800</summary>');
    expect(html).toContain('Thinking Time: 2.1 s');
    expect(html).toContain('Thinking Tokens: 800');
    expect(html).toContain('<i>Thinking on the go</i>');
  });

  it('should dynamically truncate long thought-gemini blocks', () => {
    const longThought = 'A'.repeat(4000);
    const input = `Pre-text\n<thought-gemini time="1.5" tokens="500">\n${longThought}\n</thought-gemini>\nPost-text`;
    const html = markdownToHtml(input);
    expect(html).toContain('……（已省略后续内容，超长思考摘要已被截断）');
    expect(html.length).toBeLessThan(4096);
  });

  describe('markdownToHtml with isStreaming=true', () => {
    it('should format completed thought-gemini blocks with <details open> when isStreaming=true', () => {
      const input = 'Pre-text\n<thought-gemini time="3.4" tokens="1250">\nThinking content\n</thought-gemini>\nPost-text';
      const html = markdownToHtml(input, true);
      expect(html).toContain('<details open><summary>🧠 Gemini Thinking · 3.4s · 1.3K</summary>');
    });

    it('should format completed thought blocks with <details open> when isStreaming=true', () => {
      const input = 'Pre-text\n<thought>\nThinking content\n</thought>\nPost-text';
      const html = markdownToHtml(input, true);
      expect(html).toContain('<details open><summary>🧠 思考过程 (Thinking Process)</summary>');
    });
  });

  describe('Details Block Spacing Normalization', () => {
    it('should ensure there are blank lines (converted to double <br>) before and after details block', () => {
      const input = 'Pre-text\n<thought-gemini time="1.0" tokens="100">\nThinking...\n</thought-gemini>\nPost-text';
      const html = markdownToHtml(input);
      expect(html).toContain('Pre-text<br><br><details><summary>');
      expect(html).toContain('</details><br><br>Post-text');
    });

    it('should normalize multiple spaces/newlines around details blocks', () => {
      const input = 'Pre-text\n\n\n  <thought-gemini time="1.0" tokens="100">\nThinking...\n</thought-gemini>  \n\n\nPost-text';
      const html = markdownToHtml(input);
      expect(html).toContain('Pre-text<br><br><details><summary>');
      expect(html).toContain('</details><br><br>Post-text');
    });

    it('should not add double <br> at the start or end of the document', () => {
      const input = '<thought-gemini time="1.0" tokens="100">\nThinking...\n</thought-gemini>';
      const html = markdownToHtml(input);
      expect(html).not.toContain('<br><br><details>');
      expect(html).not.toContain('</details><br><br>');
    });
  });

  describe('Structure-Aware HTML Chunking', () => {
    it('should split plain text at space boundaries without breaking HTML tags', () => {
      const htmlText = '<b>This is a very long text that contains bold elements</b> and regular text.';
      const chunks = splitTextWithOpenTags(htmlText, 40);
      
      // Each chunk must have balanced tags
      for (const chunk of chunks) {
        const opens = (chunk.match(/<[^/][^>]*>/g) || []).length;
        const closes = (chunk.match(/<\/[^>]+>/g) || []).length;
        expect(opens).toBe(closes);
      }
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should split code blocks line-by-line and re-wrap them with code tags', () => {
      const codeHtml = '<pre><code class="language-js">const a = 1;\nconst b = 2;\nconst c = 3;</code></pre>';
      // Split with low maxLength to force chunking
      const chunks = splitCodeBlock(codeHtml, 45);
      
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('<pre><code class="language-js">const a = 1;</code></pre>');
      expect(chunks[1]).toBe('<pre><code class="language-js">const b = 2;</code></pre>');
      expect(chunks[2]).toBe('<pre><code class="language-js">const c = 3;</code></pre>');
    });

    it('should split tables row-by-row and duplicate headers', () => {
      const tableHtml = '<table bordered striped><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>';
      // Force split by using small max limit
      const chunks = splitTable(tableHtml, 110);
      
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toContain('<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>');
      expect(chunks[1]).toContain('<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>3</td><td>4</td></tr></tbody>');
    });

    it('should split details blocks recursively and preserve summary headers', () => {
      const detailsHtml = '<details open><summary>Summary Title</summary>Line 1<br><br>Line 2<br><br>Line 3</details>';
      
      // Split with subMaxLength that forces body to chunk
      const chunks = splitDetails(detailsHtml, 80);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toContain('<details open><summary>Summary Title</summary>');
      expect(chunks[1]).toContain('<details open><summary>Summary Title (续)</summary>');
    });

    it('should correctly tokenize HTML elements into blocks and plain text', () => {
      const htmlText = 'Text<br><br><pre><code>code</code></pre><br><details><summary>test</summary>body</details>';
      const tokens = tokenizeHtml(htmlText);
      
      expect(tokens.length).toBe(5);
      expect(tokens[0]).toEqual({ type: 'text', value: 'Text' });
      expect(tokens[1]).toEqual({ type: 'break', value: '<br><br>' });
      expect(tokens[2]).toEqual({ type: 'pre', value: '<pre><code>code</code></pre>' });
      expect(tokens[3]).toEqual({ type: 'break', value: '<br>' });
      expect(tokens[4]).toEqual({ type: 'details', value: '<details><summary>test</summary>body</details>' });
    });

    it('should chunk raw HTML correctly and append RAW_HTML prefix when requested', () => {
      const htmlText = '<details><summary>Test Details</summary>Content here</details>';
      // Use telegramFormatter.chunkText with RAW_HTML prefix
      const chunks = telegramFormatter.chunkText('___RAW_HTML___' + htmlText);
      expect(chunks[0]).toBe('___RAW_HTML___<details><summary>Test Details</summary>Content here</details>');
    });
  });
});

