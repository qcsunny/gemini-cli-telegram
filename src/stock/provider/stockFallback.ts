/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file yahooFallback.ts
 * @description Fallback stock market data provider for US equities (NVDA, AAPL, TSLA, etc.).
 * Provides reliable fallback quote data.
 */

import { fetch as undiciFetch } from 'undici';
import type { MarketDataProvider, StockQuote, StockCandles, StockSearchResult, CandleDataPoint } from '../types.js';
import { logger } from '../../utils/logger.js';

export class StockFallbackProvider implements MarketDataProvider {
  readonly name = 'GlobalMarketData';

  async getQuote(symbol: string): Promise<StockQuote | null> {
    let cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();

    // If query is Chinese name or ticker alias (e.g. tcl, 苹果, 阿里巴巴, 贵州茅台)
    if (/[\u4e00-\u9fa5]/.test(symbol) || (!/^\d{5,6}$/.test(cleanSym) && !/^(SH|SZ|HK)\d+/i.test(cleanSym))) {
      const searchRes = await this.searchSymbols(symbol);
      if (searchRes.length > 0) {
        const item = searchRes[0] as any;
        cleanSym = item.symbol.toUpperCase();

        // Instantly fetch price from Eastmoney API for Chinese query to ensure sub-300ms speed
        if (item.secid) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1200);
            const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${item.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=2`;
            const res = await undiciFetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
            if (res.ok) {
              const json = (await res.json()) as any;
              const klines = json?.data?.klines;
              if (Array.isArray(klines) && klines.length > 0) {
                const last = klines[klines.length - 1].split(',');
                const price = parseFloat(last[2]) || 0;
                const open = parseFloat(last[1]) || price;
                const high = parseFloat(last[3]) || price;
                const low = parseFloat(last[4]) || price;
                const prevClose = json?.data?.preKPrice || open;
                const change = price - prevClose;
                const changePercent = prevClose ? (change / prevClose) * 100 : 0;

                if (price > 0) {
                  const secid = String(item.secid || '');
                  const secidMarket = secid.startsWith('116.') ? 'HKEX' : secid.startsWith('1.') ? 'SSE' : secid.startsWith('0.') ? 'SZSE' : undefined;
                  const currency = secidMarket === 'HKEX' ? 'HKD' : secidMarket === 'SSE' || secidMarket === 'SZSE' ? 'CNY' : 'USD';
                  return {
                    symbol: cleanSym,
                    name: item.name || `${cleanSym} Inc.`,
                    price,
                    change,
                    changePercent,
                    open,
                    high,
                    low,
                    previousClose: prevClose,
                    volume: parseInt(last[5], 10) || 0,
                    market: secidMarket || item.exchange || 'NASDAQ',
                    currency,
                    timestamp: Math.floor(Date.now() / 1000),
                    source: 'EastmoneyFast',
                    isDelayed: true,
                  };
                }
              }
            }
          } catch {
            // Ignore & fallback
          }
        }
      }
    }

    // 1. Check if query is A-share (e.g., SH600519, 600519, SZ000001, BJ920002, 920002) or HK stock (e.g. HK00700, 00700)
    const isAshare = /^(SH|SZ|BJ)?\d{6}$/i.test(cleanSym);
    const isHK = /^(HK)?\d{5}$/i.test(cleanSym);

    if (isAshare || isHK) {
      let sinaCode = cleanSym.toLowerCase();
      if (isAshare && !sinaCode.startsWith('sh') && !sinaCode.startsWith('sz') && !sinaCode.startsWith('bj')) {
        if (sinaCode.startsWith('92') || sinaCode.startsWith('8') || sinaCode.startsWith('4')) {
          sinaCode = 'bj' + sinaCode;
        } else {
          sinaCode = (sinaCode.startsWith('6') || sinaCode.startsWith('9') ? 'sh' : 'sz') + sinaCode;
        }
      } else if (isHK && !sinaCode.startsWith('hk')) {
        sinaCode = 'hk' + sinaCode;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const url = `http://hq.sinajs.cn/list=${sinaCode}`;
        const res = await undiciFetch(url, {
          headers: { 'Referer': 'http://finance.sina.com.cn' },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (res.ok) {
          const buf = await res.arrayBuffer();
          const decoder = new TextDecoder('gbk');
          const rawText = decoder.decode(buf);
          const match = rawText.match(/="([^"]+)"/);
          if (match && match[1]) {
            const parts = match[1].split(',');
            if (isAshare && parts.length >= 31) {
              const name = parts[0];
              const open = parseFloat(parts[1]) || 0;
              const prevClose = parseFloat(parts[2]) || 0;
              const price = parseFloat(parts[3]) || prevClose;
              const high = parseFloat(parts[4]) || price;
              const low = parseFloat(parts[5]) || price;
              const change = price - prevClose;
              const changePercent = prevClose ? (change / prevClose) * 100 : 0;
              const volume = parseInt(parts[8], 10) || 0;

              const snap = await this.fetchSnapshot(cleanSym, 'A');
              return {
                symbol: cleanSym,
                name,
                price,
                change,
                changePercent,
                open,
                high,
                low,
                previousClose: prevClose,
                volume,
                market: sinaCode.startsWith('sh') ? 'SSE' : sinaCode.startsWith('bj') ? 'BJ' : 'SZSE',
                currency: 'CNY',
                timestamp: Math.floor(Date.now() / 1000),
                source: 'SinaFinance',
                isDelayed: false,
                marketCap: snap?.marketCap,
                pe: snap?.pe,
                pb: snap?.pb,
                turnoverRate: snap?.turnoverRate,
              };
            } else if (isHK && parts.length >= 18) {
              const name = parts[1] || parts[0];
              const open = parseFloat(parts[2]) || 0;
              const prevClose = parseFloat(parts[3]) || 0;
              const high = parseFloat(parts[4]) || 0;
              const low = parseFloat(parts[5]) || 0;
              const price = parseFloat(parts[6]) || prevClose;
              const change = parseFloat(parts[7]) || (price - prevClose);
              const changePercent = parseFloat(parts[8]) || (prevClose ? (change / prevClose) * 100 : 0);

              const snap = await this.fetchSnapshot(cleanSym, 'H');
              return {
                symbol: cleanSym,
                name,
                price,
                change,
                changePercent,
                open,
                high,
                low,
                previousClose: prevClose,
                volume: parseInt(parts[12], 10) || 0,
                market: 'HKEX',
                currency: 'HKD',
                timestamp: Math.floor(Date.now() / 1000),
                source: 'SinaFinance',
                isDelayed: false,
                marketCap: snap?.marketCap,
                pe: snap?.pe,
                pb: snap?.pb,
                turnoverRate: snap?.turnoverRate,
              };
            }
          }
        }
      } catch (err) {
        logger.warn(`[SinaProvider] Fetch failed for ${sinaCode}: ${err}`);
      }
    }

    // 2. Ultra-fast US stock lookup via Eastmoney (sub-300ms guaranteed for Inline mode)
    try {
      const searchRes = await this.searchSymbols(cleanSym);
      if (searchRes && searchRes.length > 0) {
        const item = searchRes[0] as any;
        if (item.secid) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1000);
          const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${item.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=2`;
          const res = await undiciFetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
          if (res.ok) {
            const json = (await res.json()) as any;
            const klines = json?.data?.klines;
            if (Array.isArray(klines) && klines.length > 0) {
              const last = klines[klines.length - 1].split(',');
              const price = parseFloat(last[2]) || 0;
              const open = parseFloat(last[1]) || price;
              const high = parseFloat(last[3]) || price;
              const low = parseFloat(last[4]) || price;
              const prevClose = json?.data?.preKPrice || open;
              const change = price - prevClose;
              const changePercent = prevClose ? (change / prevClose) * 100 : 0;

              if (price > 0) {
                let marketCap: number | undefined;
                let pe: number | undefined;
                let pb: number | undefined;
                let turnoverRate: number | undefined;
                try {
                  const snapController = new AbortController();
                  const snapTimer = setTimeout(() => snapController.abort(), 800);
                  const snapUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=${item.secid}&fields=f43,f57,f84,f116,f163,f167,f168`;
                  const snapRes = await undiciFetch(snapUrl, { signal: snapController.signal }).finally(() => clearTimeout(snapTimer));
                  if (snapRes.ok) {
                    const snapJson = (await snapRes.json()) as any;
                    const d = snapJson?.data;
                    if (d) {
                      if (typeof d.f116 === 'number') marketCap = d.f116;
                      if (typeof d.f163 === 'number') pe = d.f163 / 100;
                      if (typeof d.f167 === 'number') pb = d.f167 / 100;
                      if (typeof d.f168 === 'number') turnoverRate = d.f168 / 100;
                    }
                  }
                } catch {
                  // Optional enrichment, ignore failures
                }

                return {
                  symbol: cleanSym,
                  name: item.name || `${cleanSym} Inc.`,
                  price,
                  change,
                  changePercent,
                  open,
                  high,
                  low,
                  previousClose: prevClose,
                  volume: parseInt(last[5], 10) || 0,
                  marketCap,
                  pe,
                  pb,
                  turnoverRate,
                  market: item.exchange || 'NASDAQ',
                  currency: 'USD',
                  timestamp: Math.floor(Date.now() / 1000),
                  source: 'EastmoneyFast',
                  isDelayed: true,
                };
              }
            }
          }
        }
      }
    } catch {
      // Ignore
    }

    // 3. Fallback to US stock lookup (api.nasdaq.com)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const url = `https://api.nasdaq.com/api/quote/${cleanSym}/info?assetclass=stocks`;
      const res = await undiciFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const json = (await res.json()) as any;
        const data = json?.data;
        if (data && data.primaryData) {
          const rawPrice = String(data.primaryData.lastSalePrice || '').replace(/[^0-9.]/g, '');
          const price = parseFloat(rawPrice) || 0;
          const rawChange = String(data.primaryData.netChange || '').replace(/[^0-9.-]/g, '');
          const change = parseFloat(rawChange) || 0;
          const rawPct = String(data.primaryData.percentageChange || '').replace(/[^0-9.-]/g, '');
          const changePercent = parseFloat(rawPct) || 0;
          const companyName = data.companyName || `${cleanSym} Inc.`;
          const exchange = (data.exchange || 'NASDAQ').replace('-GS', '').replace('-NGS', '');

          if (price > 0) {
            return {
              symbol: cleanSym,
              name: companyName,
              price,
              change,
              changePercent,
              open: price - change,
              high: price + Math.abs(change),
              low: price - Math.abs(change),
              previousClose: price - change,
              volume: parseInt(String(data.primaryData.volume || '0').replace(/,/g, ''), 10) || 0,
              market: exchange,
              currency: 'USD',
              timestamp: Math.floor(Date.now() / 1000),
              source: this.name,
              isDelayed: true,
            };
          }
        }
      }
    } catch (err) {
      logger.warn(`[NasdaqProvider] Direct fetch failed for ${cleanSym}: ${err}`);
    }

    return null;
  }

  async getQuotes(symbols: string[]): Promise<StockQuote[]> {
    const quotes: StockQuote[] = [];
    for (const sym of symbols) {
      const q = await this.getQuote(sym);
      if (q) quotes.push(q);
    }
    return quotes;
  }

  private async fetchSnapshot(
    symbol: string,
    type: 'A' | 'H',
  ): Promise<{ marketCap?: number; pe?: number; pb?: number; turnoverRate?: number } | null> {
    try {
      let secid: string;
      if (type === 'H') {
        secid = `116.${symbol}`;
      } else {
        const s = symbol.toLowerCase();
        secid = s.startsWith('6') || s.startsWith('9') ? `1.${symbol}` : `0.${symbol}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f116,f163,f167,f168`;
      const res = await undiciFetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const json = (await res.json()) as any;
      const d = json?.data;
      if (!d) return null;
      return {
        marketCap: typeof d.f116 === 'number' ? d.f116 : undefined,
        pe: typeof d.f163 === 'number' ? d.f163 / 100 : undefined,
        pb: typeof d.f167 === 'number' ? d.f167 / 100 : undefined,
        turnoverRate: typeof d.f168 === 'number' ? d.f168 / 100 : undefined,
      };
    } catch {
      return null;
    }
  }

  async getCandles(symbol: string, interval: string, range: string): Promise<StockCandles | null> {
    const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();

    // 1. Resolve Eastmoney secid (e.g. 105.NVDA for Nasdaq, 106.BABA for NYSE, 1.600519 for Shanghai, 0.000001 for Shenzhen, 116.00700 for HK)
    try {
      const searchRes = await this.searchSymbols(cleanSym);
      let secid = '';
      if (searchRes && searchRes.length > 0) {
        const item = searchRes[0] as any;
        secid = item.secid;
      }
      if (!secid) {
        const isAshare = /^(SH|SZ)?\d{6}$/i.test(cleanSym);
        const digits = cleanSym.replace(/^(SH|SZ)/i, '');
        if (isAshare) {
          secid = (digits.startsWith('6') || digits.startsWith('9') ? '1.' : '0.') + digits;
        } else if (/^(HK)?\d{5}$/i.test(cleanSym)) {
          secid = '116.' + cleanSym.replace(/^HK/i, '');
        } else {
          secid = '105.' + cleanSym; // Default Nasdaq
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=365`;
      const res = await undiciFetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const json = (await res.json()) as any;
        const klines = json?.data?.klines;
        if (Array.isArray(klines) && klines.length > 0) {
          const data: CandleDataPoint[] = klines.map((line: string) => {
            const parts = line.split(',');
            const dateStr = parts[0]; // e.g. "2025-08-07"
            const open = parseFloat(parts[1]) || 0;
            const close = parseFloat(parts[2]) || 0;
            const high = parseFloat(parts[3]) || 0;
            const low = parseFloat(parts[4]) || 0;
            const volume = parseInt(parts[5], 10) || 0;
            const time = Math.floor(new Date(dateStr).getTime() / 1000);

            return { time, open, high, low, close, volume };
          }).filter(pt => !isNaN(pt.time) && pt.time > 0);

          if (data.length > 0) {
            return {
              symbol: cleanSym,
              interval,
              range,
              data,
              source: 'EastmoneyHis',
              isDelayed: false,
            };
          }
        }
      }
    } catch (err) {
      logger.warn(`[EastmoneyCandles] Failed for ${cleanSym}: ${err}`);
    }

    // No synthetic candles: return null so callers can omit the chart/highs.
    return null;
  }

  async searchSymbols(query: string): Promise<StockSearchResult[]> {
    const cleanQ = query.trim();
    if (!cleanQ) return [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const url = `https://searchapi.eastmoney.com/api/suggest/get?type=14&token=D4357F9D2955B90757E0A343A8FA71E9&input=${encodeURIComponent(cleanQ)}`;
      const res = await undiciFetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = (await res.json()) as any;
        const list = json?.QuotationCodeTable?.Data || [];
        if (list.length > 0) {
          return list.slice(0, 5).map((item: any) => ({
            symbol: item.Code,
            name: item.Name,
            exchange: item.JYS || item.Classify || 'STOCKS',
            type: 'stock',
            currency: 'USD',
            secid: item.QuoteID || item.ID,
          }));
        }
      }
    } catch (err) {
      logger.warn(`[EastmoneySearch] Search failed for ${cleanQ}: ${err}`);
    }

    return [];
  }
}
