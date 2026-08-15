/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import { registerInvestHandler } from './investHandler.js';
import * as investDataFetcher from './investDataFetcher.js';
import * as agyCli from '../../../agy/agyCli.js';
import * as messageStore from '../../../agy/messageStore.js';
import * as fundProvider from '../../../stock/provider/fund.js';

vi.mock('./investDataFetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./investDataFetcher.js')>();
  return {
    ...actual,
    fetchInvestAnalysis: vi.fn(),
    fetchInvestAnalyses: vi.fn(),
    getInvestProjectPath: vi.fn().mockReturnValue('/test/invest-path'),
  };
});

vi.mock('../../../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn().mockResolvedValue({ exitCode: 0, output: '深度投资分析报告内容' }),
  getDefaultModel: vi.fn().mockReturnValue('Gemini 3.7 Flash (High)'),
  clearWeb2ApiHistory: vi.fn(),
  clearDeepSeekHistory: vi.fn(),
  clearOpenCodeHistory: vi.fn(),
}));

vi.mock('../../../agy/messageStore.js', () => ({
  saveMessage: vi.fn(),
}));

vi.mock('../../../config/userConfig.js', () => ({
  loadUserConfig: vi.fn().mockReturnValue({ proxy: 'http://127.0.0.1:7890' }),
  getDefaultModel: vi.fn().mockReturnValue('Gemini 3.7 Flash (High)'),
  getStockMarketApiKey: vi.fn().mockReturnValue('test-api-key'),
}));

vi.mock('../../../stock/provider/fund.js', () => ({
  getFundDataset: vi.fn().mockResolvedValue(null),
}));

describe('investHandler', () => {
  let commands: Record<string, Function>;
  let callbackHandler: Function | undefined;
  let mockBot: Partial<Bot>;
  let mockSessionManager: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    commands = {};
    callbackHandler = undefined;
    mockBot = {
      command: vi.fn((name: string, handler: Function) => {
        commands[name] = handler;
        return mockBot as any;
      }),
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'callback_query:data') callbackHandler = handler;
        return mockBot as any;
      }),
    };

    mockSessionManager = {
      getOrCreate: vi.fn().mockResolvedValue({
        conversationId: 'test-conv-uuid',
      }),
    };

    mockCtx = {
      match: '',
      chat: { id: 123456 },
      message: { message_thread_id: undefined },
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      api: {
        sendRichMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };

    registerInvestHandler(mockBot as Bot, mockSessionManager, {});
  });

  it('should register /invest command', () => {
    expect(mockBot.command).toHaveBeenCalledWith('invest', expect.any(Function));
    expect(commands['invest']).toBeDefined();
    expect(callbackHandler).toBeDefined();
  });

  it('should start /invest from the stock card callback', async () => {
    vi.mocked(investDataFetcher.fetchInvestAnalysis).mockResolvedValue({
      ok: true,
      symbol: 'NVDA',
      data: '{"grade":"A","totalScore":88}',
    });

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const callbackCtx = Object.assign(Object.create({
      get chat() { return mockCtx.chat; },
      get message() { return mockCtx.message; },
      get api() { return mockCtx.api; },
      reply: mockCtx.reply,
      answerCallbackQuery,
    }), {
      callbackQuery: { data: 'stock_invest:NVDA' },
    });

    await callbackHandler!(callbackCtx, vi.fn());

    expect(investDataFetcher.fetchInvestAnalysis).toHaveBeenCalledWith('NVDA', '/test/invest-path');
    expect(answerCallbackQuery).toHaveBeenCalledWith('正在启动价值分析…');
  });

  it('should show usage when no symbol is provided', async () => {
    mockCtx.match = '';
    await commands['invest'](mockCtx);
    expect(mockCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Invest Usage:'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('should handle single stock /invest via deterministic script with allowTools: true and save conversation', async () => {
    mockCtx.match = '600519';
    vi.mocked(investDataFetcher.fetchInvestAnalysis).mockResolvedValue({
      ok: true,
      symbol: '600519',
      data: '{"grade":"A","totalScore":88,"dimensions":[]}',
    });

    await commands['invest'](mockCtx);

    expect(investDataFetcher.fetchInvestAnalysis).toHaveBeenCalledWith('600519', '/test/invest-path');
    expect(agyCli.runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTools: true,
        conversationId: 'test-conv-uuid',
        model: 'Gemini 3.7 Flash (High)',
      })
    );
    expect(mockCtx.api.sendRichMessage).toHaveBeenCalledWith(123456, {
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'paragraph', text: '深度投资分析报告内容' }),
      ]),
    });
    expect(messageStore.saveMessage).toHaveBeenCalledWith(
      'test-conv-uuid',
      'user',
      '/invest 600519',
      'gemini-direct'
    );
    expect(messageStore.saveMessage).toHaveBeenCalledWith(
      'test-conv-uuid',
      'assistant',
      '深度投资分析报告内容',
      'gemini-direct'
    );
  });

  it('should handle multi-symbol /invest comparison flow with comma separation', async () => {
    mockCtx.match = '600519,000858';
    vi.mocked(investDataFetcher.fetchInvestAnalyses).mockResolvedValue([
      { ok: true, symbol: '600519', data: '{"grade":"A","totalScore":88}' },
      { ok: true, symbol: '000858', data: '{"grade":"A-","totalScore":78}' },
    ]);

    await commands['invest'](mockCtx);

    expect(investDataFetcher.fetchInvestAnalyses).toHaveBeenCalledWith(
      ['600519', '000858'],
      '/test/invest-path'
    );
    expect(agyCli.runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTools: true,
        conversationId: 'test-conv-uuid',
      })
    );
    expect(mockCtx.api.sendRichMessage).toHaveBeenCalledWith(123456, {
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'paragraph', text: '深度投资分析报告内容' }),
      ]),
    });
    expect(messageStore.saveMessage).toHaveBeenCalledWith(
      'test-conv-uuid',
      'user',
      '/invest 600519 vs 000858',
      'gemini-direct'
    );
  });

  it('should handle multi-symbol /invest comparison flow with vs syntax', async () => {
    mockCtx.match = 'NVDA vs AAPL';
    vi.mocked(investDataFetcher.fetchInvestAnalyses).mockResolvedValue([
      { ok: true, symbol: 'NVDA', data: '{"grade":"A+","totalScore":92}' },
      { ok: true, symbol: 'AAPL', data: '{"grade":"A","totalScore":85}' },
    ]);

    await commands['invest'](mockCtx);

    expect(investDataFetcher.fetchInvestAnalyses).toHaveBeenCalledWith(
      ['NVDA', 'AAPL'],
      '/test/invest-path'
    );
    expect(agyCli.runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTools: true,
        conversationId: 'test-conv-uuid',
      })
    );
  });

  it('should handle fund / ETF analysis', async () => {
    mockCtx.match = '005827';
    vi.mocked(fundProvider.getFundDataset).mockResolvedValue({
      symbol: '005827',
      name: '易方达蓝筹精选',
      info: {
        establishedDate: '2018-09-05',
        scaleB: 400,
        manager: '张坤',
        returns: { m1: 2, m3: 5, m6: 10, y1: 15, y3: 20 },
      },
      nav: [{ date: '2026-08-13', nav: 2.15, accNav: 2.15, changePct: 0.5 }],
      topHoldings: [],
    } as any);

    await commands['invest'](mockCtx);

    expect(fundProvider.getFundDataset).toHaveBeenCalledWith('005827');
    expect(agyCli.runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTools: true,
        conversationId: 'test-conv-uuid',
      })
    );
  });
});
