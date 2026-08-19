/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file router.ts
 * @description Smart Complexity & Semantic Intent Router.
 * Uses Web2API: Gemini Flash Lite as a fast zero-cost pre-classifier with local heuristic fallback.
 */

import { runAgyPrint } from '../agy/agyCli.js';
import { logger } from '../utils/logger.js';
import { getEffectiveTiers } from './modelRegistry.js';

export const AUTO_MODEL_NAME = '🤖 Auto (智能分流)';

export type QueryComplexityLevel = 'A' | 'B' | 'C';

export interface RouteDecision {
  targetModel: string;
  category: QueryComplexityLevel;
  method: 'llm' | 'heuristic';
  elapsedMs: number;
  reason?: string;
}

const CLASSIFIER_MODEL = 'Web2API: Gemini Flash Lite';
const CLASSIFIER_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = `你是一个大模型任务复杂度智能路由器。请根据用户的问题（及上下文），评估其任务复杂度并【只输出单个大写字母 A、B 或 C】：

A: 复杂编程开发 / 算法设计 / 崩溃报错排查 / 深度数理证明 / 系统架构重构 / 复杂代码编写
B: 综合技术探讨 / 方案对比选型 / 专业概念深入解释 / 长篇文档分析 / 数据推演
C: 简单日常闲聊 / 基础事实快问 / 短句翻译 / 文本语法润色 / 问候与简短问答

规则：只能输出 A、B、或 C，严禁输出任何解释或标点符号。`;

/**
 * Fast local heuristic classifier (0ms fallback).
 */
export function classifyHeuristic(prompt: string, contextSummary = ''): QueryComplexityLevel {
  const combined = `${contextSummary} ${prompt}`.toLowerCase();
  
  if (/```|class\s+|interface\s+|def\s+|async\s+|function\s+|Traceback|NullPointerException|TypeError|panic:/i.test(prompt)) {
    return 'A';
  }
  if (/并发|重构|算法|架构|多线程|死锁|内存泄漏|raft|redis|kafka|docker|k8s|数学证明|公式推导/i.test(combined)) {
    return 'A';
  }
  if (prompt.length < 80 && /^你好|在吗|早安|晚安|用一句话|简短|翻译|润色|改写|是什么|谁是/i.test(prompt)) {
    return 'C';
  }
  return 'B';
}

export function resolveModelForCategory(category: QueryComplexityLevel): string {
  const tiers = getEffectiveTiers();
  if (tiers && tiers.length > 0) {
    if (category === 'A') {
      // Tier 0 (Flagship)
      const tier0 = tiers.find(t => t.priority === 0);
      if (tier0 && tier0.models.length > 0) {
        return tier0.models[0];
      }
    } else if (category === 'B') {
      // Tier 1 (Advanced)
      const tier1 = tiers.find(t => t.priority === 1);
      if (tier1 && tier1.models.length > 0) {
        return tier1.models[0];
      }
    } else {
      // Tier 4 (Remote/Free Web2API)
      const tier4 = tiers.find(t => t.priority === 4);
      if (tier4 && tier4.models.length > 0) {
        const web2api = tier4.models.find(m => m.includes('Flash Lite') || m.includes('3.7 Flash')) || tier4.models[0];
        return web2api;
      }
    }
  }
  // Fallback defaults
  if (category === 'A') return 'Claude CLI: Claude Opus 5';
  if (category === 'B') return 'Gemini 3.7 Flash (High)';
  return 'Web2API: Gemini Flash Lite';
}

/**
 * Classify user prompt and determine optimal execution model.
 */
export async function classifyAndRouteQuery(prompt: string, contextSummary = '', cwd?: string): Promise<RouteDecision> {
  const t0 = Date.now();

  let fullPrompt = `${SYSTEM_PROMPT}\n\n`;
  if (contextSummary) {
    fullPrompt += `[上下文背景: ${contextSummary.slice(0, 300)}]\n`;
  }
  fullPrompt += `[用户当前输入: "${prompt.slice(0, 500)}"]\n\n请输出分类级别 (A/B/C):`;

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const controller = new AbortController();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        // Kill the classification subprocess so it can't linger in the
        // background after the race was lost.
        controller.abort();
        reject(new Error('Classifier timeout'));
      }, CLASSIFIER_TIMEOUT_MS);
    });

    const classifyPromise = runAgyPrint({
      prompt: fullPrompt,
      model: CLASSIFIER_MODEL,
      cwd: cwd || process.cwd(),
      allowTools: false,
      signal: controller.signal,
    });

    const res = await Promise.race([classifyPromise, timeoutPromise]);
    const raw = (res.output || '').trim();
    const match = raw.match(/[ABC]/i);
    const category: QueryComplexityLevel = match ? (match[0].toUpperCase() as QueryComplexityLevel) : 'B';
    const targetModel = resolveModelForCategory(category);
    const elapsedMs = Date.now() - t0;

    logger.info(`[smartRouter] Classified via LLM (${elapsedMs}ms): level=${category} -> targetModel="${targetModel}"`);
    return {
      targetModel,
      category,
      method: 'llm',
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const category = classifyHeuristic(prompt, contextSummary);
    const targetModel = resolveModelForCategory(category);
    logger.info(`[smartRouter] LLM classification failed (${err instanceof Error ? err.message : err}), fallback to heuristic: level=${category} -> targetModel="${targetModel}"`);
    return {
      targetModel,
      category,
      method: 'heuristic',
      elapsedMs,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
