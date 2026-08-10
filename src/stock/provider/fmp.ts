/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file fmp.ts
 * @description Financial Modeling Prep (FMP) recent quarterly income statement fetcher.
 * Used to enrich stock cards with recent earnings data. Requires a config.json
 * "stockMarketApiKey" (FMP key) — when absent, no requests are made.
 */

import { fetch as undiciFetch } from 'undici';
import type { StockFinancial } from '../types.js';
import { logger } from '../../utils/logger.js';

const FMP_BASE = 'https://financialmodelingprep.com/stable/income-statement';
const FETCH_TIMEOUT_MS = 3000;
const MAX_PERIODS = 5;

/**
 * Fetches the most recent quarterly income statements for a symbol via FMP.
 * Returns an array of StockFinancial (newest first), or null when no API key is
 * configured, the request fails, or the symbol is not found.
 */
export async function fetchRecentFinancials(
  symbol: string,
  apiKey: string,
): Promise<StockFinancial[] | null> {
  if (!apiKey) return null;

  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${FMP_BASE}?symbol=${encodeURIComponent(cleanSym)}&period=quarter&limit=${MAX_PERIODS}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[FMP] Failed for ${cleanSym}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json) || json.length === 0) {
      logger.warn(`[FMP] No financial data for ${cleanSym}`);
      return null;
    }
    const financials: StockFinancial[] = [];
    for (const raw of json) {
      const num = (v: unknown): number | undefined => {
        const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        return Number.isFinite(n) ? n : undefined;
      };
      const date = typeof raw['date'] === 'string' ? raw['date'] : '';
      const period = typeof raw['period'] === 'string' ? raw['period'] : '';
      const revenue = num(raw['revenue']);
      const netIncome = num(raw['netIncome']);
      if (!date || !period || revenue === undefined || netIncome === undefined) continue;
      financials.push({
        date,
        filingDate: typeof raw['filingDate'] === 'string' ? raw['filingDate'] : undefined,
        period: `${typeof raw['fiscalYear'] === 'number' ? raw['fiscalYear'] : ''} ${period}`.trim(),
        revenue,
        grossProfit: num(raw['grossProfit']),
        operatingIncome: num(raw['operatingIncome']),
        netIncome,
        epsDiluted: num(raw['epsDiluted']),
        currency: typeof raw['reportedCurrency'] === 'string' ? raw['reportedCurrency'] : undefined,
      });
    }
    if (financials.length === 0) return null;
    for (let i = 0; i < financials.length; i++) {
      const cur = financials[i];
      const prev = financials[i + 1]; // previous quarter (older)
      const yearAgo = financials[i + 4]; // same quarter, previous year
      const pct = (base: number | undefined, cmp: number | undefined): number | null | undefined =>
        base !== undefined && cmp !== undefined && cmp !== 0 ? ((base - cmp) / cmp) * 100 : null;
      cur.revenueYoY = pct(cur.revenue, yearAgo?.revenue);
      cur.revenueQoQ = pct(cur.revenue, prev?.revenue);
      cur.netIncomeYoY = pct(cur.netIncome, yearAgo?.netIncome);
      cur.netIncomeQoQ = pct(cur.netIncome, prev?.netIncome);
      cur.grossMargin =
        cur.grossProfit !== undefined && cur.revenue !== 0
          ? (cur.grossProfit / cur.revenue) * 100
          : null;
      cur.netMargin = cur.revenue !== 0 ? (cur.netIncome / cur.revenue) * 100 : null;
    }
    return financials.slice(0, 4);
  } catch (err) {
    logger.warn(`[FMP] Fetch failed for ${cleanSym}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a company description for US/HK stocks via FMP /stable/profile.
 * Returns null when no API key, the request fails, or the symbol has no description.
 */
export async function fetchCompanyProfile(
  symbol: string,
  apiKey: string,
): Promise<string | null> {
  if (!apiKey) return null;
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(cleanSym)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[FMP] Profile failed for ${cleanSym}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    const desc = json[0]?.['description'];
    return typeof desc === 'string' && desc.trim() ? desc.trim() : null;
  } catch (err) {
    logger.warn(`[FMP] Profile fetch failed for ${cleanSym}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
