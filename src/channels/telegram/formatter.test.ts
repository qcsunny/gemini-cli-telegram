/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { markdownToHtml, markdownToMarkdownV2, markdownToRichBlocks } from './formatter.js';

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
    expect(html).toContain('<i>🤖 运行模型: <code>Gemini 3.5 Flash (Medium)</code> | 📊 消耗 Token: <code>输入 120 + 输出 250 = 370</code> | 💰 消费金额: <code>$0.000084</code></i>');
  });

  it('should format headers with distinct visual prefixes', () => {
    const h1Html = markdownToHtml('# Header 1');
    const h2Html = markdownToHtml('## Header 2');
    const h3Html = markdownToHtml('### Header 3');
    expect(h1Html).toContain('📌 <b>Header 1</b>');
    expect(h2Html).toContain('📍 <b>Header 2</b>');
    expect(h3Html).toContain('🔹 <b>Header 3</b>');
  });
});
