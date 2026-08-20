/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investDataFetcher.ts
 * @description Runs the value-invest-analysis project's deterministic report
 * JSON entrypoint (dist/bin/json.js) as a subprocess and returns the structured
 * JSON result. The data contract (scoring, quote, financial snapshots, red
 * flags) is owned by the value-invest-analysis project, not by this bot.
 */

import { execFile } from 'node:child_process';
import { getStockMarketApiKey, loadUserConfig } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';

const SCRIPT_TIMEOUT_MS = 60_000;
/** Entrypoint inside the value-invest-analysis project that emits the report JSON on stdout. */
const REPORT_ENTRY = 'dist/bin/json.js';
/**
 * Max parallel report subprocesses. Each spawn is a cold start (no shared
 * in-process cache) that hits the upstream APIs (Eastmoney/Tencent/FMP). FMP
 * free tier has a daily request quota and returns HTTP 429 on burst; Eastmoney
 * can rate-limit parallel requests. Keep concurrency low to spread requests.
 */
const MAX_CONCURRENCY = 2;

interface InvestDataFetchResult {
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

/**
 * Run the value-invest-analysis report JSON entrypoint for the given symbol and
 * return the structured data as a compact prompt fragment. Returns ok:false on
 * failure so the caller can fall back to a plain AI query.
 */
export function fetchInvestAnalysis(symbol: string, cwd?: string): Promise<InvestDataFetchResult> {
  return runReportScript([symbol], cwd).then((r) => r[0]);
}

/**
 * Run the value-invest-analysis report JSON entrypoint for multiple symbols in
 * parallel and return one result per symbol (same order as input). Each failing
 * symbol yields { ok:false, error } so the caller can decide whether to fall
 * back entirely or keep the successful ones. Symbols are deduped to avoid
 * redundant subprocess spawns.
 */
export function fetchInvestAnalyses(symbols: string[], cwd?: string): Promise<InvestDataFetchResult[]> {
  const unique = [...new Set(symbols.filter((s) => s && s.trim()))];
  if (unique.length === 0) return Promise.resolve([]);
  return runReportScript(unique, cwd);
}

function runReportScript(symbols: string[], cwd?: string): Promise<InvestDataFetchResult[]> {
  const projectPath = cwd || getInvestProjectPath();
  const apiKey = getStockMarketApiKey();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (apiKey) env['FMP_API_KEY'] = apiKey;

  const runOne = (symbol: string): Promise<InvestDataFetchResult> =>
    new Promise<InvestDataFetchResult>((resolve) => {
      execFile(
        process.execPath,
        [REPORT_ENTRY, symbol],
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

  // Run with a concurrency cap: spawn at most MAX_CONCURRENCY subprocesses at a
  // time so bursts of /invest comparisons do not hammer the upstream APIs.
  const results = new Array<InvestDataFetchResult>(symbols.length);
  let next = 0;
  const pump = async (): Promise<void> => {
    while (next < symbols.length) {
      const idx = next;
      next += 1;
      results[idx] = await runOne(symbols[idx]!);
    }
  };
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, symbols.length) }, () => pump());
  return Promise.all(workers).then(() => results);
}

/** Build a prompt that injects the deterministic analysis data. Output format is governed by the AGENTS.md report spec, so only the data is injected here. */
export function buildInvestPrompt(userQuery: string, data: string): string {
  return [
    '以下是价值投资分析专家脚本已确定性抓取并评分好的结构化数据（仅数据层，输出规范见项目 AGENTS.md「生成规范」，勿重复添加报告结构要求）：',
    '',
    '```json',
    data,
    '```',
    '',
    `用户问题：${userQuery}`,
  ].join('\n');
}

/**
 * Build a prompt for a multi-symbol comparison. Each symbol's report JSON is
 * wrapped in a JSON array; the AGENTS.md「生成规范」comparison section governs
 * the output format. Symbols that failed are listed so the model knows they are
 * absent rather than inventing data.
 */
export function buildComparePrompt(
  results: InvestDataFetchResult[],
  userQuery: string
): string {
  const ok = results.filter((r) => r.ok && r.data);
  const failed = results.filter((r) => !r.ok);
  const lines = [
    '以下是价值投资分析专家脚本已确定性抓取并评分好的【同行业多公司对比数据】（仅数据层，输出规范见项目 AGENTS.md「生成规范」的对比报告章节，勿重复添加报告结构要求）：',
    '',
    '```json',
    '[',
    ok.map((r) => r.data).join(',\n'),
    ']',
    '```',
  ];
  if (failed.length > 0) {
    lines.push(
      '',
      '以下标的脚本抓取失败（数据缺失，不得臆造，可在报告末尾注明或忽略）：',
      failed.map((f) => `- ${f.symbol ?? '?'}: ${f.error ?? 'unknown error'}`).join('\n')
    );
  }
  lines.push('', `用户问题：${userQuery}`);
  return lines.join('\n');
}