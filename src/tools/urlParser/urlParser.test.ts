/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { detectLinkType, extractFirstUrl, cleanHtmlToMarkdown } from './urlParser.js';

describe('detectLinkType', () => {
  it('detects known provider hosts', () => {
    expect(detectLinkType('https://arxiv.org/abs/2401.00001')).toBe('arxiv');
    expect(detectLinkType('https://www.github.com/google/gemini-cli')).toBe('github');
    expect(detectLinkType('https://mp.weixin.qq.com/s/abc123')).toBe('weixin');
    expect(detectLinkType('https://zhuanlan.zhihu.com/p/123456')).toBe('zhihu');
    expect(detectLinkType('https://twitter.com/user/status/1')).toBe('twitter');
    expect(detectLinkType('https://x.com/user/status/1')).toBe('twitter');
  });

  it('falls back to web for unknown hosts and invalid URLs', () => {
    expect(detectLinkType('https://example.com/article')).toBe('web');
    expect(detectLinkType('not a url')).toBe('web');
    expect(detectLinkType('')).toBe('web');
  });

  it('is case-insensitive on the host', () => {
    expect(detectLinkType('https://ARXIV.ORG/abs/1')).toBe('arxiv');
  });
});

describe('extractFirstUrl', () => {
  it('extracts a bare URL', () => {
    expect(extractFirstUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  it('extracts a URL embedded in text', () => {
    expect(extractFirstUrl('see http://a.b/c?x=1 for details')).toBe('http://a.b/c?x=1');
  });

  it('strips trailing ASCII and CJK punctuation', () => {
    expect(extractFirstUrl('visit https://a.b/c).')).toBe('https://a.b/c');
    expect(extractFirstUrl('链接：https://a.b/c。')).toBe('https://a.b/c');
    expect(extractFirstUrl('https://a.b/c，')).toBe('https://a.b/c');
  });

  it('keeps trailing CJK text (only punctuation is stripped)', () => {
    expect(extractFirstUrl('https://a.b/c谢谢')).toBe('https://a.b/c谢谢');
  });

  it('returns null when no URL is present', () => {
    expect(extractFirstUrl('no links here')).toBeNull();
    expect(extractFirstUrl('')).toBeNull();
  });
});

describe('cleanHtmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(cleanHtmlToMarkdown('')).toBe('');
  });

  it('strips script/style/iframe content entirely', () => {
    const html = '<p>ok</p><script>evil()</script><style>.a{}</style><iframe src="x"></iframe>';
    const out = cleanHtmlToMarkdown(html);
    expect(out).toBe('ok');
    expect(out).not.toContain('evil');
  });

  it('maps headings to markdown hashes', () => {
    expect(cleanHtmlToMarkdown('<h1>Title</h1><h3>Sub</h3>')).toBe('## Title\n\n### Sub');
  });

  it('maps list items, bold and italic', () => {
    expect(cleanHtmlToMarkdown('<li>a</li><li>b</li>')).toBe('• a\n• b');
    expect(cleanHtmlToMarkdown('<strong>b</strong> <em>i</em>')).toBe('**b** *i*');
  });

  it('decodes common HTML entities', () => {
    expect(cleanHtmlToMarkdown('a&nbsp;b&amp;c&lt;d&gt;e&quot;f&#39;g&amp;mdash;h')).toBe(
      'a b&c<d>e"f\'g—h',
    );
  });

  it('collapses excess whitespace and newlines', () => {
    expect(cleanHtmlToMarkdown('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });

  it('strips remaining tags to spaces', () => {
    expect(cleanHtmlToMarkdown('a<span>mid</span>b')).toBe('a mid b');
  });
});