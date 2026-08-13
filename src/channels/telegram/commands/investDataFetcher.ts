/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investDataFetcher.ts
 * @description Runs the value-invest-analysis project's deterministic analysis
 * script (getDataset + analyze) as a subprocess and returns the structured
 * JSON result. The bot feeds this data to the model so it can write a deep
 * report from real data instead of relying on the model to fetch it itself.
 */

import { execFile } from 'node:child_process';
import { getStockMarketApiKey, loadUserConfig } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';

const SCRIPT_TIMEOUT_MS = 60_000;

export interface InvestDataFetchResult {
  ok: boolean;
  symbol?: string;
  data?: string;
  error?: string;
}

/** Locate the value-invest-analysis project directory from user config. */
export function getInvestProjectPath(): string {
  try {
    const userConfig = loadUserConfig();
    const investProj = userConfig?.projects?.find(
      (p) => p.name === '价值投资分析专家' || p.path?.endsWith('value-invest-analysis')
    );
    if (investProj?.path) {
      return investProj.path;
    }
  } catch (e) {
    logger.warn(`[investDataFetcher] Failed to resolve invest project path: ${e}`);
  }
  return process.cwd();
}

const ANALYZE_SCRIPT = `
import { getDataset } from './dist/data/index.js';
import { analyze } from './dist/agent/analyzer.js';
const symbol = process.argv[1];
if (!symbol) {
  console.error('NO_SYMBOL');
  process.exit(2);
}
getDataset(symbol).then((ds) => {
  const r = analyze(ds);
  const out = {
    symbol: r.symbol,
    name: r.name,
    market: r.market,
    currency: r.currency,
    price: r.price,
    grade: r.grade,
    totalScore: r.totalScore,
    rating: r.rating,
    summary: r.summary,
    redFlags: r.redFlags,
    dimensions: (r.dimensions ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      score: d.score,
      weight: d.weight,
      notes: d.notes ?? [],
    })),
  };
  process.stdout.write(JSON.stringify(out));
}).catch((e) => {
  console.error('DATA_ERROR:' + (e?.message ?? String(e)));
  process.exit(1);
});
`;

/**
 * Run the value-invest-analysis script for the given symbol and return the
 * scored dimensions as a compact prompt fragment. Returns null on failure so
 * the caller can fall back to a plain AI query.
 */
export function fetchInvestAnalysis(symbol: string, cwd?: string): Promise<InvestDataFetchResult> {
  const projectPath = cwd || getInvestProjectPath();
  const apiKey = getStockMarketApiKey();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (apiKey) env['FMP_API_KEY'] = apiKey;

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', ANALYZE_SCRIPT, '--', symbol],
      {
        cwd: projectPath,
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const stderrTail = (stderr || '').split('\n').slice(0, 3).join(' ').trim();
          logger.warn(`[investDataFetcher] script failed for ${symbol}: ${err.message} ${stderrTail}`);
          resolve({ ok: false, error: stderrTail || err.message });
          return;
        }
        const out = stdout?.trim();
        if (!out) {
          resolve({ ok: false, error: 'empty output' });
          return;
        }
        try {
          const parsed = JSON.parse(out) as { symbol?: unknown; grade?: unknown; totalScore?: unknown };
          const parsedSymbol = parsed.symbol != null ? String(parsed.symbol) : symbol;
          const parsedGrade = parsed.grade != null ? String(parsed.grade) : '?';
          const parsedScore = parsed.totalScore != null ? String(parsed.totalScore) : '?';
          logger.info(`[investDataFetcher] analysis OK for ${parsedSymbol}: grade=${parsedGrade} score=${parsedScore}`);
          resolve({ ok: true, symbol: parsedSymbol, data: out });
        } catch {
          logger.warn(`[investDataFetcher] non-JSON output for ${symbol}: ${out.slice(0, 120)}`);
          resolve({ ok: false, error: 'invalid JSON output' });
        }
      }
    );
  });
}

/** Build a prompt that injects the deterministic analysis data before the user's original query. */
export function buildInvestPrompt(userQuery: string, data: string): string {
  return [
    '用户请求执行价值投资分析。以下是价值投资分析专家脚本已确定性抓取并评分好的结构化数据（无需再自行联网抓取，直接基于这些数据分析并输出深度报告）：',
    '',
    '```json',
    data,
    '```',
    '',
    '请基于上述结构化数据，输出一份深度价值投资分析报告。',
    '',
    '## 报告要求',
    '1. 用中文输出，Markdown 格式。',
    '2. 结构：结论摘要（含综合评分、评级、红旗）→ 六维度逐项分析 → 估值判断 → 投资建议。',
    '3. 结合维度评分与数据给出明确结论（强烈看多/看多/中性/看空/强烈看空），并提示风险。',
    '4. 缺失数据明确写"未知/未提供"，不得编造。',
    '',
    `## 原始问题`,
    userQuery,
  ].join('\n');
}