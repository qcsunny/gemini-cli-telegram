/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { markdownToHtml, markdownToMarkdownV2, sanitizeHtmlForTelegram } from './formatter.js';

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

Spoiler Story
||The hero opened the door and found the treasure was a mirror all along.||

Thanks for reading! 🚀`;

  it('should convert showcase markdown to advanced HTML with native 10.1 tags', () => {
    const html = markdownToHtml(showcaseMarkdown);
    expect(html).toBeDefined();
    expect(typeof html).toBe('string');
    
    // Check core formatting and inline tags
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<s>strikethrough</s>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<tg-spoiler>spoiler text</tg-spoiler>');
    expect(html).toContain('<a href="https://core.telegram.org/api">Telegram\'s API Docs</a>');
    
    // Check 10.1 native table tags with stripes & borders
    expect(html).toContain('<table bordered striped>');
    expect(html).toContain('<th>Feature</th>');
    expect(html).toContain('<td>Bold</td>');
    // Ensure banned table structural tags are stripped
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<tbody>');
    
    // Check 10.1 LaTeX math rendering
    expect(html).toContain('<tg-math-block>e^{i\\pi} + 1 = 0</tg-math-block>');
    expect(html).toContain('<tg-math>x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}</tg-math>');
    
    // Check 10.1 native task lists checkboxes
    expect(html).toContain('<li><input type="checkbox" />Learn Markdown</li>');
    expect(html).toContain('<li><input type="checkbox" />Build a bot</li>');
    
    // Check 10.1 native collapsible details blocks
    expect(html).toContain('<details><summary>Click to expand 👀</summary>');
    expect(html).toContain('<p>This is hidden content!</p></details>');
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

  it('should sanitize unsupported named HTML entities to numerical/literal equivalents', () => {
    const dirty = '5 &times; 5 is 25 &bull; Hello &amp; Goodbye!';
    const sanitized = sanitizeHtmlForTelegram(dirty);
    // &times; is unicode 215 or character '×'
    // &bull; is unicode 8226 or character '•'
    // &amp; is allowed, so it remains &amp;
    expect(sanitized).toContain('&#215;');
    expect(sanitized).toContain('&#8226;');
    expect(sanitized).toContain('&amp;');
  });

  it('should compile contiguous markdown images into a native tg-collage element', () => {
    const md = 'Here is a gallery:\n\n![](https://example.com/1.jpg)\n![](https://example.com/2.png)';
    const html = markdownToHtml(md);
    expect(html).toContain('<tg-collage>');
    expect(html).toContain('<img src="https://example.com/1.jpg"');
    expect(html).toContain('<img src="https://example.com/2.png"');
    expect(html).toContain('</tg-collage>');
  });

  it('should format footers with standard Telegram tags', () => {
    const input = 'This is the main response.\n\n[footer: Gemini 3.5 Flash (Medium) | 120 | 250 | $0.000084]';
    const html = markdownToHtml(input);
    expect(html).toContain('<i>🤖 运行模型: <code>Gemini 3.5 Flash (Medium)</code> | 📊 消耗 Token: <code>输入 120 + 输出 250 = 370</code> | 💰 消费金额: <code>$0.000084</code></i>');
  });
});
