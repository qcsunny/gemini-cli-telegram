import { fetch as undiciFetch } from 'undici';
import type { StockFinancial, StockBalanceSheet, StockCashFlow } from '../types.js';
import { logger } from '../../utils/logger.js';

const DC_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

interface RawFinancialRow {
  [key: string]: unknown;
}

function num(row: RawFinancialRow, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function cleanDate(d: string): string {
  return d ? d.slice(0, 10) : '';
}

function toFinancials(rows: RawFinancialRow[]): StockFinancial[] {
  return rows.map((row) => ({
    date: cleanDate(String(row['REPORTDATE'] ?? row['REPORT_DATE'] ?? '')),
    filingDate: undefined,
    period: String(row['QDATE'] ?? row['REPORT_TYPE'] ?? ''),
    revenue: num(row, 'TOTAL_OPERATE_INCOME') ?? num(row, 'OPERATE_INCOME') ?? 0,
    grossProfit: num(row, 'GROSS_PROFIT') ?? undefined,
    operatingIncome: num(row, 'OPERATING_INCOME') ?? undefined,
    netIncome: num(row, 'PARENT_NETPROFIT') ?? num(row, 'HOLDER_PROFIT') ?? 0,
    epsDiluted: num(row, 'BASIC_EPS') ?? undefined,
    revenueYoY: num(row, 'YSTZ') ?? num(row, 'OPERATE_INCOME_YOY') ?? undefined,
    revenueQoQ: num(row, 'YSHZ') ?? num(row, 'OPERATE_INCOME_QOQ') ?? undefined,
    netIncomeYoY: num(row, 'SJLTZ') ?? num(row, 'HOLDER_PROFIT_YOY') ?? undefined,
    netIncomeQoQ: num(row, 'SJLHZ') ?? num(row, 'HOLDER_PROFIT_QOQ') ?? undefined,
    grossMargin: num(row, 'XSMLL') ?? num(row, 'GROSS_PROFIT_RATIO') ?? undefined,
    netMargin: num(row, 'NET_PROFIT_RATIO') ?? undefined,
    roe: num(row, 'ROE_WEIGHT') ?? num(row, 'ROE') ?? undefined,
    eps: num(row, 'BASIC_EPS') ?? undefined,
    currency: undefined,
  }));
}

async function fetchRows(params: URLSearchParams): Promise<RawFinancialRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await undiciFetch(`${DC_BASE}?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    });
    if (!res.ok) {
      logger.warn(`[EastmoneyFinancials] HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { result?: { data?: RawFinancialRow[] } };
    return Array.isArray(json.result?.data) ? (json.result.data as RawFinancialRow[]) : [];
  } catch (err) {
    logger.warn(`[EastmoneyFinancials] fetch failed: ${err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** A-share quarterly performance (业绩报表) via Eastmoney datacenter. symbol: 6-digit code e.g. '600519'. */
export async function fetchAStockFinancials(symbol: string): Promise<StockFinancial[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'REPORTDATE',
    sortTypes: '-1',
    pageSize: '4',
    pageNumber: '1',
    reportName: 'RPT_LICO_FN_CPD',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${symbol}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return toFinancials(rows).map((f) => ({ ...f, currency: 'CNY' }));
}

/** HK-stock financial indicators via Eastmoney datacenter. symbol: 5-digit code e.g. '00700'. */
export async function fetchHKFinancials(symbol: string): Promise<StockFinancial[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'STD_REPORT_DATE',
    sortTypes: '-1',
    pageSize: '4',
    pageNumber: '1',
    reportName: 'RPT_HKF10_FN_MAININDICATOR',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${symbol}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return toFinancials(rows).map((f) => ({ ...f, currency: 'HKD' }));
}

const F10_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax';

/** A-share quarterly balance sheets via Eastmoney datacenter RPT_F10_FINANCE_GBALANCE. symbol: 6-digit code e.g. '600519'. */
export async function fetchABalanceSheets(symbol: string): Promise<StockBalanceSheet[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: '4',
    pageNumber: '1',
    reportName: 'RPT_F10_FINANCE_GBALANCE',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECUCODE="${symbol}.SH")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return rows
    .map((row): StockBalanceSheet | null => {
      const totalAssets = num(row, 'TOTAL_ASSETS');
      const totalLiabilities = num(row, 'TOTAL_LIABILITIES');
      if (totalAssets === null || totalLiabilities === null) return null;
      return {
        date: cleanDate(String(row['REPORT_DATE'] ?? '')),
        totalAssets,
        totalLiabilities,
        netAssets: totalAssets - totalLiabilities,
        parentEquity: num(row, 'TOTAL_PARENT_EQUITY') ?? undefined,
        currentAssets: num(row, 'TOTAL_CURRENT_ASSETS') ?? undefined,
        currentLiabilities: num(row, 'TOTAL_CURRENT_LIAB') ?? undefined,
        cash: num(row, 'MONETARYFUNDS') ?? undefined,
        inventory: num(row, 'INVENTORY') ?? undefined,
        accountsReceivable: num(row, 'ACCOUNTS_RECE') ?? undefined,
        goodwill: num(row, 'GOODWILL') ?? undefined,
        shortTermDebt: num(row, 'SHORT_LOAN') ?? undefined,
        longTermDebt: num(row, 'LONG_LOAN') ?? undefined,
        debtRatio: totalLiabilities && totalAssets ? (totalLiabilities / totalAssets) * 100 : null,
        currency: 'CNY',
      };
    })
    .filter((b): b is StockBalanceSheet => b !== null);
}

/** A-share quarterly cash-flow statements via Eastmoney datacenter RPT_F10_FINANCE_GCASHFLOW. symbol: 6-digit code e.g. '600519'. */
export async function fetchACashFlows(symbol: string): Promise<StockCashFlow[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: '4',
    pageNumber: '1',
    reportName: 'RPT_F10_FINANCE_GCASHFLOW',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECUCODE="${symbol}.SH")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return rows
    .map((row): StockCashFlow | null => {
      const netCashOperating = num(row, 'NETCASH_OPERATE');
      const endCash = num(row, 'END_CASH') ?? num(row, 'END_CASH_EQUIVALENTS');
      if (netCashOperating === null || endCash === null) return null;
      return {
        date: cleanDate(String(row['REPORT_DATE'] ?? '')),
        netCashOperating,
        netCashInvesting: num(row, 'NETCASH_INVEST') ?? 0,
        netCashFinancing: num(row, 'NETCASH_FINANCE') ?? 0,
        endCash,
        currency: 'CNY',
      };
    })
    .filter((c): c is StockCashFlow => c !== null);
}

/** Company profile (ORG_PROFILE) for A-share stocks via Eastmoney F10. symbol: 6-digit code e.g. '600519'. */
export async function fetchAStockProfile(symbol: string): Promise<string | null> {
  const code = symbol.length === 6 && /^\d{6}$/.test(symbol) ? (symbol.startsWith('6') ? `SH${symbol}` : `SZ${symbol}`) : symbol;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await undiciFetch(`${F10_BASE}?code=${encodeURIComponent(code)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    });
    if (!res.ok) {
      logger.warn(`[EastmoneyProfile] HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { jbzl?: RawFinancialRow[] };
    const profile = json.jbzl?.[0]?.['ORG_PROFILE'];
    return typeof profile === 'string' && profile.trim() ? profile.trim() : null;
  } catch (err) {
    logger.warn(`[EastmoneyProfile] fetch failed: ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** HK-stock balance sheets via Eastmoney long-form report RPT_HKF10_FN_BALANCE. symbol: 5-digit code e.g. '00700'. */
export async function fetchHKBalanceSheets(symbol: string): Promise<StockBalanceSheet[] | null> {
  // Long-form report: one row per line item. Fetch enough for 4 quarters,
  // then group by STD_REPORT_DATE and pick the合计 (total) line items.
  const params = new URLSearchParams({
    sortColumns: 'STD_REPORT_DATE',
    sortTypes: '-1',
    pageSize: '500',
    pageNumber: '1',
    reportName: 'RPT_HKF10_FN_BALANCE',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECUCODE="${symbol}.HK")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;

  const byDate = new Map<string, RawFinancialRow[]>();
  for (const row of rows) {
    const date = cleanDate(String(row['STD_REPORT_DATE'] ?? ''));
    if (!date) continue;
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }

  const result: StockBalanceSheet[] = [];
  // total line item codes from the long-form report
  const pick = (items: RawFinancialRow[], code: string): number | null => {
    const it = items.find((r) => String(r['STD_ITEM_CODE']) === code);
    return it ? num(it, 'AMOUNT') : null;
  };
  for (const date of [...byDate.keys()].sort().reverse().slice(0, 4)) {
    const items = byDate.get(date)!;
    const totalAssets = pick(items, '004009999');
    const totalLiabilities = pick(items, '004025999');
    const netAssets = pick(items, '004028999');
    if (totalAssets === null || totalLiabilities === null) continue;
    result.push({
      date,
      totalAssets,
      totalLiabilities,
      netAssets: netAssets ?? totalAssets - totalLiabilities,
      parentEquity: pick(items, '004030999') ?? undefined,
      currentAssets: pick(items, '004002999') ?? undefined,
      currentLiabilities: pick(items, '004011999') ?? undefined,
      cash: pick(items, '004002010') ?? undefined,
      inventory: pick(items, '004002001') ?? undefined,
      accountsReceivable: pick(items, '004002003') ?? undefined,
      shortTermDebt: pick(items, '004011010') ?? undefined,
      longTermDebt: pick(items, '004020001') ?? undefined,
      debtRatio: totalLiabilities && totalAssets ? (totalLiabilities / totalAssets) * 100 : null,
      currency: 'HKD',
    });
  }
  return result.length ? result : null;
}

/** HK-stock cash-flow statements via Eastmoney RPT_HKF10_FN_MAININDICATOR. symbol: 5-digit code e.g. '00700'. */
export async function fetchHKCashFlows(symbol: string): Promise<StockCashFlow[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'STD_REPORT_DATE',
    sortTypes: '-1',
    pageSize: '4',
    pageNumber: '1',
    reportName: 'RPT_HKF10_FN_MAININDICATOR',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECUCODE="${symbol}.HK")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return rows
    .map((row): StockCashFlow | null => {
      const netCashOperating = num(row, 'NETCASH_OPERATE');
      const endCash = num(row, 'END_CASH');
      if (netCashOperating === null || endCash === null) return null;
      return {
        date: cleanDate(String(row['STD_REPORT_DATE'] ?? '')),
        netCashOperating,
        netCashInvesting: num(row, 'NETCASH_INVEST') ?? 0,
        netCashFinancing: num(row, 'NETCASH_FINANCE') ?? 0,
        endCash,
        currency: 'HKD',
      };
    })
    .filter((c): c is StockCashFlow => c !== null);
}
