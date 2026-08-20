/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file router.test.ts
 * @description Tests for the Auto-model query classifier and heuristic fallback routing.
 */




import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn(),
}));

import { classifyHeuristic, resolveModelForCategory, classifyAndRouteQuery, AUTO_MODEL_NAME } from './router.js';
import * as userConfig from '../config/userConfig.js';
import { runAgyPrint } from '../agy/agyCli.js';

const MOCK_TIERS = [
  { name: '旗舰', priority: 0, models: ['Codex: GPT-5.6 Sol', 'Claude CLI: Claude Opus 5'] },
  { name: '高级', priority: 1, models: ['Gemini 3.7 Flash (High)', 'OpenCode: Big Pickle'] },
  { name: '远程备用', priority: 4, models: ['Web2API: Gemini 3.5 Flash Lite', 'Web2API: Gemini 3.7 Flash'] },
];

function mockTiers() {
  vi.spyOn(userConfig, 'loadUserConfig').mockReturnValue({
    telegramBotToken: 'token',
    allowedUsers: [1],
    modelsConfig: {
      tiers: MOCK_TIERS,
      routing: {},
    },
  } as any);
}

describe('router', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTiers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('AUTO_MODEL_NAME', () => {
    it('should be the 🤖 Auto display name', () => {
      expect(AUTO_MODEL_NAME).toBe('🤖 Auto (智能分流)');
    });
  });

  describe('classifyHeuristic', () => {
    it('should classify code-heavy prompts as A', () => {
      expect(classifyHeuristic('fix this TypeError and add tests', '')).toBe('A');
      expect(classifyHeuristic('```\nfunction x() {}\n```', '')).toBe('A');
      expect(classifyHeuristic('帮我重构这个分布式架构', '')).toBe('A');
      expect(classifyHeuristic('实现一个 raft 一致性算法', '')).toBe('A');
    });

    it('should classify simple chitchat / short translation as C', () => {
      expect(classifyHeuristic('你好', '')).toBe('C');
      expect(classifyHeuristic('用一句话解释什么是路由', '')).toBe('C');
      expect(classifyHeuristic('早安', '')).toBe('C');
    });

    it('should default to B for general technical discussion', () => {
      expect(classifyHeuristic('聊聊 TypeScript 和 Go 的取舍', '')).toBe('B');
      expect(classifyHeuristic('对比一下几个消息队列方案', '')).toBe('B');
    });

    it('should consider context summary for A-keyword matching', () => {
      expect(classifyHeuristic('继续', '当前任务涉及 k8s 部署排障')).toBe('A');
    });
  });

  describe('resolveModelForCategory', () => {
    it('should map A to tier 0 first model', () => {
      expect(resolveModelForCategory('A')).toBe('Codex: GPT-5.6 Sol');
    });

    it('should map B to tier 1 first model', () => {
      expect(resolveModelForCategory('B')).toBe('Gemini 3.7 Flash (High)');
    });

    it('should map C to a free tier-4 Web2API model', () => {
      expect(resolveModelForCategory('C')).toBe('Web2API: Gemini 3.5 Flash Lite');
    });
  });

  describe('classifyAndRouteQuery', () => {
    it('should use LLM result when the classifier responds', async () => {
      vi.mocked(runAgyPrint).mockResolvedValue({
        output: 'A',
        conversationId: 'classifier-conv',
        exitCode: 0,
      } as any);

      const decision = await classifyAndRouteQuery('写一个分布式限流器', '', '/tmp');

      expect(decision.method).toBe('llm');
      expect(decision.category).toBe('A');
      expect(decision.targetModel).toBe('Codex: GPT-5.6 Sol');
      expect(runAgyPrint).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Web2API: Gemini 3.5 Flash Lite', allowTools: false })
      );
    });

    it('should fall back to heuristic when the LLM call throws', async () => {
      vi.mocked(runAgyPrint).mockRejectedValue(new Error('Classifier timeout'));

      const decision = await classifyAndRouteQuery('你好', '', '/tmp');

      expect(decision.method).toBe('heuristic');
      expect(decision.category).toBe('C');
      expect(decision.targetModel).toBe('Web2API: Gemini 3.5 Flash Lite');
      expect(decision.reason).toBe('Classifier timeout');
    });

    it('should default to B when the classifier output is unparseable', async () => {
      vi.mocked(runAgyPrint).mockResolvedValue({
        output: '42',
        conversationId: 'c',
        exitCode: 0,
      } as any);

      const decision = await classifyAndRouteQuery('讲讲量子计算', '', '/tmp');

      expect(decision.method).toBe('llm');
      expect(decision.category).toBe('B');
    });
  });
});