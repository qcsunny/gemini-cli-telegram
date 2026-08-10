import { fetch as undiciFetch } from 'undici';
import type { StockFinancial } from '../types.js';
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
