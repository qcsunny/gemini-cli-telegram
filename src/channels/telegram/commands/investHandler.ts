/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file investHandler.ts
 * @description Telegram command handler for `/invest <symbol>` — a one-command
 * value-investing analysis that scores a stock across six dimensions
 * (profitability, growth, financial health, cash-flow quality, valuation,
 * shareholder yield), flags red flags, and optionally asks the model for a
 * deep investment report.
 *
 * Scoring framework mirrors Graham (safety margin), Buffett (moat/ROE/cash
 * flow), Greenblatt (Magic Formula), Damodaran (growth) and Peter Lynch (PEG).
 */

import type { Bot, Context } from 'grammy';
import type { RichBlockTableCell, RichText } from '@grammyjs/types/rich.js';
import type { RichBlock } from '../richMessage.js';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type {
  StockQuote,
} from '../../../stock/types.js';
import { marketService } from '../../../stock/service/quote.js';
import { getDefaultModel, loadUserConfig } from '../../../config/userConfig.js';
import { runAgyPrint } from '../../../agy/agyCli.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

import {
  ensureQuotePerformance,
  ensureQuoteFinancials,
  ensureQuoteProfile,
  ensureQuoteDividendYield,
  buildFinancialBlocks,
} from './stockHandler.js';
import {
  fetchInvestAnalysis,
  fetchInvestAnalyses,
  buildInvestPrompt,
  buildComparePrompt,
  getInvestProjectPath,
} from './investDataFetcher.js';
import { buildTradingViewSymbol } from '../../../stock/utils/symbolHelper.js';
import { getFundDataset, type FundDataset } from '../../../stock/provider/fund.js';
import { analyzeFund, type FundAnalysisResult } from '../../../stock/analyzer/fundAnalyzer.js';
import { saveMessage } from '../../../agy/messageStore.js';
import { getChannelModel } from '../../../core/modelRegistry.js';
import { markdownToRichBlocks, splitRichBlocks, TELEGRAM_RICH_MAX_LENGTH } from '../formatter.js';

import { analyzeInvest, fmtAmount, type InvestResult, type InvestDimension } from './investScoring.js';

export type { InvestResult, InvestDimension };

// ── Rich-message rendering ──

function buildInvestBlocks(result: InvestResult): RichBlock[] {
  const blocks: RichBlock[] = [
    {
      type: 'paragraph',
      text: [
        { type: 'bold', text: [`⚖️ 价值投资分析 · ${result.name}（${result.symbol}）`] },
        `\n\n${result.summary}`,
        result.redFlags.length ? `\n\n⚠️ ${result.redFlags.join('；')}` : '',
      ],
    },
  ];

  // Dimension table
  const dimRows: RichBlockTableCell[][] = [];
  const mkCell = (label: string, value: string): RichBlockTableCell[] => [
    { text: { type: 'bold', text: [label] }, align: 'left', valign: 'middle' },
    { text: value, align: 'center', valign: 'middle' },
  ];
  for (const d of result.dimensions) {
    const bar = '▰'.repeat(Math.round(d.score / 10)) + '▱'.repeat(10 - Math.round(d.score / 10));
    dimRows.push(mkCell(`${d.name}`, `${d.score}/100 ${bar}`));
  }
  dimRows.push(mkCell('综合评分', `${result.totalScore.toFixed(1)}/100（${result.grade}）`));
  blocks.push({ type: 'table', cells: dimRows, is_bordered: true, is_striped: true });

  // Dimension notes
  for (const d of result.dimensions) {
    blocks.push({
      type: 'details',
      summary: { type: 'bold', text: [`📊 ${d.name}（${d.score}/100）`] },
      blocks: [{ type: 'paragraph', text: d.notes.map((n) => `• ${n}`).join('\n') }],
    });
  }

  return blocks;
}

function buildDeepReportPrompt(result: InvestResult, quote: StockQuote): string {
  const fs = quote.financials?.[0];
  const bs = quote.balanceSheets?.[0];
  const cf = quote.cashFlows?.[0];
  const dimDetails = result.dimensions
    .map((d) => `- ${d.name} ${d.score}/100：${d.notes.join('；')}`)
    .join('\n');

  const pick = (v: unknown, label: string): string | null =>
    v === undefined || v === null || (typeof v === 'number' && !isFinite(v))
      ? null
      : `${label} ${v}`;
  const fsParts = [
    pick(fs?.revenue, '营收'),
    pick(fs?.costOfRevenue, '营业成本'),
    pick(fs?.grossProfit, '毛利'),
    pick(fs?.operatingIncome, '营业利润'),
    pick(fs?.incomeBeforeTax, '税前利润'),
    pick(fs?.incomeTaxExpense, '所得税'),
    pick(fs?.netIncome, '净利'),
    pick(fs?.grossMargin, '毛利率'),
    pick(fs?.netMargin, '净利率'),
    pick(fs?.operatingMargin, '营业利润率'),
    pick(fs?.roe, 'ROE'),
    pick(fs?.epsDiluted, 'EPS'),
    pick(fs?.bps, '每股净资产'),
    pick(fs?.revenueYoY, '营收同比'),
    pick(fs?.netIncomeYoY, '净利同比'),
  ].filter(Boolean);
  const bsParts = [
    pick(bs?.totalAssets, '总资产'),
    pick(bs?.totalLiabilities, '总负债'),
    pick(bs?.netAssets, '净资产'),
    pick(bs?.parentEquity, '股东权益'),
    pick(bs?.currentAssets, '流动资产'),
    pick(bs?.currentLiabilities, '流动负债'),
    pick(bs?.cash, '货币资金'),
    pick(bs?.inventory, '存货'),
    pick(bs?.accountsReceivable, '应收账款'),
    pick(bs?.goodwill, '商誉'),
    pick(bs?.shortTermDebt, '短期借款'),
    pick(bs?.longTermDebt, '长期借款'),
    pick(bs?.debtRatio, '资产负债率'),
  ].filter(Boolean);
  const cfParts = [
    pick(cf?.netCashOperating, '经营现金流'),
    pick(cf?.netCashInvesting, '投资现金流'),
    pick(cf?.netCashFinancing, '筹资现金流'),
    pick(cf?.endCash, '期末现金'),
  ].filter(Boolean);
  const quoteParts = [
    pick(quote.price, '当前价'),
    pick(quote.pe, 'PE'),
    pick(quote.pb, 'PB'),
    pick(quote.marketCap, '总市值'),
    pick(quote.high52, '52周最高'),
    pick(quote.low52, '52周最低'),
  ].filter(Boolean);

  const annuals = (quote.financials ?? []).filter((f) => f.isAnnual || f.date.endsWith('-12-31')).slice(0, 5);
  const annualSummary = annuals.length
    ? annuals
        .map(
          (a) =>
            `- ${a.date} (${a.period})：营收 ${fmtAmount(a.revenue)} | 净利 ${a.netIncome !== undefined ? fmtAmount(a.netIncome) : '--'} | 毛利率 ${a.grossMargin != null ? a.grossMargin.toFixed(1) + '%' : '--'} | ROE ${a.roe != null ? a.roe.toFixed(1) + '%' : '--'}`
        )
        .join('\n')
    : '无（请主动联网搜寻补齐近 5 年年报数据）';

  return [
    `请对股票 ${quote.name}（${quote.symbol}，市场 ${quote.market}）做一份专业的价值投资深度分析报告。`,
    '',
    '## 已计算的六维度量化评分',
    dimDetails,
    `综合评分 ${result.totalScore.toFixed(1)}/100，评级「${result.rating}」（${result.grade}）。`,
    result.redFlags.length ? `红旗警示：${result.redFlags.join('；')}` : '',
    '',
    '## 最新一期财务数据',
    fsParts.length ? fsParts.join('，') : '无',
    bsParts.length ? bsParts.join('，') : '',
    cfParts.length ? cfParts.join('，') : '',
    quoteParts.length ? quoteParts.join('，') : '',
    quote.profile ? `公司简介：${quote.profile}` : '',
    quote.fmpRateLimited ? `\n⚠️ 【数据提醒】美股确定性 API 接口每日配额受限 (HTTP 429)。请大模型主动调用联网搜索工具，查集补齐 ${quote.symbol} 近 5 期 (近4季度及近5年年报) 的营收、净利润、EPS、毛利率等三大报表真实数据。` : '',
    '',
    '## 抓取的近 5 年年度财报历史趋势（确定性数据）',
    annualSummary,
    '',
    '## 报告要求',
    '1. 用中文输出，Markdown 格式。',
    '2. 结构：公司概览 → 商业模式与护城河 → 盈利质量与5年趋势 → 成长驱动 → 财务健康与风险 → 估值判断 → 投资结论与建议。',
    '3. 结合量化评分与近 5 年年度财报数据给出明确结论（强烈看多/看多/中性/看空/强烈看空），并给出关键风险提示。',
    '4. 上述字段若标注缺失，多半是接口限制，不代表公司没有该数据。',
    '5. 对缺失的关键历史字段或需深度延伸的指标，请主动调用工具或联网搜索补齐 5 年历史真实数值，并把补齐结果写进报告；不要编造数据。',
    '6. 明确区分「确定性数据」和「联网补齐的数据」，并在报告里注明信息来源。',
  ].filter(Boolean).join('\n');
}

function buildFundBlocks(result: FundAnalysisResult, ds: FundDataset): RichBlock[] {
  const info = ds.info;
  const blocks: RichBlock[] = [];

  const dimText: RichText[] = result.dimensions.flatMap<RichText>((d, i) => [
    ...(i > 0 ? ['\n\n'] : []),
    '• ',        { type: 'bold', text: [`${d.name}`] },
    ` (${d.score}分 - 权重${(d.weight * 100).toFixed(0)}%)\n  ${d.notes.join('；')}`,
  ]);

  const riskText: RichText[] = result.redFlags.length
    ? ['\n\n⚠️ ', { type: 'bold', text: ['关注风险'] }, `：${result.redFlags.join('；')}`]
    : [];

  blocks.push({
    type: 'paragraph',
    text: [
      { type: 'bold', text: [`🏦 基金/ETF 评价：${result.name} (${ds.symbol})`] },
      `\n类型：${result.type} | 评级：`,
      { type: 'bold', text: [`${result.rating} (${result.grade})`] },
      ` | 综合得分：`,
      { type: 'bold', text: [`${result.totalScore.toFixed(1)}/100`] },
      `\n\n成立日期：${info?.establishedDate || '未知'} | 规模：${info?.scaleB ? info.scaleB.toFixed(2) + ' 亿元' : '未知'}\n基金经理：${info?.manager || '未知'}${info?.managerTenure ? ` (任期 ${info.managerTenure.days} 天，任职回报 ${info.managerTenure.returnPct != null ? (info.managerTenure.returnPct >= 0 ? '+' : '') + info.managerTenure.returnPct.toFixed(2) + '%' : '--'})` : ''}\n费率：管理费 ${info?.managementFeePct != null ? info.managementFeePct + '%' : '--'} / 托管费 ${info?.custodyFeePct != null ? info.custodyFeePct + '%' : '--'}`,
      ...riskText,
    ],
  });

  blocks.push({
    type: 'details',
    summary: { type: 'bold', text: ['📊 七维规则引擎量化打分明细'] },
    blocks: [{ type: 'paragraph', text: dimText }],
  });

  if (ds.topHoldings?.length) {
    const rows: RichBlockTableCell[][] = [
      [
        { text: { type: 'bold', text: ['股票名称'] }, align: 'center', valign: 'middle' },
        { text: { type: 'bold', text: ['代码'] }, align: 'center', valign: 'middle' },
        { text: { type: 'bold', text: ['占净值比'] }, align: 'center', valign: 'middle' },
      ],
    ];
    for (const h of ds.topHoldings.slice(0, 10)) {
      rows.push([
        { text: h.stockName, align: 'center', valign: 'middle' },
        { text: h.stockCode, align: 'center', valign: 'middle' },
        { text: `${h.ratioPct != null ? h.ratioPct.toFixed(2) + '%' : '--'}`, align: 'center', valign: 'middle' },
      ]);
    }
    blocks.push({
      type: 'details',
      summary: { type: 'bold', text: [`📋 前 10 大重仓持仓明细（最新季报）`] },
      blocks: [{ type: 'table', cells: rows, is_bordered: true, is_striped: true }],
    });
  }

  return blocks;
}

function buildFundDeepReportPrompt(result: FundAnalysisResult, ds: FundDataset): string {
  const info = ds.info;
  const dimDetails = result.dimensions
    .map((d) => `- ${d.name} ${d.score}/100：${d.notes.join('；')}`)
    .join('\n');
  const holdingsText = ds.topHoldings.length
    ? ds.topHoldings.slice(0, 10).map((h) => `${h.stockName}(${h.stockCode}): ${h.ratioPct}%`).join('，')
    : '无/未公开';

  return [
    `请对基金 ${result.name}（代码 ${ds.symbol}，类型 ${result.type}）做一份专业的基金深度价值投资诊断报告。`,
    '',
    '## 已计算的七维度量化评分',
    dimDetails,
    `综合评分 ${result.totalScore.toFixed(1)}/100，评级「${result.rating}」（${result.grade}）。`,
    result.redFlags.length ? `关注风险：${result.redFlags.join('；')}` : '',
    '',
    '## 抓取的基金确定性基本面数据',
    `成立日期：${info?.establishedDate || '未知'}`,
    `最新规模：${info?.scaleB ? info.scaleB.toFixed(2) + ' 亿元' : '未知'}`,
    `现任经理：${info?.manager || '未知'}${info?.managerTenure ? `（任期 ${info.managerTenure.days} 天，任职回报 ${info.managerTenure.returnPct != null ? info.managerTenure.returnPct.toFixed(2) + '%' : '--'}）` : ''}`,
    `官方区间收益率：近1月 ${info?.returns.m1 != null ? info.returns.m1 + '%' : '--'}，近3月 ${info?.returns.m3 != null ? info.returns.m3 + '%' : '--'}，近6月 ${info?.returns.m6 != null ? info.returns.m6 + '%' : '--'}，近1年 ${info?.returns.y1 != null ? info.returns.y1 + '%' : '--'}，近3年 ${info?.returns.y3 != null ? info.returns.y3 + '%' : '--'}`,
    `同类排名：${ds.peerRank ? `近1年同类名次 ${ds.peerRank.rank}/${ds.peerRank.total}（前 ${ds.peerRank.percentilePct}%）` : '未知'}`,
    `费率：管理费 ${info?.managementFeePct != null ? info.managementFeePct + '%' : '--'} / 托管费 ${info?.custodyFeePct != null ? info.custodyFeePct + '%' : '--'}`,
    `前10大重仓持仓：${holdingsText}`,
    '',
    '## 报告要求',
    '1. 用中文输出，Markdown 格式。',
    '2. 结构：基金概览与定位 → 投资策略与经理风格 → 收益与风险风控评估（夏普/回撤） → 持仓集中度与重仓股穿透分析 → 规模与费率合理性 → 综合诊断结论与配置建议。',
    '3. 结合七维度量化评分与确定性抓取的数据给出明确结论（强烈看多/看多/中性/看空/强烈看空），并提示风险。',
  ].join('\n');
}

function toStoreBackend(channel: string | null): 'web2api' | 'deepseek' | 'glm' | 'gemini-direct' | 'opencode' {
  if (channel === 'web2api') return 'web2api';
  if (channel === 'deepseek') return 'deepseek';
  if (channel === 'glm') return 'glm';
  if (channel === 'opencode') return 'opencode';
  return 'gemini-direct';
}

async function runInvestModel(opts: {
  prompt: string;
  userPrompt: string;
  cwd: string;
  model: string;
  proxy?: string;
  conversationId?: string;
}) {
  const { prompt, userPrompt, cwd, model, proxy, conversationId } = opts;
  const res = await runAgyPrint({
    prompt,
    cwd,
    model,
    proxy,
    allowTools: true,
    conversationId,
  });
  if (res.exitCode === 0 && res.output && conversationId) {
    const backend = toStoreBackend(getChannelModel(model));
    saveMessage(conversationId, 'user', userPrompt, backend);
    saveMessage(conversationId, 'assistant', res.output, backend);
  }
  return res;
}

/**
 * Send the model-generated deep report as native rich blocks (Option A),
 * falling back to raw rich markdown (Option C) when block conversion or the
 * blocks send fails — mirroring the channelReply rich-message pipeline so
 * `**bold**` and tables render instead of showing literal asterisks.
 */
async function sendInvestDeepReport(ctx: Context, chatId: number, markdown: string): Promise<void> {
  try {
    const blocks = markdownToRichBlocks(markdown);
    if (blocks.length > 0) {
      const parts = splitRichBlocks(blocks, TELEGRAM_RICH_MAX_LENGTH);
      for (const part of parts) {
        await ctx.api.sendRichMessage(chatId, { blocks: part });
      }
      return;
    }
  } catch (err: unknown) {
    logger.warn(`sendInvestDeepReport blocks failed: ${err instanceof Error ? err.message : String(err)}. Falling back to rich markdown`);
  }
  await ctx.api.sendRichMessage(chatId, { markdown });
}

export function registerInvestHandler(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  const handleInvest = async (ctx: Context, symbolOverride?: string): Promise<void> => {
    const rawArgs = symbolOverride ?? ctx.match;
    const trimmed = typeof rawArgs === 'string' ? rawArgs.trim() : '';
    const targetChatId = ctx.chat?.id ?? ctx.from?.id;

    const reply = async (text: string, other?: Parameters<Context['reply']>[1]): Promise<unknown> => {
      if (ctx.reply) {
        try {
          return await ctx.reply(text, other);
        } catch (err: unknown) {
          if (targetChatId && ctx.api?.sendMessage) {
            return await ctx.api.sendMessage(targetChatId, text, other);
          }
          throw err;
        }
      } else if (targetChatId && ctx.api?.sendMessage) {
        return await ctx.api.sendMessage(targetChatId, text, other);
      }
      return undefined;
    };

    if (!trimmed) {
      await reply(
        `${ICONS.info} <b>Invest Usage:</b>\n\n<code>/invest NVDA</code>\n<code>/invest 600519</code>\n<code>/invest 600519,000858</code>\n<code>/invest NVDA vs AAPL</code>\n<code>/invest 005827</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (!targetChatId) {
      logger.error('[Invest] No targetChatId found in context');
      return;
    }

    const session = await sessionManager.getOrCreate(
      targetChatId,
      defaultOptions,
      ctx.message?.message_thread_id,
    );
    const conversationId = session.conversationId;
    const proxy = loadUserConfig()?.proxy || undefined;

    // Check if multi-symbol comparison (e.g. "NVDA,AAPL", "600519 vs 000858", "对比 600519 000858", "600519，000858")
    const cleanArgs = trimmed.replace(/^(对比|compare|vs)\s+/i, '');
    const symbols = cleanArgs
      .split(/[,\s，、]+|(?:\s+(?:vs|VS|对比|对)\s+)/)
      .map((s) => s.replace(/^\$/, '').trim())
      .filter((s) => s && !/^(vs|VS|对比|对)$/i.test(s));

    if (symbols.length >= 2) {
      const investCwd = getInvestProjectPath();
      await reply(
        `${ICONS.info} 正在并发抓取 <b>${symbols.join('、')}</b> 确定性财报与估值数据进行同行业对比…`,
        { parse_mode: 'HTML' }
      );
      try {
        const fetchResults = await fetchInvestAnalyses(symbols, investCwd);
        const okResults = fetchResults.filter((r) => r.ok && r.data);
        const model = getDefaultModel();
        if (model) {
          await reply(`${ICONS.thinking} 正在生成多标的价值投资深度对比报告…`);
          const userPrompt = `/invest ${symbols.join(' vs ')}`;
          const prompt = okResults.length > 0
            ? buildComparePrompt(
                fetchResults,
                `请对以下 ${okResults.map((r) => r.symbol ?? '?').join('、')} 做同行业深度对比分析，输出对比报告。`,
              )
            : `请对以下标的 ${symbols.join('、')} 进行同行业价值投资深度对比分析。`;

          const res = await runInvestModel({
            prompt,
            userPrompt,
            cwd: investCwd,
            model,
            proxy,
            conversationId,
          });
          if (res.exitCode === 0 && res.output) {
            await sendInvestDeepReport(ctx, targetChatId, res.output);
          } else {
            await reply(`${ICONS.warning} 多标的对比报告生成失败（exit ${res.exitCode}）`);
          }
        }
        return;
      } catch (err) {
        logger.error(`Failed to handle multi-symbol /invest comparison: ${err}`);
        await reply(`${ICONS.error} <b>对比分析失败</b>: ${(err as Error)?.message || err}`);
        return;
      }
    }

    const symbol = symbols[0] || trimmed.replace(/^\$/, '').trim();

    try {
      // 1. Check if symbol is a Fund / ETF (e.g. 005827, 012708, sh510300)
      const fundDataset = await getFundDataset(symbol);
      if (fundDataset && (fundDataset.info || fundDataset.nav.length > 0)) {
        const fundResult = analyzeFund(fundDataset);
        const fundBlocks = buildFundBlocks(fundResult, fundDataset);
        await ctx.api.sendRichMessage(targetChatId, { blocks: fundBlocks });

        const model = getDefaultModel();
        if (model) {
          await reply(`${ICONS.thinking} 正在基于 7 维度框架生成基金深度分析报告…`);
          const prompt = buildFundDeepReportPrompt(fundResult, fundDataset);
          const res = await runInvestModel({
            prompt,
            userPrompt: `/invest ${symbol}`,
            cwd: getInvestProjectPath(),
            model,
            proxy,
            conversationId,
          });
          if (res.exitCode === 0 && res.output) {
            await sendInvestDeepReport(ctx, targetChatId, res.output);
          } else {
            await reply(`${ICONS.warning} 基金深度报告生成失败（exit ${res.exitCode}）`);
          }
        }
        return;
      }

      // 2. Prefer the deterministic value-invest-analysis script (same data
      //    source as the inline /invest card). Inject its scored JSON into a
      //    deep-analysis prompt and stream the full report here. Fall back to
      //    the local bot scoring below when the script is unavailable.
      const investCwd = getInvestProjectPath();
      try {
        const investResult = await fetchInvestAnalysis(symbol, investCwd);
        if (investResult.ok && investResult.data) {
          logger.info(`[Invest] script analysis OK for ${investResult.symbol ?? symbol}`);
          await reply(
            `${ICONS.info} <b>${investResult.symbol ?? symbol}</b> — 价值投资分析专家脚本已生成确定性报告，正在生成深度分析…`,
            { parse_mode: 'HTML' }
          );
          const model = getDefaultModel();
          if (model) {
            const prompt = buildInvestPrompt(
              `请对 ${investResult.symbol ?? symbol} 做深度价值投资分析。`,
              investResult.data,
            );
            const res = await runInvestModel({
              prompt,
              userPrompt: `/invest ${investResult.symbol ?? symbol}`,
              cwd: investCwd,
              model,
              proxy,
              conversationId,
            });
            if (res.exitCode === 0 && res.output) {
              await sendInvestDeepReport(ctx, targetChatId, res.output);
            } else {
              await reply(`${ICONS.warning} 深度报告生成失败（exit ${res.exitCode}）`);
            }
          }
          return;
        }
        logger.warn(`[Invest] script analysis failed for ${symbol}, falling back to local: ${investResult.error}`);
      } catch (err) {
        logger.warn(`[Invest] script analysis threw for ${symbol}, falling back to local: ${err}`);
      }

      // 3. Stock / Market Quote Analysis Pathway
      const quote = await marketService.getQuote(symbol);
      if (!quote) {
        await reply(`${ICONS.warning} ⚠️ <b>Symbol not found:</b> ${symbol}\n\nPlease check the symbol and try again.`);
        return;
      }

      await ensureQuotePerformance(quote);
      await ensureQuoteFinancials(quote);
      await ensureQuoteProfile(quote);
      await ensureQuoteDividendYield(quote);

      const result = analyzeInvest(quote);
      const blocks = buildInvestBlocks(result);
      const finBlocks = buildFinancialBlocks(
        quote.financials ?? [],
        quote.balanceSheets,
        quote.cashFlows,
        quote.currency,
      );

      const tvSymbol = buildTradingViewSymbol(quote.symbol, quote.market);
      const detailUrl = `https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol.replace(':', '-'))}/`;
      const chartUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&hidesidetoolbar=1&symboledit=1&saveimage=1&toolbarbg=F1F3F6&theme=dark`;

      await ctx.api.sendRichMessage(targetChatId, { blocks: [...blocks, ...finBlocks] }, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 查看详情', url: detailUrl },
              { text: '📈 K线图', url: chartUrl },
              { text: '⭐ 加自选', callback_data: `wl_add:${quote.symbol}` }
            ]
          ]
        }
      });

      // Deep report via the model
      const model = getDefaultModel();
      if (model) {
        await reply(`${ICONS.thinking} 正在生成深度分析报告…`);
        const prompt = buildDeepReportPrompt(result, quote);
        const res = await runInvestModel({
          prompt,
          userPrompt: `/invest ${quote.symbol}`,
          cwd: getInvestProjectPath(),
          model,
          proxy,
          conversationId,
        });
        if (res.exitCode === 0 && res.output) {
          await sendInvestDeepReport(ctx, targetChatId, res.output);
        } else {
          await reply(`${ICONS.warning} 深度报告生成失败（exit ${res.exitCode}）`);
        }
      }
    } catch (err) {
      logger.error(`Failed to handle /invest command for ${symbol}: ${err}`);
      await reply(`${ICONS.error} <b>Error running invest analysis for ${symbol}</b>: ${(err as Error)?.message || err}`);
    }
  };

  bot.command(['invest', 'compare'], (ctx) => handleInvest(ctx));
  bot.on('callback_query:data', async (ctx, next) => {
    const match = ctx.callbackQuery.data.match(/^stock_invest:(.+)$/);
    if (!match) {
      await next();
      return;
    }
    const symbol = match[1]?.trim();
    if (!symbol) return;
    await ctx.answerCallbackQuery('正在启动价值分析…').catch(() => {});
    await handleInvest(ctx, symbol);
  });
}
