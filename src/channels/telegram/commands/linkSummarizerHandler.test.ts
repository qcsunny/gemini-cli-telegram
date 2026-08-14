/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateLinkSummary,
  registerLinkSummarizerCommands,
} from './linkSummarizerHandler.js';
import * as inlineHandler from './inlineHandler.js';
import type { ParsedLinkContent } from '../../../tools/urlParser/types.js';

describe('linkSummarizerHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockParsedArXiv: ParsedLinkContent = {
    url: 'https://arxiv.org/abs/1706.03762',
    type: 'arxiv',
    title: 'Attention Is All You Need',
    author: 'Ashish Vaswani et al.',
    abstract: 'Transformer architecture introduction.',
    content: 'Full content of the paper abstract and methodology.',
  };

  it('should generate link summary using fallback model chain', async () => {
    vi.spyOn(inlineHandler, 'runModelWithFallbackChain').mockResolvedValueOnce({
      result: { output: '### 📄 Attention Is All You Need 精读报告\n\n1. 研究动机：取代 RNN 提高并行计算效率。' } as any,
      modelUsed: 'Gemini 3.7 Flash (High)',
      isFallback: false,
    });

    const res = await generateLinkSummary(mockParsedArXiv);
    expect(res.markdown).toContain('Attention Is All You Need 精读报告');
    expect(res.markdown).toContain('研究动机');
    expect(res.modelUsed).toBe('Gemini 3.7 Flash (High)');
  });

  it('should register /read and /summary commands on the bot', () => {
    const bot = {
      command: vi.fn(),
    } as any;

    registerLinkSummarizerCommands(bot);
    expect(bot.command).toHaveBeenCalledWith(['read', 'summary'], expect.any(Function));
  });
});
