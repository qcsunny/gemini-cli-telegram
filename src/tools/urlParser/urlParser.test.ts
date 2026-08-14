/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLinkType,
  extractFirstUrl,
  cleanHtmlToMarkdown,
  parseArXiv,
  parseGitHub,
  parseWeChat,
  parseZhihu,
  parseTwitter,
  parseGeneralWeb,
  parseUrlContent,
} from './urlParser.js';

describe('urlParser - type detection & URL extraction', () => {
  it('should accurately detect platform link types', () => {
    expect(detectLinkType('https://arxiv.org/abs/2403.12345')).toBe('arxiv');
    expect(detectLinkType('https://arxiv.org/pdf/2403.12345.pdf')).toBe('arxiv');
    expect(detectLinkType('https://github.com/google/gemini-cli')).toBe('github');
    expect(detectLinkType('https://mp.weixin.qq.com/s/abcdef123456')).toBe('weixin');
    expect(detectLinkType('https://zhuanlan.zhihu.com/p/12345678')).toBe('zhihu');
    expect(detectLinkType('https://zhihu.com/question/123456/answer/789')).toBe('zhihu');
    expect(detectLinkType('https://x.com/OpenAI/status/1234567890')).toBe('twitter');
    expect(detectLinkType('https://twitter.com/Google/status/987654321')).toBe('twitter');
    expect(detectLinkType('https://news.ycombinator.com/item?id=123')).toBe('web');
  });

  it('should extract first URL and strip trailing punctuations', () => {
    expect(extractFirstUrl('Check this paper: https://arxiv.org/abs/2403.12345, looks cool!')).toBe('https://arxiv.org/abs/2403.12345');
    expect(extractFirstUrl('https://github.com/torvalds/linux。')).toBe('https://github.com/torvalds/linux');
    expect(extractFirstUrl('No URL here')).toBeNull();
  });

  it('should clean HTML tags and entities to readable markdown', () => {
    const rawHtml = '<h1>Title</h1><p>Hello <strong>World</strong> &amp; <em>Friends</em>!</p><script>alert(1)</script>';
    const md = cleanHtmlToMarkdown(rawHtml);
    expect(md).toContain('## Title');
    expect(md).toContain('Hello **World** & *Friends*!');
    expect(md).not.toContain('<script>');
  });
});

describe('urlParser - platform parsing handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse ArXiv paper XML output correctly', async () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Attention Is All You Need</title>
        <summary>The dominant sequence transduction models are based on complex recurrent neural networks.</summary>
        <published>2017-06-12T00:00:00Z</published>
        <author><name>Ashish Vaswani</name></author>
        <author><name>Noam Shazeer</name></author>
        <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
      </entry>
    </feed>`;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockXml,
    } as any);

    const result = await parseArXiv('https://arxiv.org/abs/1706.03762');
    expect(result.type).toBe('arxiv');
    expect(result.title).toBe('Attention Is All You Need');
    expect(result.author).toContain('Ashish Vaswani');
    expect(result.author).toContain('Noam Shazeer');
    expect(result.content).toContain('The dominant sequence transduction models');
  });

  it('should parse GitHub repository metadata and raw README', async () => {
    const mockRepoData = {
      full_name: 'google/gemini-cli',
      description: 'Official Gemini CLI tool',
      stargazers_count: 5000,
      forks_count: 300,
      language: 'TypeScript',
      license: { spdx_id: 'Apache-2.0' },
      topics: ['ai', 'cli', 'gemini'],
    };

    const mockReadme = '# Gemini CLI\n\nA powerful CLI tool for Gemini.';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockRepoData,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockReadme,
      } as any);

    const result = await parseGitHub('https://github.com/google/gemini-cli');
    expect(result.type).toBe('github');
    expect(result.title).toBe('google/gemini-cli');
    expect(result.content).toContain('Official Gemini CLI tool');
    expect(result.content).toContain('⭐ 5000');
    expect(result.content).toContain('A powerful CLI tool for Gemini.');
  });

  it('should parse WeChat Official Account article', async () => {
    const mockWechatHtml = `
      <html>
        <h1 class="rich_media_title" id="activity-name">AI Agent 架构深度剖析</h1>
        <span class="rich_media_meta_text">张三</span>
        <strong class="profile_nickname">架构师前沿</strong>
        <div id="js_content"><p>这是公众号正文第一段。</p><p>这是正文第二段。</p></div>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockWechatHtml,
    } as any);

    const result = await parseWeChat('https://mp.weixin.qq.com/s/mock_test');
    expect(result.type).toBe('weixin');
    expect(result.title).toContain('AI Agent 架构深度剖析');
    expect(result.content).toContain('架构师前沿');
    expect(result.content).toContain('这是公众号正文第一段。');
  });

  it('should parse Zhihu column article', async () => {
    const mockZhihuHtml = `
      <html>
        <h1 class="Post-Title">大模型推理加速实战</h1>
        <span class="AuthorInfo-name">李四</span>
        <div class="Post-RichText"><p>通过 KV Cache 优化吞吐量。</p></div>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockZhihuHtml,
    } as any);

    const result = await parseZhihu('https://zhuanlan.zhihu.com/p/123456');
    expect(result.type).toBe('zhihu');
    expect(result.title).toContain('大模型推理加速实战');
    expect(result.content).toContain('李四');
    expect(result.content).toContain('通过 KV Cache 优化吞吐量。');
  });

  it('should parse Twitter post via fxtwitter API', async () => {
    const mockTwitterJson = {
      tweet: {
        text: 'Excited to announce our new open weights model!',
        likes: 1200,
        retweets: 300,
        views: 50000,
        created_at: 'Fri Aug 14 02:00:00 +0000 2026',
        author: {
          name: 'AI Researcher',
          screen_name: 'airesearcher',
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockTwitterJson,
    } as any);

    const result = await parseTwitter('https://x.com/airesearcher/status/1234567890');
    expect(result.type).toBe('twitter');
    expect(result.author).toBe('@airesearcher');
    expect(result.content).toContain('Excited to announce our new open weights model!');
    expect(result.content).toContain('❤️ 1200 赞');
  });

  it('should parse general web article fallback', async () => {
    const mockWebHtml = `
      <html>
        <head><title>Tech News Daily</title></head>
        <body>
          <main><p>This is a general news article body.</p></main>
        </body>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => mockWebHtml,
    } as any);

    const result = await parseGeneralWeb('https://example.com/news/1');
    expect(result.type).toBe('web');
    expect(result.title).toBe('Tech News Daily');
    expect(result.content).toContain('This is a general news article body.');
  });
});
