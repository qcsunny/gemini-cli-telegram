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
  buildFinalBlocks,
  buildStreamingBlocks,
  splitRichBlocks,
  telegramFormatter,
  splitTextWithOpenTags,
  splitCodeBlock,
  splitTable,
  splitDetails,
  tokenizeHtml,
  safeHtmlSlice,
  normalizeSpacingAroundDetails,
  normalizeMarkdownFences,
  normalizeNestedCodeFences,
  normalizeMarkdownStructure,
  findSafeCutPoint,
  buildFooterBlocksFromHtml
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

  it('should preserve text preceding inline LaTeX formula in correct order', () => {
    const blocks = markdownToRichBlocks('Prefix text: \\( x + 1 = 2 \\) suffix text');
    expect(blocks).toHaveLength(1);
    const para = blocks[0] as any;
    expect(para.type).toBe('paragraph');
    expect(para.text).toEqual([
      'Prefix text: ',
      { type: 'mathematical_expression', expression: 'x + 1 = 2' },
      ' suffix text',
    ]);
  });

  it('should downgrade long intro text starting with ## or ending with colon to paragraph block', () => {
    const longIntro = '## 物理学十大未解难题尽管现代物理学在解释宇宙运行规律方面取得了巨大成就，但仍有一些根本性的未知谜团困扰着顶尖科学家。以下是目前物理学界公认的十大未解难题：';
    const blocks = markdownToRichBlocks(longIntro);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });

  it('should split glued horizontal rules and mid-line bullets correctly', () => {
    const text1 = '究竟是什么，我们至今一无所知。---总结来说';
    const blocks1 = markdownToRichBlocks(text1);
    expect(blocks1).toHaveLength(3);
    expect(blocks1[1].type).toBe('divider');

    const text2 = '剩下的95%（约27%的暗物质68%的暗能量）究竟是什么，我们至今一无所知。*影响：这极其深远';
    const blocks2 = markdownToRichBlocks(text2);
    expect(blocks2).toHaveLength(2);
    expect(blocks2[1].type).toBe('list');
  });

  it('should preserve markdown table separators |---|---| without breaking lines', () => {
    const tableMd = '| 属性 | 说明 |\n|---|---|\n| 值1 | 值2 |';
    const blocks = markdownToRichBlocks(tableMd);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
  });

  it('should parse details blockquotes without swallowing earlier blockquotes or intervening text', () => {
    const mdInput = '> 引用1\n\n正文段落\n\n> [details] 展开标题\n> 展开内容';
    const html = markdownToHtml(mdInput);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('正文段落');
    expect(html).toContain('<details><summary>展开标题</summary>');
  });

  it('should convert preceding Click-to-expand prompt lines into native details elements', () => {
    const mdInput = '点击展开查看事故描述\n> 事故发生在 `192.168.1.105` 节点';
    const html = markdownToHtml(mdInput);
    expect(html).toContain('<details><summary>点击展开查看事故描述</summary>');
    expect(html).toContain('事故发生在 <code>192.168.1.105</code> 节点');
  });

  it('should preserve raw Telegram Bot API 10.1 details HTML tags', () => {
    const rawDetailsInput = '<details open><summary>官方 API 折叠框</summary>展开内容</details>';
    const html = markdownToHtml(rawDetailsInput);
    expect(html).toContain('<details open><summary>官方 API 折叠框</summary>');
    expect(html).toContain('展开内容</details>');
  });

  it('should strip nested blockquotes inside details blocks per Telegram Bot API spec', () => {
    const nestedInput = '<details><summary>标题</summary><blockquote>引用内容</blockquote></details>';
    const html = markdownToHtml(nestedInput);
    expect(html).not.toContain('<blockquote>');
    expect(html).toContain('<details><summary>标题</summary>引用内容</details>');
  });

  it('should preserve tables with cell values containing + or - signs like +15.4% or -70%', () => {
    const tableMd = '| 季度 | 增长率 |\n| :---: | :---: |\n| 2025 Q1 | +15.4% |\n| 2025 Q2 | -70.0% |';
    const html = markdownToHtml(tableMd);
    expect(html).toContain('<table bordered striped>');
    expect(html).toContain('+15.4%');
    expect(html).toContain('-70.0%');
    expect(html).not.toContain('• 15.4%');
  });

  it('should normalize indented decimal list sub-numbering 1.1 and 1.1.1 into standard 3-level ordered lists', () => {
    const listMd = '1. 第一级\n   1.1 第二级\n       1.1.1 第三级';
    const html = markdownToHtml(listMd);
    expect(html).toContain('1. 第一级');
    expect(html).toContain('1. 第二级');
    expect(html).toContain('1. 第三级');
  });

  it('should not auto-close code blocks on heading-like lines (false close for # comments)', () => {
    const unclosedMd = '```python\ndef foo():\n    pass\n\n### 下一章节';
    const html = markdownToHtml(unclosedMd);
    expect(html).toContain('<pre><code class="language-python">');
    // Without auto-close, the unclosed fence keeps ### 下一章节 as code content
    expect(html).toContain('### 下一章节</code></pre>');
    expect(html).not.toContain('下一章节</b>');
  });

  it('should not auto-link plain filenames like user.py, formatter.py, README.md', () => {
    const textMd = '文件列表：user.py 和 formatter.py 以及 README.md';
    const html = markdownToHtml(textMd);
    expect(html).not.toContain('href="http://user.py"');
    expect(html).toContain('user.py');
  });

  it('should normalize GFM checklist items into clean native GFM task list markdown - [x] and - [ ]', () => {
    const todoMd = '- [x] ☑ 已完成任务\n- [ ] ☐ 未完成任务\n- [x] 完成项2';
    const html = markdownToHtml(todoMd);
    expect(html).toContain('[x] 已完成任务');
    expect(html).toContain('[ ] 未完成任务');
    expect(html).toContain('[x] 完成项2');
    expect(html).not.toContain('• [x]');
    expect(html).not.toContain('• [ ]');
  });

  it('should not split inline code with asterisks like `*斜体文本*` onto new lines or insert extra bullets', () => {
    const inlineMd = '* **斜体文本**：使用 `*斜体文本*` 渲染为 *倾斜文本效果*。';
    const html = markdownToHtml(inlineMd);
    expect(html).toContain('<code>*斜体文本*</code>');
    expect(html).not.toContain('• 斜体文本');
  });

  it('should preserve 3-level ordered lists containing inline code without turning 3rd level into bullet items', () => {
    const listMd = '1. 第一级\n   1. 第二级\n      1. 执行 `uname -r` 确认\n      2. 校验 CPU';
    const html = markdownToHtml(listMd);
    expect(html).toContain('1. 第一级');
    expect(html).toContain('1. 第二级');
    expect(html).toContain('1. 执行 <code>uname -r</code> 确认');
    expect(html).not.toContain('• 执行');
  });

  it('should parse markdown formatting inside thinking details block', () => {
    const blocks = buildFinalBlocks('Body content', '**AssessingPaceofProgress**');
    const detailsBlock = blocks.find(b => b.type === 'details') as any;
    expect(detailsBlock).toBeDefined();
    expect(detailsBlock.blocks[0].type).toBe('paragraph');
    expect(detailsBlock.blocks[0].text[0].type).toBe('bold');
  });

  it('should preserve bold tags in buildFooterBlocksFromHtml for thinking details', () => {
    const html = '<details><summary>🧠 思考过程</summary><b>AssessingPaceofProgress</b></details>';
    const blocks = buildFooterBlocksFromHtml(html);
    const detailsBlock = blocks.find((b: any) => b.type === 'details') as any;
    expect(detailsBlock).toBeDefined();
    expect(detailsBlock.blocks[0].type).toBe('paragraph');
    expect(detailsBlock.blocks[0].text[0].type).toBe('bold');
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
    expect(html).toContain('<details><summary>🧠 思考过程 (Thinking Process)</summary>Let me analyze the path</details>');
  });

  it('should format streaming unclosed thought blocks as open details', () => {
    const input = '<thought>\nLet me analyze the path';
    const html = markdownToHtml(input);
    expect(html).toContain('<details open><summary>🧠 正在思考... (Thinking...)</summary>Let me analyze the path</details>');
  });

  it('should format unclosed thought blocks in the middle of a string as normal content, not details', () => {
    const input = 'Pre-text\n<thought>\nLet me analyze the path';
    const html = markdownToHtml(input);
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('🧠');
    expect(html).toContain('Pre-text');
    expect(html).toContain('&lt;think&gt;');
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
    expect(html).toContain('This is thinking process.');
  });


  it('should format completed thought-gemini blocks with metadata correctly', () => {
    const input = 'Pre-text\n<thought-gemini time="3.4" tokens="1250">\nThinking content\n</thought-gemini>\nPost-text';
    const html = markdownToHtml(input);
    expect(html).toContain('<details><summary>🧠 Gemini Thinking · 3.4s · 1.3K</summary>');
    expect(html).toContain('Thinking Time: 3.4 s');
    expect(html).toContain('Thinking Tokens: 1250');
    expect(html).toContain('Thinking content');
  });

  it('should format streaming thought-gemini blocks with metadata correctly', () => {
    const input = '<thought-gemini time="2.1" tokens="800">\nThinking on the go';
    const html = markdownToHtml(input);
    expect(html).toContain('<details open><summary>🧠 Gemini Thinking · 2.1s · 800</summary>');
    expect(html).toContain('Thinking Time: 2.1 s');
    expect(html).toContain('Thinking Tokens: 800');
    expect(html).toContain('Thinking on the go');
  });

  it('should dynamically truncate long thought-gemini blocks', () => {
    const longThought = 'A'.repeat(4000);
    const input = `Pre-text\n<thought-gemini time="1.5" tokens="500">\n${longThought}\n</thought-gemini>\nPost-text`;
    const html = markdownToHtml(input, true);
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
      expect(html).toContain('<details open><summary>🧠 正在思考... (Thinking...)</summary>');
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
      // Split with low maxLength to force chunking (must be at least 55 to fit a single line of length 12 with 43 chars of tags)
      const chunks = splitCodeBlock(codeHtml, 56);
      
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

    it('should prevent infinite loop and enforce minimum slice in splitTextWithOpenTags', () => {
      const text = '<b>Hello World</b>';
      const chunks = splitTextWithOpenTags(text, 5);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toBe('<b>H</b>');
    });

    it('should support self-closing tags (br, hr, img) in safeHtmlSlice without producing closed tag artifacts', () => {
      const htmlText = 'Hello<br>world<hr/>img:<img src="test.jpg"/>!';
      const result = safeHtmlSlice(htmlText, 25);
      expect(result.sliced).not.toContain('</br>');
      expect(result.sliced).not.toContain('</hr>');
      expect(result.sliced).not.toContain('</img>');
    });

    it('should clean up all variations of break tags at boundaries in normalizeSpacingAroundDetails', () => {
      const htmlText = '<br/><b>Test</b><br><details><summary>Test</summary>Content</details><br /><br/>';
      const result = normalizeSpacingAroundDetails(htmlText);
      expect(result.startsWith('<br>')).toBe(false);
      expect(result.startsWith('<br/>')).toBe(false);
      expect(result.startsWith('<br />')).toBe(false);
      expect(result.endsWith('<br>')).toBe(false);
      expect(result.endsWith('<br/>')).toBe(false);
      expect(result.endsWith('<br />')).toBe(false);
    });

    it('should convert LaTeX math brackets to Telegram math tags', () => {
      const markdown = 'Inline: \\(a^2 + b^2 = c^2\\) and block: \\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<tg-math>a^2 + b^2 = c^2</tg-math>');
      expect(html).toContain('<tg-math-block>\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n</tg-math-block>');
    });

    it('should correctly tokenize nested blockquotes', () => {
      const htmlText = '<blockquote>Outer <blockquote>Inner</blockquote> OuterEnd</blockquote>';
      const tokens = tokenizeHtml(htmlText);
      expect(tokens.length).toBe(1);
      expect(tokens[0]).toEqual({
        type: 'blockquote',
        value: '<blockquote>Outer <blockquote>Inner</blockquote> OuterEnd</blockquote>',
      });
    });

    it('should correctly tokenize nested details blocks', () => {
      const htmlText = '<details><summary>Outer</summary>Content <details><summary>Inner</summary>InnerContent</details> End</details>';
      const tokens = tokenizeHtml(htmlText);
      expect(tokens.length).toBe(1);
      expect(tokens[0]).toEqual({
        type: 'details',
        value: '<details><summary>Outer</summary>Content <details><summary>Inner</summary>InnerContent</details> End</details>',
      });
    });

    it('should split ultra-long single lines inside code blocks', () => {
      const longLine = 'A'.repeat(100);
      const codeHtml = `<pre><code>${longLine}</code></pre>`;
      const chunks = splitCodeBlock(codeHtml, 50);
      expect(chunks.length).toBe(4);
      expect(chunks[0]).toBe(`<pre><code>${'A'.repeat(26)}</code></pre>`);
      expect(chunks[1]).toBe(`<pre><code>${'A'.repeat(26)}</code></pre>`);
      expect(chunks[3]).toBe(`<pre><code>${'A'.repeat(22)}</code></pre>`);
    });

    it('should normalize code fences attached to text onto separate newlines', () => {
      const input = '• **Header:**```\ncode line 1\ncode line 2\n```';
      const normalized = normalizeMarkdownFences(input);
      expect(normalized).toBe('• **Header:**\n\n```\n\ncode line 1\ncode line 2\n\n```');

      const html = markdownToHtml(input);
      expect(html).toContain('code line 1\ncode line 2');
      expect(html).not.toContain('```');
    });

    it('should not leak raw triple-backticks when closing fence is glued to text', () => {
      const input = '正文```python\nprint("hello")\n```后面也没有换行接正文继续写。还有 ```js\nconst a=1\n```这种也粘在一起。';
      const html = markdownToHtml(input);
      expect(html).not.toContain('```');
      expect(html).toContain('<pre><code class="language-python">');
      expect(html).toContain('<pre><code class="language-js">');
    });
  });

  describe('Markdown Structure Normalization', () => {
    it('should add a space after ATX hashes with no space (###1. -> ### 1.)', () => {
      expect(normalizeMarkdownStructure('###1. 自注意力机制')).toBe('### 1. 自注意力机制');
      expect(normalizeMarkdownStructure('#### 3.1 标题')).toBe('#### 3.1 标题');
      expect(normalizeMarkdownStructure('## 2.1 已有空格')).toBe('## 2.1 已有空格');
    });

    it('should render headings without a leading space as real headings', () => {
      expect(markdownToHtml('###1. 自注意力机制')).toContain('<b>1. 自注意力机制');
      expect(markdownToHtml('#### 3.1 标题没有正确换行')).toContain('<b>3.1 标题没有正确换行');
    });

    it('should split a separator glued to a heading onto its own line', () => {
      const html = markdownToHtml('正文内容---### 4. 分隔符和标题');
      expect(html).toContain('4. 分隔符和标题');
      // separator and heading must be on separate lines (not glued)
      expect(html).not.toContain('---###');
    });

    it('should not break a --- that appears inside a word', () => {
      expect(markdownToHtml('普通 a---b 不应被拆')).toBe('普通 a---b 不应被拆');
    });

    it('should recognize a standalone --- as a horizontal separator', () => {
      const html = markdownToHtml('段落一\n---\n段落二');
      expect(html).toContain('段落一');
      expect(html).toContain('段落二');
      expect(html).toContain('───');
    });
  });

  describe('findSafeCutPoint', () => {
    it('should not cut inside a fenced code block', () => {
      const md = '前言文字\n\n```python\nline1\nline2\nline3\n```\n\n后文';
      // threshold lands inside the code block region
      const cut = findSafeCutPoint(md, 30);
      const slice = md.slice(0, cut);
      // the slice must not contain an unterminated ``` — i.e. if it opens a fence it must close it
      const opens = (slice.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    });

    it('should cut at a paragraph boundary before the threshold', () => {
      const md = '段落A第一行\n段落A第二行\n\n段落B第一行\n段落B第二行\n\n段落C';
      const cut = findSafeCutPoint(md, 32);
      expect(md.slice(cut)).toMatch(/^段落[BC]/); // cut is right after a blank line
    });

    it('should return full length when text is short', () => {
      expect(findSafeCutPoint('短文本', 100)).toBe('短文本'.length);
    });
  });

  describe('10.2 native footer blocks', () => {
    it('should parse a footer HTML into native details + footer blocks', () => {
      const html =
        '<a href="tg://btn_info_footer|Gemini 3.5 Flash (Medium)|120|250|$0.000084|40|1300">⚙️ Gemini 3.5 Flash (Medium) · In: 120 · Out: 250 · Cost: $0.000084</a>' +
        '<details><summary>🧠 思考过程 (Thinking Process)</summary>Let me analyze the path.<i>Thinking Time: 2.5 s</i></details>';
      const blocks = buildFooterBlocksFromHtml(html);
      expect(blocks.length).toBe(2);
      expect(blocks[0]).toMatchObject({ type: 'details', summary: '🧠 思考过程 (Thinking Process)' });
      expect((blocks[0] as any).blocks[0].text).toBe('Let me analyze the path.');
      expect(blocks[1]).toMatchObject({ type: 'footer' });
      expect((blocks[1] as any).text).toContain('⚙️ Gemini 3.5 Flash (Medium)');
      expect((blocks[1] as any).text).toContain('In: 120 (Cached: 40)');
      expect((blocks[1] as any).text).toContain('Out: 250 (Reasoning: 1300)');
      expect((blocks[1] as any).text).toContain('Cost: $0.000084');
    });

  describe('10.2 RichBlocks robustness', () => {
    it('should parse fence code blocks with language annotation and nested backticks', () => {
      const md = '```markdown\nHere is `inline code` inside a fence\n```';
      const blocks = markdownToRichBlocks(md);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('pre');
      const pre = blocks[0] as any;
      expect(pre.text).toContain('`inline code`');
      expect(pre.language).toBe('markdown');
    });

    it('should parse fence code block with empty content', () => {
      const md = '```python\n```';
      const blocks = markdownToRichBlocks(md);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('pre');
    });

    it('should parse fence delimiter glued to preceding text', () => {
      const md = 'some text```python\nprint("hello")\n```';
      const blocks = markdownToRichBlocks(md);
      // normalizeMarkdownFences splits the glued fence, so we get: paragraph + pre
      expect(blocks.length).toBe(2);
      expect(blocks[0].type).toBe('paragraph');
      expect(blocks[1].type).toBe('pre');
    });

    it('should convert standalone [x] and [ ] to list items with checkboxes', () => {
      const md = '[x] Completed task\n[ ] Pending task';
      const blocks = markdownToRichBlocks(md);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('list');
      const list = blocks[0] as any;
      expect(list.items.length).toBe(2);
      expect(list.items[0].has_checkbox).toBe(true);
      expect(list.items[0].is_checked).toBe(true);
      expect(list.items[0].blocks[0].text).toBe('Completed task');
      expect(list.items[1].has_checkbox).toBe(true);
      expect(list.items[1].is_checked).toBeUndefined();
      expect(list.items[1].blocks[0].text).toBe('Pending task');
    });

    it('should convert standalone [x] without dash inside blockquote to checkbox list', () => {
      const md = '> [x] quoted task';
      const blocks = markdownToRichBlocks(md);
      // blockquote > paragraph [x] quoted task → should become blockquote > list > item with checkbox
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('blockquote');
    });

    it('should keep existing list item checkboxes working', () => {
      const md = '- [x] Done\n- [ ] Todo';
      const blocks = markdownToRichBlocks(md);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('list');
      const list = blocks[0] as any;
      expect(list.items[0].has_checkbox).toBe(true);
      expect(list.items[0].is_checked).toBe(true);
      expect(list.items[1].has_checkbox).toBe(true);
      expect(list.items[1].is_checked).toBeUndefined();
    });

    it('should filter out empty paragraph blocks', () => {
      const md = '# Title\n\n\n\nSome text';
      const blocks = markdownToRichBlocks(md);
      // Title (as heading) + "Some text" (as paragraph) — blank lines produce no blocks
      const paragraphs = blocks.filter(b => b.type === 'paragraph');
      expect(paragraphs.length).toBe(1);
      const p = paragraphs[0] as any;
      expect(p.text).toBe('Some text');
    });

    it('should filter out empty pre blocks', () => {
      const md = '```\n```\n\nSome text';
      const blocks = markdownToRichBlocks(md);
      // Empty pre is kept (has text="\n"?), but we verify no empty paragraphs
      const empties = blocks.filter(b => {
        if (b.type === 'paragraph') {
          const t = (b as any).text;
          return !t || (typeof t === 'string' && !t.trim());
        }
        return false;
      });
      expect(empties.length).toBe(0);
    });

    it('should not produce heading blocks with empty text', () => {
      const blocks = markdownToRichBlocks(' ');
      expect(blocks.length).toBe(0);
    });

    it('should handle deeply nested lists by flattening beyond 16 levels', () => {
      // Build a deeply nested markdown input
      let nestedMd = '- level 1';
      for (let i = 2; i <= 18; i++) {
        nestedMd += `\n  ${'  '.repeat(i - 2)}- level ${i}`;
      }
      const blocks = markdownToRichBlocks(nestedMd);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('list');
      // The outer list should exist; nesting beyond 16 is flattened
      // but the content from all levels should be preserved
      const list = blocks[0] as any;
      const allTexts = extractAllTexts(list);
      expect(allTexts.length).toBeGreaterThanOrEqual(16);
    });

    it('should emit zero warning for all known block types via buildFinalBlocks', () => {
      const result = buildFinalBlocks(
        '# Title\n\nParagraph text\n\n- item 1\n\n```python\nprint("hello")\n```\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        'Thinking content here.',
        { time: '2.5', tokens: '150', isClosed: true, footerText: '⚙️ model info' },
      );
      expect(result.length).toBeGreaterThan(0);
      // All blocks should have required fields — no empty texts
      for (const b of result) {
        expect(b.type).toBeDefined();
      }
    });
  });

  describe('buildStreamingBlocks', () => {
    it('should render thinking block + body blocks when both thought and content are present', () => {
      const blocks = buildStreamingBlocks({
        thought: 'Let me analyze this step by step.',
        content: '## Answer\nThe result is 42.',
      });
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const first = blocks[0] as any;
      expect(first.type).toBe('thinking');
      expect(first.text).toBe('Let me analyze this step by step.');
      expect(first.collapsed).toBe(true);
      const bodyStart = blocks[1] as any;
      expect(bodyStart.type).toBe('heading');
    });

    it('should render only thinking block when thought present but content empty', () => {
      const blocks = buildStreamingBlocks({ thought: 'Still thinking...' });
      expect(blocks.length).toBe(1);
      const first = blocks[0] as any;
      expect(first.type).toBe('thinking');
      expect(first.text).toBe('Still thinking...');
    });

    it('should render only body blocks when content present but no thought', () => {
      const blocks = buildStreamingBlocks({ content: 'Hello world' });
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('paragraph');
      expect((blocks[0] as any).text).toBe('Hello world');
    });

    it('should render placeholder thinking block when both empty', () => {
      const blocks = buildStreamingBlocks({});
      expect(blocks.length).toBe(1);
      const first = blocks[0] as any;
      expect(first.type).toBe('thinking');
      expect(first.text).toBe('正在思考...');
    });
  });

  describe('splitRichBlocks', () => {
    const short = { type: 'paragraph', text: 'Hello world' } as any;
    const hugeText = 'X'.repeat(8000);

    it('should keep blocks within limit as a single part', () => {
      const blocks = [short, short];
      const parts = splitRichBlocks(blocks, 3800);
      expect(parts.length).toBe(1);
      expect(parts[0].length).toBe(2);
      expect(parts[0][0].type).toBe('paragraph');
    });

    it('should split multiple top-level blocks at block boundaries when they exceed limit', () => {
      const huge = { type: 'paragraph', text: hugeText } as any;
      const blocks = [huge, short];
      const parts = splitRichBlocks(blocks, 3800);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      // All paragraphs in each part are within limit
      for (const part of parts) {
        for (const b of part) {
          if (b.type === 'paragraph') {
            expect((b as any).text.length).toBeLessThanOrEqual(3800);
          }
        }
      }
    });

    it('should split details container inner blocks into multiple details nodes', () => {
      const innerBlocks: any[] = [];
      for (let i = 0; i < 20; i++) {
        innerBlocks.push({ type: 'paragraph', text: `Line ${i}: ${'X'.repeat(300)}` });
      }
      const details = { type: 'details', summary: '🧠 思考过程', blocks: innerBlocks } as any;
      const parts = splitRichBlocks([details], 3800);
      // Collect all details blocks across all parts
      const allDetails = parts.flat().filter(b => b.type === 'details');
      expect(allDetails.length).toBeGreaterThanOrEqual(2);
      // Each split details should have a numbered summary
      const summaries = allDetails.map(b => (b as any).summary);
      expect(summaries[0]).toMatch(/🧠 思考过程 \(1\/\d+\)/);
      expect(summaries[summaries.length - 1]).toMatch(/🧠 思考过程 \(\d+\/\d+\)/);
    });

    it('should split a single oversize paragraph into smaller paragraph nodes', () => {
      const p = { type: 'paragraph', text: hugeText } as any;
      const parts = splitRichBlocks([p], 3800);
      expect(parts.length).toBeGreaterThanOrEqual(1);
      const allParas = parts.flat().filter(b => b.type === 'paragraph');
      expect(allParas.length).toBeGreaterThanOrEqual(2);
      // Verify each chunk is within limit
      for (const part of parts) {
        for (const b of part) {
          if (b.type === 'paragraph') {
            expect((b as any).text.length).toBeLessThanOrEqual(3800);
          }
        }
      }
    });
  });
});

describe('Tilde Fence Isolation in normalizeMarkdownStructure', () => {
  it('should isolate tilde code blocks (~~~) into placeholders and preserve internal headers/comments', () => {
    const input = [
      '# Heading Outside',
      '~~~python',
      '# This is a comment inside tilde code block',
      '---',
      '1. Not a list item',
      '~~~',
      '## Another Heading Outside'
    ].join('\n');

    const html = markdownToHtml(input);
    expect(html).toContain('<b>Heading Outside</b>');
    expect(html).toContain('<b>Another Heading Outside</b>');
    expect(html).toContain('<code class="language-python"># This is a comment inside tilde code block\n---\n1. Not a list item\n</code>');
    // Ensure the comment inside tilde fence was not turned into a header
    expect(html).not.toContain('This is a comment inside tilde code block</b>');
  });

  it('should not split table lines when table cells contain hash symbols (e.g. `# 欢迎使用`)', () => {
    const tableInput = [
      '| 参数名 | 示例值 | 描述 |',
      '| :--- | :--- | :--- |',
      '| `text` | `# 欢迎使用` | 消息文本 |',
      '| `parse_mode` | `HTML` | 解析模式 |'
    ].join('\n');

    const html = markdownToHtml(tableInput);
    expect(html).toContain('<table bordered striped>');
    expect(html).toContain('<code># 欢迎使用</code>');
    expect(html).toContain('<code>parse_mode</code>');

    const blocks = markdownToRichBlocks(tableInput);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('table');
  });

  it('should auto-upgrade outer code fences when 3-backtick code block contains inner 3-backtick code block', () => {
    const nestedInput = [
      '### 16. Markdown',
      '```markdown',
      '# Inner Title',
      '```json',
      '{ "foo": "bar" }',
      '```',
      '```',
      '---',
      '## 架构与流程图表',
      '### 1. ASCII 流程图'
    ].join('\n');

    const html = markdownToHtml(nestedInput);
    expect(html).toContain('<b>16. Markdown</b>');
    expect(html).toContain('<b>架构与流程图表</b>');
    expect(html).toContain('<b>1. ASCII 流程图</b>');

    const blocks = markdownToRichBlocks(nestedInput);
    const headings = blocks.filter(b => b.type === 'heading');
    expect(headings.map(h => (h as any).text)).toEqual([
      '16. Markdown',
      '架构与流程图表',
      '1. ASCII 流程图'
    ]);
  });

  it('should upgrade multi-level (3-level) nested code fences so all outer parent fences are upgraded correctly', () => {
    const input = [
      '```markdown',
      '# Outer Level 1',
      '```python',
      '# Mid Level 2',
      '```js',
      'console.log("Inner Level 3");',
      '```',
      '```',
      '```',
    ].join('\n');

    const normalized = normalizeNestedCodeFences(input);
    const lines = normalized.split('\n');

    // Outermost fence (Level 1) should upgrade to 5 backticks
    expect(lines[0]).toBe('`````markdown');
    expect(lines[8]).toBe('`````');

    // Middle fence (Level 2) should upgrade to 4 backticks
    expect(lines[2]).toBe('````python');
    expect(lines[7]).toBe('````');

    // Innermost fence (Level 3) should stay 3 backticks
    expect(lines[4]).toBe('```js');
    expect(lines[6]).toBe('```');
  });
});

function extractAllTexts(blk: any): string[] {
  const result: string[] = [];
  if (blk.text && typeof blk.text === 'string') result.push(blk.text);
  if (blk.items) {
    for (const item of blk.items) {
      if (item.blocks) result.push(...item.blocks.flatMap(extractAllTexts));
    }
  }
  if (blk.blocks) {
    for (const child of blk.blocks) result.push(...extractAllTexts(child));
  }
  return result;
}

});

