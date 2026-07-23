/**
 * @file helpers.ts
 * @description Helper functions for Telegram command handlers.
 */

export function htmlToMarkdown(html: string): string {
  let md = html;

  // Convert details block (thinking process):
  md = md.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (match: string, summary: string, content: string) => {
    return `> **${summary.trim()}**\n>\n${content.trim().split('\n').map((line: string) => `> ${line}`).join('\n')}\n\n`;
  });

  // 1. Convert code blocks: <pre><code class="language-xyz">content</code></pre>
  md = md.replace(/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (match: string, lang: string, content: string) => {
    const language = lang || '';
    const cleanContent = unescapeHtmlEntities(content);
    return `\`\`\`${language}\n${cleanContent}\n\`\`\``;
  });

  // 2. Convert inline code: <code>content</code>
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, (match: string, content: string) => {
    return `\`${unescapeHtmlEntities(content)}\``;
  });

  // 3. Convert headers: <h[1-6]>content</h[1-6]>
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match: string, level: string, content: string) => {
    const hashes = '#'.repeat(Number(level));
    return `${hashes} ${content.trim()}\n\n`;
  });

  // 4. Convert bold: <b>content</b> or <strong>content</strong>
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');

  // 5. Convert italic: <i>content</i> or <em>content</em>
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');

  // 6. Convert links: <a href="url">text</a>
  md = md.replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 7. Convert list items: <li>content</li>
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '* $1\n');
  
  // Strip outer <ul> and <ol>
  md = md.replace(/<\/?ul[^>]*>/gi, '');
  md = md.replace(/<\/?ol[^>]*>/gi, '');

  // 8. Convert line breaks: <br> / <br/> / <br />
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 9. Convert paragraphs: <p>content</p>
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // 10. Convert blockquotes: <blockquote>content</blockquote>
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n');

  // 11. Clean up multiple consecutive newlines
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

function unescapeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractTitleFromMarkdown(answerMarkdown: string): string {
  // Skip a leading YAML frontmatter block (--- ... ---) if present, so the
  // title extraction doesn't pick up frontmatter delimiters or metadata.
  let md = answerMarkdown;
  const fmMatch = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (fmMatch) md = md.slice(fmMatch[0].length);

  const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // 1. Try first level-1 heading: ^#\s+(.+)$
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }

  // 2. Try first level-2 heading: ^##\s+(.+)$
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) return match[1].trim();
  }

  // 3. Fallback to the first line (clean out any basic inline markdown formatting like *, _, `)
  const firstLine = lines[0].replace(/[*_`#]/g, '').trim();
  return firstLine;
}
