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

/** A-share 业绩报表 (RPT_LICO_FN_CPD) → StockFinancial. Field names are A-share specific. */
function toAStockFinancials(rows: RawFinancialRow[]): StockFinancial[] {
  return rows.map((row) => {
    const d = cleanDate(String(row['REPORTDATE'] ?? ''));
    return {
      date: d,
      filingDate: undefined,
      period: String(row['QDATE'] ?? ''),
      revenue: num(row, 'TOTAL_OPERATE_INCOME') ?? 0,
      grossProfit: undefined,
      operatingIncome: undefined,
      netIncome: num(row, 'PARENT_NETPROFIT') ?? 0,
      epsDiluted: num(row, 'BASIC_EPS') ?? undefined,
      revenueYoY: num(row, 'YSTZ') ?? undefined,
      revenueQoQ: num(row, 'YSHZ') ?? undefined,
      netIncomeYoY: num(row, 'SJLTZ') ?? undefined,
      netIncomeQoQ: num(row, 'SJLHZ') ?? undefined,
      grossMargin: num(row, 'XSMLL') ?? undefined,
      netMargin: num(row, 'XSJLL') ?? (num(row, 'PARENT_NETPROFIT') && num(row, 'TOTAL_OPERATE_INCOME') ? (num(row, 'PARENT_NETPROFIT')! / num(row, 'TOTAL_OPERATE_INCOME')!) * 100 : undefined),
      roe: num(row, 'WEIGHTAVG_ROE') ?? num(row, 'ROE_WEIGHT') ?? num(row, 'ROE') ?? undefined,
      bps: num(row, 'BPS') ?? undefined,
      eps: num(row, 'BASIC_EPS') ?? undefined,
      currency: undefined,
      isAnnual: d.endsWith('-12-31'),
    };
  });
}

/** HK-stock 主要指标 (RPT_HKF10_FN_MAININDICATOR) → StockFinancial. Field names are HK specific. */
function toHKFinancials(rows: RawFinancialRow[]): StockFinancial[] {
  return rows.map((row) => {
    const d = cleanDate(String(row['STD_REPORT_DATE'] ?? row['REPORT_DATE'] ?? ''));
    return {
      date: d,
      filingDate: undefined,
      period: String(row['REPORT_TYPE'] ?? ''),
      revenue: num(row, 'OPERATE_INCOME') ?? 0,
      grossProfit: num(row, 'GROSS_PROFIT') ?? undefined,
      operatingIncome: num(row, 'OPERATE_PROFIT') ?? undefined,
      netIncome: num(row, 'HOLDER_PROFIT') ?? 0,
      epsDiluted: num(row, 'DILUTED_EPS') ?? undefined,
      revenueYoY: num(row, 'OPERATE_INCOME_YOY') ?? undefined,
      revenueQoQ: num(row, 'OPERATE_INCOME_QOQ') ?? undefined,
      netIncomeYoY: num(row, 'HOLDER_PROFIT_YOY') ?? undefined,
      netIncomeQoQ: num(row, 'HOLDER_PROFIT_QOQ') ?? undefined,
      grossMargin: num(row, 'GROSS_PROFIT_RATIO') ?? undefined,
      netMargin: num(row, 'NET_PROFIT_RATIO') ?? (num(row, 'HOLDER_PROFIT') && num(row, 'OPERATE_INCOME') ? (num(row, 'HOLDER_PROFIT')! / num(row, 'OPERATE_INCOME')!) * 100 : undefined),
      roe: num(row, 'ROE_AVG') ?? num(row, 'ROE_YEARLY') ?? undefined,
      bps: num(row, 'BPS') ?? undefined,
      eps: num(row, 'BASIC_EPS') ?? undefined,
      incomeBeforeTax: num(row, 'PRETAX_PROFIT') ?? undefined,
      currency: undefined,
      isAnnual: d.endsWith('-12-31'),
    };
  });
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

/** Exchange suffix for A-share SECUCODE queries: SH for 6xxxxx, SZ otherwise. */
function aShareExchange(symbol: string): string {
  return /^6/.test(symbol) ? 'SH' : 'SZ';
}

/** A-share quarterly performance (业绩报表) via Eastmoney datacenter. symbol: 6-digit code e.g. '600519'. */
export async function fetchAStockFinancials(symbol: string): Promise<StockFinancial[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'REPORTDATE',
    sortTypes: '-1',
    pageSize: '20',
    pageNumber: '1',
    reportName: 'RPT_LICO_FN_CPD',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${symbol}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  const financials = toAStockFinancials(rows);
  const detailRows = await fetchRows(
    new URLSearchParams({
      sortColumns: 'REPORT_DATE',
      sortTypes: '-1',
      pageSize: '20',
      pageNumber: '1',
      reportName: 'RPT_F10_FINANCE_GINCOME',
      columns: 'ALL',
      source: 'WEB',
      client: 'WEB',
      filter: `(SECUCODE="${symbol}.${aShareExchange(symbol)}")`,
    }),
  );
  if (detailRows.length) {
    const detailByDate = new Map<string, RawFinancialRow>();
    for (const r of detailRows) detailByDate.set(cleanDate(String(r['REPORT_DATE'] ?? '')), r);
    for (const f of financials) {
      const d = detailByDate.get(f.date);
      if (!d) continue;
      const cost = num(d, 'OPERATE_COST');
      const opProfit = num(d, 'OPERATE_PROFIT');
      if (cost !== null && cost !== undefined) f.costOfRevenue = cost;
      if (opProfit !== null && opProfit !== undefined) f.operatingIncome = opProfit;
      f.incomeBeforeTax = num(d, 'TOTAL_PROFIT') ?? f.incomeBeforeTax;
      f.incomeTaxExpense = num(d, 'INCOME_TAX') ?? f.incomeTaxExpense;
      f.deductedNetProfit = num(d, 'DEDUCT_NETPROFIT') ?? f.deductedNetProfit;
      if (f.grossProfit === undefined && f.costOfRevenue !== undefined) {
        f.grossProfit = f.revenue - f.costOfRevenue;
      }
    }
  }
  return financials.map((f) => ({ ...f, currency: 'CNY' }));
}

/** HK-stock financial indicators via Eastmoney datacenter. symbol: 5-digit code e.g. '00700'. */
export async function fetchHKFinancials(symbol: string): Promise<StockFinancial[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'STD_REPORT_DATE',
    sortTypes: '-1',
    pageSize: '20',
    pageNumber: '1',
    reportName: 'RPT_HKF10_FN_MAININDICATOR',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${symbol}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  const financials = toHKFinancials(rows).map((f) => ({ ...f, currency: 'HKD' }));

  // Long-form income statement detail (科目明细) via RPT_HKF10_FN_INCOME.
  const detailParams = new URLSearchParams({
    sortColumns: 'STD_REPORT_DATE',
    sortTypes: '-1',
    pageSize: '500',
    pageNumber: '1',
    reportName: 'RPT_HKF10_FN_INCOME',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${symbol}")`,
  });
  const detailRows = await fetchRows(detailParams);
  if (detailRows.length) {
    const byDate = new Map<string, Map<string, number>>();
    for (const r of detailRows) {
      const d = cleanDate(String(r['STD_REPORT_DATE'] ?? r['REPORT_DATE'] ?? ''));
      const code = String(r['STD_ITEM_CODE'] ?? '');
      const amt = num(r, 'AMOUNT');
      if (!d || !code || amt === null) continue;
      if (!byDate.has(d)) byDate.set(d, new Map());
      byDate.get(d)!.set(code, amt);
    }
    for (const f of financials) {
      const items = byDate.get(f.date);
      if (!items) continue;
      const cost = items.get('004005001');
      if (cost !== undefined) f.costOfRevenue = cost;
      const opEx = (items.get('004010003') ?? 0) + (items.get('004010004') ?? 0);
      if (opEx > 0) f.operatingExpenses = opEx;
      const opProfit = items.get('004010999');
      if (opProfit !== undefined) f.operatingIncome = opProfit;
      f.incomeBeforeTax = items.get('004011999') ?? f.incomeBeforeTax;
      f.incomeTaxExpense = items.get('004012001') ?? f.incomeTaxExpense;
      const netInc = items.get('004025002');
      if (netInc !== undefined) f.netIncome = netInc;
      if (f.grossProfit === undefined && f.costOfRevenue !== undefined && f.revenue !== undefined) {
        f.grossProfit = f.revenue - f.costOfRevenue;
      }
    }
  }
  return financials;
}

const F10_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax';
const F10_NEW_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis';

/** A-share quarterly balance sheets via Eastmoney datacenter RPT_F10_FINANCE_GBALANCE. symbol: 6-digit code e.g. '600519'. */
export async function fetchABalanceSheets(symbol: string): Promise<StockBalanceSheet[] | null> {
  const params = new URLSearchParams({
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: '20',
    pageNumber: '1',
    reportName: 'RPT_F10_FINANCE_GBALANCE',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECUCODE="${symbol}.${aShareExchange(symbol)}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) {
    return fetchBankOrInsuranceBalanceSheets(symbol);
  }
  return rows
    .map((row): StockBalanceSheet | null => {
      const totalAssets = num(row, 'TOTAL_ASSETS');
      const totalLiabilities = num(row, 'TOTAL_LIABILITIES');
      if (totalAssets === null || totalLiabilities === null) return null;
      const d = cleanDate(String(row['REPORT_DATE'] ?? ''));
      return {
        date: d,
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
        isAnnual: d.endsWith('-12-31'),
      };
    })
    .filter((b): b is StockBalanceSheet => b !== null);
}

async function fetchF10Text(path: string, code: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await undiciFetch(`${F10_NEW_BASE}/${path}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Referer: `${F10_NEW_BASE}/Index?type=web&code=${encodeURIComponent(code)}`,
      },
    });
    if (!res.ok) {
      logger.warn(`[EastmoneyF10] ${path} HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    logger.warn(`[EastmoneyF10] ${path} failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchF10Json<T>(path: string, code: string): Promise<T | null> {
  const text = await fetchF10Text(path, code);
  if (!text) return null;
  const start = text.indexOf('{');
  return start === -1 ? null : (JSON.parse(text.slice(start)) as T);
}

/** Banks / insurers don't report through RPT_F10_FINANCE_GBALANCE; fall back to emweb PC_HSF10 (companyType: bank/security=3, insurance=2). */
async function fetchBankOrInsuranceBalanceSheets(symbol: string): Promise<StockBalanceSheet[] | null> {
  const code = `${aShareExchange(symbol)}${symbol}`;
  const page = await fetchF10Text(`Index?type=web&code=${encodeURIComponent(code)}`, code);
  let companyType = 4;
  if (page) {
    const m = page.match(/id="hidctype"[^>]*value="(\d+)"/);
    if (m?.[1]) companyType = Number(m[1]);
  }
  const dateJson = await fetchF10Json<{ data?: Array<{ REPORT_DATE?: string }> }>(
    `zcfzbDateAjaxNew?companyType=${companyType}&reportDateType=0&code=${encodeURIComponent(code)}`,
    code,
  );
  const dates = (dateJson?.data ?? [])
    .map((d) => String(d.REPORT_DATE ?? '').slice(0, 10))
    .filter(Boolean)
    .slice(0, 4);
  if (!dates.length) return null;
  const sheetJson = await fetchF10Json<{ data?: RawFinancialRow[] }>(
    `zcfzbAjaxNew?companyType=${companyType}&reportDateType=0&reportType=1&dates=${encodeURIComponent(dates.join(','))}&code=${encodeURIComponent(code)}`,
    code,
  );
  const rows = sheetJson?.data ?? [];
  if (!rows.length) return null;
  return rows
    .map((row): StockBalanceSheet | null => {
      const totalAssets = num(row, 'TOTAL_ASSETS');
      const totalLiabilities = num(row, 'TOTAL_LIABILITIES');
      if (totalAssets === null || totalLiabilities === null) return null;
      const parentEquity = num(row, 'TOTAL_PARENT_EQUITY');
      return {
        date: cleanDate(String(row['REPORT_DATE'] ?? '')),
        totalAssets,
        totalLiabilities,
        netAssets: parentEquity ?? totalAssets - totalLiabilities,
        parentEquity: parentEquity ?? undefined,
        currentAssets: undefined,
        currentLiabilities: undefined,
        cash: num(row, 'CASH_DEPOSIT_PBC') ?? undefined,
        inventory: undefined,
        accountsReceivable: undefined,
        goodwill: undefined,
        shortTermDebt: undefined,
        longTermDebt: num(row, 'BOND_PAYABLE') ?? undefined,
        debtRatio: (totalLiabilities / totalAssets) * 100,
        currency: String(row['CURRENCY'] ?? 'CNY'),
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
    filter: `(SECUCODE="${symbol}.${aShareExchange(symbol)}")`,
  });
  const rows = await fetchRows(params);
  if (!rows.length) return null;
  return rows
    .map((row): StockCashFlow | null => {
      const netCashOperating = num(row, 'NETCASH_OPERATE');
      if (netCashOperating === null) return null;
      const endCash = num(row, 'END_CASH') ?? num(row, 'END_CASH_EQUIVALENTS');
      return {
        date: cleanDate(String(row['REPORT_DATE'] ?? '')),
        netCashOperating,
        netCashInvesting: num(row, 'NETCASH_INVEST') ?? 0,
        netCashFinancing: num(row, 'NETCASH_FINANCE') ?? 0,
        endCash: endCash ?? 0,
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

/** A-share annual dividend yield via Eastmoney RPT_SHAREBONUS_DET.
 *  Computes (per-share cash dividend) / (current price) * 100. Falls back to the
 *  latest ex-dividend record when the newest plan has no per-10-shares amount.
 *  symbol: 6-digit A-share code e.g. '600519'. Returns null on failure. */
export async function fetchADividendYield(symbol: string, price: number): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      sortColumns: 'EX_DIVIDEND_DATE',
      sortTypes: '-1',
      pageSize: '5',
      pageNumber: '1',
      reportName: 'RPT_SHAREBONUS_DET',
      columns: 'ALL',
      source: 'WEB',
      client: 'WEB',
      filter: `(SECURITY_CODE="${symbol}")`,
    });
    const rows = await fetchRows(params);
    if (!rows.length || !price) return null;
    const per10 = num(rows[0], 'PRETAX_BONUS_RMB');
    if (per10 !== null && per10 > 0) return (per10 / 10 / price) * 100;
    for (const row of rows) {
      const v = num(row, 'PRETAX_BONUS_RMB');
      if (v !== null && v > 0) return (v / 10 / price) * 100;
    }
    return null;
  } catch {
    return null;
  }
}

/** HK-stock dividend yield (percent) via RPT_HKF10_FN_MAININDICATOR DIVIDEND_RATE.
 *  symbol: 5-digit code e.g. '00700'. Returns null on failure. */
export async function fetchHKDividendYield(symbol: string): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      sortColumns: 'STD_REPORT_DATE',
      sortTypes: '-1',
      pageSize: '1',
      pageNumber: '1',
      reportName: 'RPT_HKF10_FN_MAININDICATOR',
      columns: 'ALL',
      source: 'WEB',
      client: 'WEB',
      filter: `(SECURITY_CODE="${symbol}")`,
    });
    const rows = await fetchRows(params);
    if (!rows.length) return null;
    const v = num(rows[0], 'DIVIDEND_RATE');
    return v;
  } catch {
    return null;
  }
}
