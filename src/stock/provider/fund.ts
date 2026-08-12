/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file fund.ts
 * @description Fund data provider for OTC funds and exchange-traded ETFs/LOFs.
 * Fetches NAV history, basic info, fees, fund manager tenure, top holdings & peer rank via Eastmoney APIs.
 */

import { fetch as undiciFetch } from 'undici';
import { logger } from '../../utils/logger.js';

const LSJZ_API = 'https://api.fund.eastmoney.com/f10/lsjz';
const F10_BASE = 'https://fundf10.eastmoney.com';
const MOB_API = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export interface FundNavRow {
  date: string;
  nav: number;
  accumNav: number;
  dailyChangePct: number | null;
  sgtz: string;
  shtz: string;
}

export interface ManagerTenure {
  since: string;
  days: number;
  returnPct: number | null;
}

export interface FundReturns {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y2: number | null;
  y3: number | null;
  ytd: number | null;
  sinceInception: number | null;
}

export interface FundInfo {
  code: string;
  name: string;
  type: string;
  establishedDate: string | null;
  scaleB: number | null;
  manager: string;
  managerTenure: ManagerTenure | null;
  returns: FundReturns;
  managementFeePct: number | null;
  custodyFeePct: number | null;
  buyStatus: string;
  sellStatus: string;
}

export interface FundTopHolding {
  stockCode: string;
  stockName: string;
  ratioPct: number | null;
  sharesWan: number | null;
  valueWan: number | null;
}

export interface FundDataset {
  symbol: string;
  info: FundInfo | null;
  nav: FundNavRow[];
  topHoldings: FundTopHolding[];
  peerRank: {
    total: number;
    rank: number;
    percentilePct: number;
    metric: string;
  } | null;
  quote: {
    price: number;
    change: number;
    changePercent: number;
    high: number;
    low: number;
    volume: number;
  } | null;
  timestamp: number;
}

async function get<T>(url: string, referer: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await undiciFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Referer: referer },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

function decodeGbk(buf: ArrayBuffer): string {
  return new TextDecoder('gbk').decode(buf);
}

export async function fetchFundNav(code: string, pageSize = 250): Promise<FundNavRow[]> {
  const rows: FundNavRow[] = [];
  const pageLen = 20;
  const pages = Math.ceil(pageSize / pageLen);
  for (let pg = 1; pg <= pages; pg++) {
    try {
      const url = `${LSJZ_API}?fundCode=${code}&pageIndex=${pg}&pageSize=${pageLen}`;
      const json = await get<{ Data?: { LSJZList?: Array<Record<string, unknown>> } }>(url, `${F10_BASE}/`);
      const list = json.Data?.LSJZList ?? [];
      for (const row of list) {
        rows.push({
          date: String(row['FSRQ'] ?? '').slice(0, 10),
          nav: num(row['DWJZ']) ?? 0,
          accumNav: num(row['LJJZ']) ?? 0,
          dailyChangePct: num(row['JZZZL']),
          sgtz: String(row['SGZT'] ?? ''),
          shtz: String(row['SHZT'] ?? ''),
        });
      }
      if (list.length < pageLen) break;
    } catch (err) {
      logger.warn(`[Fund] fetchFundNav page ${pg} failed for ${code}: ${err}`);
      break;
    }
  }
  const seen = new Set<string>();
  const uniq = rows.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true) && r.date && r.nav > 0));
  return uniq.slice(0, pageSize);
}

function exchangePrefix(code: string): string | null {
  if (/^(51|56|58|50\d{3})/.test(code)) return 'sh';
  if (/^(15|16|18)/.test(code)) return 'sz';
  return null;
}

export async function fetchETFQuote(code: string): Promise<FundDataset['quote']> {
  const prefix = exchangePrefix(code);
  if (!prefix) return null;
  const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await undiciFetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const body = decodeGbk(await res.arrayBuffer());
    const m = body.match(/="([^"]*)"/);
    const raw = m?.[1];
    if (!raw || raw.startsWith('v_pv_none_match')) return null;
    const p = raw.split('~');
    const pf = (i: number): number => parseFloat(p[i] ?? '');
    return {
      price: pf(3) || 0,
      change: pf(31) || 0,
      changePercent: pf(32) || 0,
      high: pf(33) || 0,
      low: pf(34) || 0,
      volume: Math.round(pf(36) || 0) * 100,
    };
  } catch (err) {
    logger.warn(`[Fund] fetchETFQuote failed for ${code}: ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const RANK_FT_MAP: Array<{ match: RegExp; ft: string }> = [
  { match: /混合|灵活配置/i, ft: 'hh' },
  { match: /指数|ETF|联接/i, ft: 'zs' },
  { match: /QD|海外/i, ft: 'qdii' },
  { match: /债券|纯债|短债/i, ft: 'zq' },
  { match: /FOF/i, ft: 'fof' },
  { match: /股票/i, ft: 'gp' },
];

const RANK_METRIC = '近1年收益率';
const RANK_TTL_MS = 24 * 60 * 60 * 1000;
const rankCache = new Map<string, { codes: string[]; total: number; fetchedAt: number }>();

function parseRankData(text: string): { codes: string[]; total: number } | null {
  const start = text.indexOf('datas:[');
  const end = text.indexOf('],allRecords');
  if (start < 0 || end < 0) return null;
  const arr = text.slice(start + 7, end);
  const parts = (arr.match(/"((?:[^"\\]|\\.)*)"/g) ?? []).map((p) => p.slice(1, -1));
  if (parts.length === 0) return null;
  const totalM = /allRecords:(\d+)/.exec(text);
  const total = totalM ? Number(totalM[1]) : parts.length;
  const codes = parts.map((p) => p.split(',')[0] ?? '').filter(Boolean);
  return { codes, total };
}

export async function fetchFundPeerRank(code: string, type: string): Promise<FundDataset['peerRank']> {
  const entry = RANK_FT_MAP.find((r) => r.match.test(type));
  if (!entry) return null;
  const cached = rankCache.get(entry.ft);
  if (cached && Date.now() - cached.fetchedAt < RANK_TTL_MS) {
    return buildRank(code, cached.codes, cached.total);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${entry.ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=50000`;
    const res = await undiciFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/data/fundranking.html' },
    });
    if (!res.ok) return null;
    const parsed = parseRankData(await res.text());
    if (!parsed) return null;
    rankCache.set(entry.ft, { codes: parsed.codes, total: parsed.total, fetchedAt: Date.now() });
    return buildRank(code, parsed.codes, parsed.total);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildRank(code: string, codes: string[], total: number): FundDataset['peerRank'] {
  const index = codes.indexOf(code);
  if (index < 0) return null;
  const rank = index + 1;
  return { total, rank, percentilePct: Math.round((rank / total) * 1000) / 10, metric: RANK_METRIC };
}

export async function fetchFundTopHoldings(code: string, topline = 20): Promise<FundTopHolding[]> {
  const url = `${F10_BASE}/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=${topline}&year=&month=`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await undiciFetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, Referer: `${F10_BASE}/` } });
    if (!res.ok) return [];
    const text = await res.text();
    const m = text.match(/content:"([\s\S]*?)",arryear/);
    if (!m) return [];
    const boxes = ((m[1] ?? '').match(/<div class='box'>[\s\S]*?(?=<div class='box'>|$)/g) ?? []);
    const html = boxes[0] ?? '';
    const rows: FundTopHolding[] = [];
    for (const tr of html.matchAll(/<tr>[\s\S]*?<\/tr>/g)) {
      const tds = [...(tr[0] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => (t[1] ?? '').replace(/<[^>]+>/g, '').trim());
      if (tds.length < 7) continue;
      const stmt = tds[0] || '', codeM = tds[1] || '', name = tds[2] || '';
      if (stmt !== '' && !/^\d/.test(codeM)) continue;
      rows.push({
        stockCode: codeM,
        stockName: name,
        ratioPct: num(tds[6]),
        sharesWan: num(tds[7]),
        valueWan: num(tds[8]),
      });
    }
    return rows;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function htmlEntityDecode(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
  return s.replace(/&([a-z#0-9]+);/gi, (_, k) => map[k] ?? '');
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchFundFees(code: string): Promise<{ managementFeePct: number | null; custodyFeePct: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await undiciFetch(`${F10_BASE}/jbgk_${code}.html`, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Referer: `${F10_BASE}/` },
    });
    if (!res.ok) return { managementFeePct: null, custodyFeePct: null };
    const buf = Buffer.from(await res.arrayBuffer());
    const text = htmlEntityDecode(new TextDecoder('utf-8').decode(buf));
    const grab = (label: string): string => {
      const idx = text.indexOf(label);
      if (idx < 0) return '';
      const seg = stripTags(text.slice(idx, idx + 160));
      return (seg.slice(label.length).trim().split(/[\n\t]/)[0] ?? '').trim();
    };
    const mgt = (grab('管理费率') || grab('管理费')).match(/([\d.]+)\s*%/)?.[1];
    const cast = (grab('托管费率') || grab('托管费')).match(/([\d.]+)\s*%/)?.[1];
    return { managementFeePct: mgt ? parseFloat(mgt) : null, custodyFeePct: cast ? parseFloat(cast) : null };
  } catch {
    return { managementFeePct: null, custodyFeePct: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchManagerTenure(code: string): Promise<ManagerTenure | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await undiciFetch(`${F10_BASE}/jjjl_${code}.html`, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Referer: `${F10_BASE}/` },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /<td>\s*(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>\s*至今\s*<\/td>/.exec(html);
    if (!m) return null;
    const since = m[1]!;
    const tail = html.slice(m.index);
    const daysM = /<td[^>]*>([\d.,]+)天<\/td>/.exec(tail);
    const retM = /<td[^>]*>([+-]?[\d.]+)%<\/td>/.exec(tail);
    const days = daysM ? Math.round(parseFloat(daysM[1]!.replace(/,/g, ''))) : 0;
    const returnPct = retM ? parseFloat(retM[1]!) : null;
    return { since, days, returnPct };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFundInfo(code: string): Promise<FundInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${MOB_API}?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8`;
    const [res, fees] = await Promise.all([
      undiciFetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, Referer: `${F10_BASE}/` } }),
      fetchFundFees(code),
    ]);
    if (!res.ok) return null;
    const j = (await res.json()) as { Datas?: Record<string, unknown> | null };
    const d = j.Datas;
    if (!d) return null;
    const est = String(d.ESTABDATE ?? '').slice(0, 10);
    const scaleYuan = Number(d.FEGM);
    return {
      code,
      name: String(d.SHORTNAME ?? ''),
      type: String(d.FTYPE ?? ''),
      establishedDate: /\d{4}-\d{2}-\d{2}/.test(est) ? est : null,
      scaleB: Number.isFinite(scaleYuan) && scaleYuan > 0 ? scaleYuan / 1e8 : null,
      manager: String(d.JJJL ?? ''),
      managerTenure: null,
      returns: {
        w1: num(d.SYL_Z),
        m1: num(d.SYL_Y),
        m3: num(d.SYL_3Y),
        m6: num(d.SYL_6Y),
        y1: num(d.SYL_1N),
        y2: num(d.SYL_2N),
        y3: num(d.SYL_3N),
        ytd: num(d.SYL_JN),
        sinceInception: num(d.SYL_LN),
      },
      managementFeePct: fees.managementFeePct,
      custodyFeePct: fees.custodyFeePct,
      buyStatus: '',
      sellStatus: '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getFundDataset(symbol: string): Promise<FundDataset | null> {
  const trimmed = symbol.trim().toUpperCase().replace(/^\$/, '');
  const m = /^(SH|SZ)?(\d{6})$/i.exec(trimmed);
  if (!m) return null;
  const code = m[2]!;
  const [info, nav, topHoldings, quote, managerTenure] = await Promise.all([
    fetchFundInfo(code),
    fetchFundNav(code),
    fetchFundTopHoldings(code),
    fetchETFQuote(code),
    fetchManagerTenure(code),
  ]);
  if (!info && !nav.length) return null;
  if (info) info.managerTenure = managerTenure;
  let peerRank: FundDataset['peerRank'] = null;
  if (info) {
    info.buyStatus = nav[0]?.sgtz ?? '';
    info.sellStatus = nav[0]?.shtz ?? '';
    peerRank = await fetchFundPeerRank(code, info.type);
  }
  return { symbol: code, info, nav, topHoldings, peerRank, quote, timestamp: Math.floor(Date.now() / 1000) };
}
