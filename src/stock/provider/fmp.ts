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
import type { StockFinancial, StockBalanceSheet, StockCashFlow } from '../types.js';
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
        eps: num(raw['eps']),
        costOfRevenue: num(raw['costOfRevenue']),
        ebitda: num(raw['ebitda']),
        operatingExpenses: num(raw['operatingExpenses']),
        incomeBeforeTax: num(raw['incomeBeforeTax']),
        incomeTaxExpense: num(raw['incomeTaxExpense']),
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
      cur.netMargin = cur.netIncome !== undefined && cur.revenue !== 0 ? (cur.netIncome / cur.revenue) * 100 : null;
      cur.operatingMargin =
        cur.operatingIncome !== undefined && cur.revenue !== 0
          ? (cur.operatingIncome / cur.revenue) * 100
          : null;
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

/**
 * Fetches recent quarterly balance sheets via FMP /stable/balance-sheet-statement.
 * Returns an array of StockBalanceSheet (newest first), or null when unavailable.
 */
export async function fetchRecentBalanceSheets(
  symbol: string,
  apiKey: string,
): Promise<StockBalanceSheet[] | null> {
  if (!apiKey) return null;
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://financialmodelingprep.com/stable/balance-sheet-statement?symbol=${encodeURIComponent(cleanSym)}&period=quarter&limit=${MAX_PERIODS}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[FMP] BalanceSheet failed for ${cleanSym}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json) || json.length === 0) {
      logger.warn(`[FMP] No balance-sheet data for ${cleanSym}`);
      return null;
    }
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
      return Number.isFinite(n) ? n : undefined;
    };
    const sheets: StockBalanceSheet[] = [];
    for (const raw of json) {
      const date = typeof raw['date'] === 'string' ? raw['date'] : '';
      const totalAssets = num(raw['totalAssets']);
      const totalLiabilities = num(raw['totalLiabilities']);
      if (!date || totalAssets === undefined || totalLiabilities === undefined) continue;
      const netAssets = totalAssets - totalLiabilities;
      const shortTermDebt = num(raw['shortTermDebt']);
      const longTermDebt = num(raw['longTermDebt']);
      sheets.push({
        date,
        totalAssets,
        totalLiabilities,
        netAssets,
        parentEquity: num(raw['totalStockholdersEquity']),
        currentAssets: num(raw['totalCurrentAssets']),
        currentLiabilities: num(raw['totalCurrentLiabilities']),
        cash: num(raw['cashAndCashEquivalents']),
        inventory: num(raw['inventory']),
        accountsReceivable: num(raw['netReceivables']),
        goodwill: num(raw['goodwill']),
        shortTermDebt,
        longTermDebt,
        debtRatio: totalAssets !== 0 ? (totalLiabilities / totalAssets) * 100 : null,
        currency: typeof raw['reportedCurrency'] === 'string' ? raw['reportedCurrency'] : undefined,
      });
    }
    return sheets.length ? sheets.slice(0, 4) : null;
  } catch (err) {
    logger.warn(`[FMP] BalanceSheet fetch failed for ${cleanSym}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches recent quarterly cash-flow statements via FMP /stable/cash-flow-statement.
 * Returns an array of StockCashFlow (newest first), or null when unavailable.
 */
export async function fetchRecentCashFlows(
  symbol: string,
  apiKey: string,
): Promise<StockCashFlow[] | null> {
  if (!apiKey) return null;
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://financialmodelingprep.com/stable/cash-flow-statement?symbol=${encodeURIComponent(cleanSym)}&period=quarter&limit=${MAX_PERIODS}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[FMP] CashFlow failed for ${cleanSym}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(json) || json.length === 0) {
      logger.warn(`[FMP] No cash-flow data for ${cleanSym}`);
      return null;
    }
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
      return Number.isFinite(n) ? n : undefined;
    };
    const flows: StockCashFlow[] = [];
    for (const raw of json) {
      const date = typeof raw['date'] === 'string' ? raw['date'] : '';
      const netCashOperating = num(raw['operatingCashFlow'] ?? raw['netCashProvidedByOperatingActivities']);
      const endCash = num(raw['cashAndCashEquivalentsAtEnd'] ?? raw['cashAtEndOfPeriod']);
      if (!date || netCashOperating === undefined || endCash === undefined) continue;
      flows.push({
        date,
        netCashOperating,
        netCashInvesting: num(raw['netCashProvidedByInvestingActivities'] ?? raw['investingCashFlow']) ?? 0,
        netCashFinancing: num(raw['netCashProvidedByFinancingActivities'] ?? raw['financingCashFlow']) ?? 0,
        endCash,
        currency: typeof raw['reportedCurrency'] === 'string' ? raw['reportedCurrency'] : undefined,
      });
    }
    return flows.length ? flows.slice(0, 4) : null;
  } catch (err) {
    logger.warn(`[FMP] CashFlow fetch failed for ${cleanSym}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches the latest annual dividend yield (percent) for a US symbol via FMP
 *  /stable/dividends. Returns null when unavailable. */
export async function fetchUSDividendYield(symbol: string, apiKey: string): Promise<number | null> {
  if (!apiKey) return null;
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  if (!cleanSym) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://financialmodelingprep.com/stable/dividends?symbol=${encodeURIComponent(cleanSym)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as any[];
    if (!Array.isArray(json) || json.length === 0) return null;
    const latest = json[0] as any;
    const y = typeof latest['yield'] === 'number' ? latest['yield'] : parseFloat(String(latest['yield'] ?? ''));
    return Number.isFinite(y) ? y : null;
  } catch (err) {
    logger.warn(`[FMP] Dividend yield fetch failed for ${cleanSym}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
