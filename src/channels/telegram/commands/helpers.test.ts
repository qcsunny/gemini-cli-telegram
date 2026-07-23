import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, extractTitleFromMarkdown } from './helpers.js';

describe('htmlToMarkdown', () => {
  it('should convert bold tags', () => {
    expect(htmlToMarkdown('<b>hello</b>')).toBe('**hello**');
  });

  it('should convert italic tags', () => {
    expect(htmlToMarkdown('<i>italic</i>')).toBe('*italic*');
  });

  it('should convert links', () => {
    expect(htmlToMarkdown('<a href="https://x.com">link</a>')).toBe('[link](https://x.com)');
  });

  it('should convert code blocks', () => {
    const html = '<pre><code class="language-js">const x = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toContain('```js');
    expect(htmlToMarkdown(html)).toContain('const x = 1;');
  });

  it('should convert inline code', () => {
    expect(htmlToMarkdown('<code>var</code>')).toBe('`var`');
  });

  it('should convert headers', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toContain('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub');
  });

  it('should convert details/summary to blockquote', () => {
    const html = '<details><summary>Thought</summary><p>content</p></details>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('> **Thought**');
    expect(result).toContain('> content');
  });

  it('should convert blockquote', () => {
    expect(htmlToMarkdown('<blockquote>quote</blockquote>')).toContain('> quote');
  });

  it('should unescape HTML entities in code', () => {
    const html = '<code>&lt;div&gt;</code>';
    expect(htmlToMarkdown(html)).toBe('`<div>`');
  });

  it('should strip multiple newlines', () => {
    expect(htmlToMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('should trim result', () => {
    expect(htmlToMarkdown('  <b>hi</b>  ')).toBe('**hi**');
  });
});

describe('extractTitleFromMarkdown', () => {
  it('should extract first h1', () => {
    const md = 'some text\n# Main Title\n\ncontent';
    expect(extractTitleFromMarkdown(md)).toBe('Main Title');
  });

  it('should prefer h1 over h2', () => {
    const md = '## Sub Title\n# Main Title';
    expect(extractTitleFromMarkdown(md)).toBe('Main Title');
  });

  it('should fallback to h2 when no h1', () => {
    const md = 'intro\n## Section\ncontent';
    expect(extractTitleFromMarkdown(md)).toBe('Section');
  });

  it('should fallback to first line when no headings', () => {
    const md = 'Just a plain line\n\nmore text';
    expect(extractTitleFromMarkdown(md)).toBe('Just a plain line');
  });

  it('should skip YAML frontmatter', () => {
    const md = '---\ntitle: hidden\n---\n# Real Title\nbody';
    expect(extractTitleFromMarkdown(md)).toBe('Real Title');
  });

  it('should strip inline formatting from fallback', () => {
    const md = '**bold** and *italic* text';
    expect(extractTitleFromMarkdown(md)).toBe('bold and italic text');
  });

  it('should return empty for empty input', () => {
    expect(extractTitleFromMarkdown('')).toBe('');
  });
});
