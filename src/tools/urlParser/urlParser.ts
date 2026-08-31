/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file urlParser.ts
 * @description Smart content extractor for ArXiv, GitHub, WeChat MP, Zhihu, X/Twitter, and general Web pages.
 */

import type { ParsedLinkType, ParsedLinkContent } from './types.js';
import { logger } from '../../utils/logger.js';
import { assertSafeRemoteUrl, fetchSafeRemote } from '../../utils/safeUrl.js';

const REQUEST_TIMEOUT_MS = 15_000;

const USER_AGENT_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const USER_AGENT_WECHAT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.38(0x1800262c) NetType/WIFI Language/zh_CN';

interface GitHubRepoData {
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  license?: { spdx_id?: string; name?: string } | null;
  topics?: string[];
}

function asGitHubRepoData(value: unknown): GitHubRepoData | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as GitHubRepoData
    : null;
}

/**
 * Detects the platform type based on the URL pattern.
 */
export function detectLinkType(urlStr: string): ParsedLinkType {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();

    if (host.includes('arxiv.org')) return 'arxiv';
    if (host.includes('github.com')) return 'github';
    if (host.includes('mp.weixin.qq.com')) return 'weixin';
    if (host.includes('zhihu.com')) return 'zhihu';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
    return 'web';
  } catch {
    return 'web';
  }
}

/**
 * Checks if a string contains or starts with a valid HTTP/HTTPS URL.
 */
export function extractFirstUrl(text: string): string | null {
  const match = /(https?:\/\/[^\s]+)/i.exec(text);
  if (!match) return null;
  let url = match[1];
  // Clean trailing punctuation
  url = url.replace(/[),.!?;:，。！？）]+$/, '');
  return url;
}

/**
 * Helper to strip HTML tags and decode common entities to plain markdown text.
 */
export function cleanHtmlToMarkdown(html: string): string {
  if (!html) return '';

  let text = html
    // Strip scripts, styles, svgs, noscripts, iframes
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    // Headings
    .replace(/<h[1-2][^>]*>(.*?)<\/h[1-2]>/gi, '\n\n## $1\n\n')
    .replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, '\n\n### $1\n\n')
    // Paragraphs and breaks
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    // Lists
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n• $1')
    // Bold / Italic
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    // Normalize newlines and spaces
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// ── 1. ArXiv Parser ─────────────────────────────────────────────────────────

export async function parseArXiv(urlStr: string): Promise<ParsedLinkContent> {
  const url = new URL(urlStr);
  await assertSafeRemoteUrl(urlStr);
  const match = /(?:abs|pdf)\/([a-zA-Z0-9.\-_/]+)(?:\.pdf)?/i.exec(url.pathname);
  const arxivId = match ? match[1].replace(/\.pdf$/, '') : '';

  if (!arxivId) {
    return parseGeneralWeb(urlStr);
  }

  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await fetchSafeRemote(apiUrl, {
    headers: { 'User-Agent': USER_AGENT_BROWSER },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`ArXiv API returned status ${res.status}`);
  }

  const xml = await res.text();

  // Extract metadata from Atom XML
  const titleMatch = /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/i.exec(xml);
  const summaryMatch = /<entry>[\s\S]*?<summary>([\s\S]*?)<\/summary>/i.exec(xml);
  const publishedMatch = /<entry>[\s\S]*?<published>([\s\S]*?)<\/published>/i.exec(xml);
  const primaryCatMatch = /<arxiv:primary_category[^>]*term="([^"]+)"/i.exec(xml);

  // Extract all authors
  const authors: string[] = [];
  const authorRegex = /<author>\s*<name>([^<]+)<\/name>/gi;
  let m: RegExpExecArray | null;
  while ((m = authorRegex.exec(xml)) !== null) {
    authors.push(m[1].trim());
  }

  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : `ArXiv Paper ${arxivId}`;
  const abstract = summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : '';
  const publishedAt = publishedMatch ? publishedMatch[1].trim().slice(0, 10) : undefined;
  const category = primaryCatMatch ? primaryCatMatch[1] : undefined;

  const content =
    `# 📄 ${title}\n\n` +
    `• **ArXiv ID**: \`${arxivId}\`\n` +
    `• **作者**: ${authors.join(', ') || 'N/A'}\n` +
    `• **发布日期**: ${publishedAt || 'N/A'}\n` +
    (category ? `• **领域分类**: \`${category}\`\n` : '') +
    `• **PDF 原文**: https://arxiv.org/pdf/${arxivId}.pdf\n\n` +
    `## 📑 论文摘要 (Abstract)\n\n${abstract}`;

  return {
    url: urlStr,
    type: 'arxiv',
    title,
    author: authors.join(', '),
    publishedAt,
    abstract,
    content,
    extra: { arxivId, category, pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf` },
  };
}

// ── 2. GitHub Parser ────────────────────────────────────────────────────────

export async function parseGitHub(urlStr: string): Promise<ParsedLinkContent> {
  const url = new URL(urlStr);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return parseGeneralWeb(urlStr);
  }

  const owner = parts[0];
  const repo = parts[1];
  const repoFullName = `${owner}/${repo}`;

  // 1. Fetch repo metadata via GitHub REST API
  let repoData: GitHubRepoData | null = null;
  try {
    const apiRes = await fetchSafeRemote(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'User-Agent': 'gemini-cli-telegram-bot',
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (apiRes.ok) {
      repoData = asGitHubRepoData(await apiRes.json());
    }
  } catch (err) {
    logger.warn(`[GitHubParser] API lookup failed for ${repoFullName}: ${err}`);
  }

  // 2. Fetch raw README.md
  let readmeText = '';
  const branches = ['main', 'master', 'HEAD'];
  for (const branch of branches) {
    try {
      const readmeRes = await fetchSafeRemote(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (readmeRes.ok) {
        readmeText = await readmeRes.text();
        break;
      }
    } catch {}
  }

  const title = repoData?.full_name || repoFullName;
  const description = repoData?.description || 'No description provided.';
  const stars = repoData?.stargazers_count ?? '--';
  const forks = repoData?.forks_count ?? '--';
  const language = repoData?.language || 'Unknown';
  const license = repoData?.license?.spdx_id || repoData?.license?.name || 'None';
  const topics = repoData?.topics?.join(', ') || '';

  const content =
    `# 💻 GitHub 仓库: ${title}\n\n` +
    `• **项目简介**: ${description}\n` +
    `• **核心语言**: \`${language}\` | **Stars**: ⭐ ${stars} | **Forks**: 🍴 ${forks}\n` +
    `• **开源协议**: ${license}\n` +
    (topics ? `• **标签 Topics**: \`${topics}\`\n` : '') +
    `• **仓库链接**: https://github.com/${repoFullName}\n\n` +
    `---\n\n` +
    `## 📖 README 核心内容\n\n${readmeText || description}`;

  return {
    url: urlStr,
    type: 'github',
    title,
    author: owner,
    content,
    extra: { owner, repo, stars, forks, language, license },
  };
}

// ── 3. WeChat Official Account Parser ───────────────────────────────────────

export async function parseWeChat(urlStr: string): Promise<ParsedLinkContent> {
  const res = await fetchSafeRemote(urlStr, {
    headers: {
      'User-Agent': USER_AGENT_WECHAT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`WeChat request failed with status ${res.status}`);
  }

  const html = await res.text();

  // Extract title
  const titleMatch =
    /<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html);
  const title = titleMatch ? cleanHtmlToMarkdown(titleMatch[1]).replace(/\n/g, ' ').trim() : '微信公众号文章';

  // Extract author / account
  const authorMatch =
    /<span[^>]*class="[^"]*rich_media_meta_text[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html) ||
    /<meta[^>]*name="author"[^>]*content="([^"]*)"/i.exec(html);
  const author = authorMatch ? cleanHtmlToMarkdown(authorMatch[1]).trim() : undefined;

  const accountMatch = /<strong[^>]*class="[^"]*profile_nickname[^"]*"[^>]*>([\s\S]*?)<\/strong>/i.exec(html);
  const accountName = accountMatch ? cleanHtmlToMarkdown(accountMatch[1]).trim() : undefined;

  // Extract body content (#js_content)
  const contentMatch = /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="rich_media_tool"/i.exec(html) ||
    /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>/i.exec(html);

  const rawBody = contentMatch ? contentMatch[1] : html;
  const bodyMarkdown = cleanHtmlToMarkdown(rawBody);

  const content =
    `# 📱 ${title}\n\n` +
    (accountName ? `• **公众号**: ${accountName}\n` : '') +
    (author ? `• **作者**: ${author}\n` : '') +
    `• **原文链接**: ${urlStr}\n\n` +
    `---\n\n${bodyMarkdown}`;

  return {
    url: urlStr,
    type: 'weixin',
    title,
    author: author || accountName,
    content,
    extra: { accountName },
  };
}

// ── 4. Zhihu Parser ─────────────────────────────────────────────────────────

export async function parseZhihu(urlStr: string): Promise<ParsedLinkContent> {
  const res = await fetchSafeRemote(urlStr, {
    headers: {
      'User-Agent': USER_AGENT_BROWSER,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Zhihu request failed with status ${res.status}`);
  }

  const html = await res.text();

  const titleMatch =
    /<h1[^>]*class="[^"]*Post-Title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
    /<h1[^>]*class="[^"]*QuestionHeader-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ||
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html);
  const title = titleMatch ? cleanHtmlToMarkdown(titleMatch[1]).replace(/\n/g, ' ').trim() : '知乎专栏/问答';

  const authorMatch =
    /<meta[^>]*name="author"[^>]*content="([^"]*)"/i.exec(html) ||
    /<span[^>]*class="[^"]*AuthorInfo-name[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  const author = authorMatch ? cleanHtmlToMarkdown(authorMatch[1]).trim() : undefined;

  // Extract main article/answer text
  const richTextMatch =
    /<div[^>]*class="[^"]*Post-RichText[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html) ||
    /<div[^>]*class="[^"]*RichContent-inner[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);

  const rawBody = richTextMatch ? richTextMatch[1] : html;
  const bodyMarkdown = cleanHtmlToMarkdown(rawBody);

  const content =
    `# 💡 ${title}\n\n` +
    (author ? `• **作者**: ${author}\n` : '') +
    `• **知乎链接**: ${urlStr}\n\n` +
    `---\n\n${bodyMarkdown}`;

  return {
    url: urlStr,
    type: 'zhihu',
    title,
    author,
    content,
  };
}

// ── 5. X / Twitter Parser ───────────────────────────────────────────────────

export async function parseTwitter(urlStr: string): Promise<ParsedLinkContent> {
  const url = new URL(urlStr);
  const match = /\/([^/]+)\/status\/(\d+)/i.exec(url.pathname);
  if (!match) {
    return parseGeneralWeb(urlStr);
  }

  const user = match[1];
  const tweetId = match[2];

  // Use reliable fxtwitter JSON API
  try {
    const apiUrl = `https://api.fxtwitter.com/${user}/status/${tweetId}`;
    const res = await fetchSafeRemote(apiUrl, {
      headers: { 'User-Agent': 'gemini-cli-telegram-bot' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      const data = await res.json();
      const tweet = data?.tweet;
      if (tweet) {
        const authorName = tweet.author?.name || user;
        const authorHandle = tweet.author?.screen_name || user;
        const tweetText = tweet.text || '';
        const likes = tweet.likes ?? 0;
        const retweets = tweet.retweets ?? 0;
        const views = tweet.views ?? 0;
        const date = tweet.created_at || '';

        const title = `X/Twitter Post by @${authorHandle}`;
        const content =
          `# 🐦 ${title}\n\n` +
          `• **作者**: ${authorName} (@${authorHandle})\n` +
          `• **发布时间**: ${date}\n` +
          `• **互动数据**: ❤️ ${likes} 赞 | 🔁 ${retweets} 转发 | 👁️ ${views} 浏览\n` +
          `• **推文链接**: https://x.com/${authorHandle}/status/${tweetId}\n\n` +
          `---\n\n${tweetText}`;

        return {
          url: urlStr,
          type: 'twitter',
          title,
          author: `@${authorHandle}`,
          publishedAt: date,
          content,
          extra: { likes, retweets, views },
        };
      }
    }
  } catch (err) {
    logger.warn(`[TwitterParser] fxtwitter API failed for ${tweetId}: ${err}`);
  }

  return parseGeneralWeb(urlStr);
}

// ── 6. General Web Parser (Fallback) ────────────────────────────────────────

export async function parseGeneralWeb(urlStr: string): Promise<ParsedLinkContent> {
  const res = await fetchSafeRemote(urlStr, {
    headers: {
      'User-Agent': USER_AGENT_BROWSER,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch web page: HTTP ${res.status}`);
  }

  const html = await res.text();

  const titleMatch =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ||
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html);
  const title = titleMatch ? cleanHtmlToMarkdown(titleMatch[1]).replace(/\n/g, ' ').trim() : urlStr;

  const descMatch =
    /<meta[^>]*name="description"[^>]*content="([^"]*)"/i.exec(html) ||
    /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i.exec(html);
  const abstract = descMatch ? cleanHtmlToMarkdown(descMatch[1]).trim() : undefined;

  // Extract main body
  const bodyRegex = /<main[^>]*>([\s\S]*?)<\/main>|<article[^>]*>([\s\S]*?)<\/article>|<body[^>]*>([\s\S]*?)<\/body>/i;
  const bodyMatch = bodyRegex.exec(html);
  const rawBody = bodyMatch ? (bodyMatch[1] || bodyMatch[2] || bodyMatch[3]) : html;
  const bodyMarkdown = cleanHtmlToMarkdown(rawBody);

  const content =
    `# 🌐 ${title}\n\n` +
    `• **原文链接**: ${urlStr}\n\n` +
    `---\n\n${bodyMarkdown || abstract || '_未能提取到有效正文_'}`;

  return {
    url: urlStr,
    type: 'web',
    title,
    abstract,
    content,
  };
}

/**
 * Universal content fetcher that automatically routes to the appropriate platform parser.
 */
export async function parseUrlContent(urlStr: string): Promise<ParsedLinkContent> {
  await assertSafeRemoteUrl(urlStr);
  const type = detectLinkType(urlStr);
  logger.info(`[UrlParser] Parsing link="${urlStr}" detectedType="${type}"`);

  switch (type) {
    case 'arxiv':
      return await parseArXiv(urlStr);
    case 'github':
      return await parseGitHub(urlStr);
    case 'weixin':
      return await parseWeChat(urlStr);
    case 'zhihu':
      return await parseZhihu(urlStr);
    case 'twitter':
      return await parseTwitter(urlStr);
    case 'web':
    default:
      return await parseGeneralWeb(urlStr);
  }
}
