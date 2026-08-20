/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file types.ts
 * @description Types for the smart URL and platform content parser.
 */

export type ParsedLinkType = 'arxiv' | 'github' | 'weixin' | 'zhihu' | 'twitter' | 'web';

export interface ParsedLinkContent {
  url: string;
  type: ParsedLinkType;
  title: string;
  author?: string;
  publishedAt?: string;
  abstract?: string;
  content: string; // Cleaned Markdown / plain text
  extra?: Record<string, unknown>;
}
