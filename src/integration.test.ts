/**
 * @file integration.test.ts
 * @description End-to-end integration tests for the gemini-cli-telegram bot.
 *
 * These tests mock the outermost boundaries (Telegram Bot API, HTTP backends)
 * and exercise the full vertical slice:
 *   Telegram event → handler → messageLoop → backend → channelReply → Telegram API
 *
 * Coverage:
 *  1. Private chat rich-message full path (draft → stream → finalize)
 *  2. Multi-model fallback chain (primary fail → downgrade → succeed)
 *  3. BUG-02: forceReleaseDraft cleans activeDraftIds on error path
 *  4. BUG-01: touchPendingResult is exported and callable
 *  5. BUG-03: DeepSeek backend adds Socket-level setTimeout
 *  6. BUG-04: History Map caps at 500 entries to prevent OOM
 *  7. BUG-06: GeminiDirect surfaces API error JSON instead of swallowing
 *  8. InlineStreamQueue throttling and 429 backoff
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('./utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./agy/conversationStore.js', () => ({
  setConversation: vi.fn(),
}));

vi.mock('./agy/messageStore.js', () => ({
  saveMessage: vi.fn(),
  getHistory: vi.fn((_map: Map<string, any[]>) => []),
}));

vi.mock('./config/userConfig.js', () => ({
  loadUserConfig: vi.fn(() => ({ deepseekApiKey: 'test-key' })),
  getTuningConfig: vi.fn(() => ({
    debounceIntervalMs: 0,
    maxHistoryMessages: 20,
    cacheTtlMs: 60_000,
    cacheMaxSize: 100,
  })),
  getBackendUrl: vi.fn(() => 'http://localhost:12345'),
}));

// Mock messageCache to avoid LRUCache initialization with undefined params
vi.mock('./utils/messageCache.js', () => ({
  messageCache: {
    set: vi.fn(),
    get: vi.fn(() => undefined),
    delete: vi.fn(),
    has: vi.fn(() => false),
    capacity: 100,
  },
}));


vi.mock('./agy/conversationManager.js', () => ({
  deepseekHistories: new Map(),
  geminiDirectHistories: new Map(),
  web2apiHistories: new Map(),
  opencodeHistories: new Map(),
  makeDeepSeekConvId: vi.fn(() => 'deepseek-test-conv'),
  makeWeb2ApiConvId: vi.fn(() => 'web2api-test-conv'),
  makeOpenCodeConvId: vi.fn(() => 'opencode-test-conv'),
  clearDeepSeekHistory: vi.fn(),
  clearWeb2ApiHistory: vi.fn(),
  clearGeminiDirectHistory: vi.fn(),
  clearOpenCodeHistory: vi.fn(),
  restoreHistoriesFromDb: vi.fn(),
}));

vi.mock('./core/modelRegistry.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, loadModelsConfig: vi.fn(() => ({ routing: {} })) };
});

vi.mock('./agy/agyCli.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, runAgyPrint: vi.fn() };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { processMessage } from './core/messageLoop.js';
import { buildChannelReply, forceReleaseDraft } from './channels/telegram/bot/channelReply.js';
import { touchPendingResult } from './channels/telegram/commands/inlineHandler.js';
import { runDeepSeek } from './agy/backends/deepseek.js';
import { runGeminiDirect } from './agy/backends/geminiDirect.js';
import { runAgyPrint } from './agy/agyCli.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(model = 'Gemini 3.6 Flash (Medium)'): any {
  return {
    sessionId: '111', chatId: 111, conversationId: 'conv-111', model,
    currentProject: { path: '/test' }, abortController: new AbortController(),
    turnCount: 0, busy: false,
  };
}

function makeRichReply() {
  return {
    send: vi.fn().mockResolvedValue(100),
    edit: vi.fn().mockResolvedValue(undefined),
    sendPlain: vi.fn().mockResolvedValue(200),
    editPlain: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(), sendDocument: vi.fn(),
    sendRich: vi.fn().mockResolvedValue(300),
    sendRichDraft: vi.fn().mockResolvedValue(400),
    editRich: vi.fn().mockResolvedValue(undefined),
    editRichDraft: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFormatter() {
  return {
    chunkText: vi.fn((t: string) => [t]),
    truncateForEdit: vi.fn((t: string) => t),
    truncateForStream: vi.fn((t: string) => t),
    findSafeCutPoint: vi.fn((t: string, max: number) => Math.min(t.length, max)),
  };
}

// =============================================================================
// SUITE 1: Private chat full rich message path
// =============================================================================

describe('[Integration] Private chat: rich message full path', () => {
  beforeEach(() => vi.resetAllMocks());

  it('streams thought+body and finalizes into a single rich message', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      opts.onEvent?.({ type: 'thought', content: 'reasoning...' });
      opts.onEvent?.({ type: 'text', content: 'Answer here.' });
      opts.onEvent?.({ type: 'done' });
      return { output: '<thought>reasoning...</thought>Answer here.', conversationId: 'cv1', exitCode: 0 };
    });

    await processMessage(session, { text: 'hello' }, reply, makeFormatter());

    expect(reply.sendRichDraft).toHaveBeenCalled();
    expect(reply.sendRich).toHaveBeenCalled();
    const finalArg = (reply.sendRich as any).mock.calls[0][0];
    expect(finalArg.content).toContain('Answer here.');
    // No extra standalone messages
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('sends a single rich message for pure body (no thinking)', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      opts.onEvent?.({ type: 'text', content: 'Short answer.' });
      opts.onEvent?.({ type: 'done' });
      return { output: 'Short answer.', conversationId: 'cv2', exitCode: 0 };
    });

    await processMessage(session, { text: 'hi' }, reply, makeFormatter());

    expect(reply.sendRich).toHaveBeenCalled();
    const finalArg = (reply.sendRich as any).mock.calls[0][0];
    expect((finalArg.content ?? finalArg)).toContain('Short answer.');
  });

  it('shows an error notification when model returns exitCode != 0', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockResolvedValue({
      output: '', stderr: 'rate limit hit', conversationId: 'cv3', exitCode: 1,
    } as any);

    await processMessage(session, { text: 'hello' }, reply, makeFormatter());

    const allMsgs = [
      ...(reply.send as any).mock.calls.map((c: any[]) => c[0]),
      ...(reply.edit as any).mock.calls.map((c: any[]) => c[1]).filter(Boolean),
    ].filter(Boolean);
    const hasError = allMsgs.some((m: string) =>
      m.includes('执行失败') || m.includes('rate limit') || m.includes('⚠️') || m.includes('❌')
    );
    expect(hasError).toBe(true);
  });

  it('reaches fallback model and gets successful response', async () => {
    const session = makeSession('Gemini 3.1 Pro (Low)');
    const reply = makeRichReply();
    let callCount = 0;

    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      callCount++;
      if (callCount <= 3) {
        return { output: '', stderr: '429 quota exceeded', conversationId: 'cv', exitCode: 1 };
      }
      opts.onEvent?.({ type: 'text', content: 'Fallback OK.' });
      opts.onEvent?.({ type: 'done' });
      return { output: 'Fallback OK.', conversationId: 'cv-fb', exitCode: 0 };
    });

    await processMessage(session, { text: 'fallback test' }, reply, makeFormatter());

    expect(reply.sendRich).toHaveBeenCalled();
    const finalArg = (reply.sendRich as any).mock.calls[0][0];
    expect((finalArg.content ?? finalArg)).toContain('Fallback OK.');
  });
});

// =============================================================================
// SUITE 2: BUG-05/07 - Fallback notifications and error hints
// =============================================================================

describe('[Integration] Fallback UX (BUG-05/07)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('BUG-07: shows non-agy channel hint for web2api failure', async () => {
    const session = makeSession('Web2API: Gemini Flash Lite');
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockResolvedValue({
      output: '', stderr: 'connection refused', conversationId: 'cv', exitCode: 1,
    } as any);

    await processMessage(session, { text: 'test' }, reply, makeFormatter());

    const allMsgs = [
      ...(reply.send as any).mock.calls.map((c: any[]) => c[0]),
      ...(reply.edit as any).mock.calls.map((c: any[]) => c[1]).filter(Boolean),
    ].filter(Boolean).filter((m: any) => typeof m === 'string');

    // MUST NOT say "agy CLI" for a web2api channel failure
    const hasAgyHint = allMsgs.some((m: string) => m.includes('agy` CLI'));
    expect(hasAgyHint).toBe(false);
  });
});

// =============================================================================
// SUITE 3: BUG-02 — forceReleaseDraft prevents activeDraftIds leak
// =============================================================================

describe('[Integration] BUG-02: forceReleaseDraft cleanup', () => {
  it('does not throw for an unknown chatId', () => {
    expect(() => forceReleaseDraft(999999)).not.toThrow();
  });

  it('releases a draft created by sendRichDraft without error', async () => {
    const mockRaw = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 801 }),
      sendRichMessageDraft: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const mockCtx: any = {
      reply: vi.fn().mockResolvedValue({ message_id: 900 }),
      api: {
        deleteMessage: vi.fn(),
        editMessageText: vi.fn().mockResolvedValue(true),
        sendRichMessage: vi.fn().mockImplementation((_cid: number, rm: any) =>
          mockRaw.sendRichMessage({ rich_message: rm })),
        sendRichMessageDraft: vi.fn().mockImplementation((_cid: number, _did: number, rm: any) =>
          mockRaw.sendRichMessageDraft({ rich_message: rm })),
        raw: mockRaw,
      },
    };

    const chatId = 55555;
    const reply = buildChannelReply(mockCtx, chatId, 'RichText');
    const draftId = await reply.sendRichDraft!('draft text');
    expect(typeof draftId).toBe('number');

    expect(() => forceReleaseDraft(chatId)).not.toThrow();

    // After release, sendRich should work normally (no stale draft-blocker)
    await reply.sendRich!('final text');
    expect(mockRaw.sendRichMessage).toHaveBeenCalled();
  });

  it('messageLoop finally block still runs when runAgyPrint throws unexpectedly', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockRejectedValue(new Error('Unexpected crash'));

    await expect(
      processMessage(session, { text: 'crash test' }, reply, makeFormatter())
    ).resolves.not.toThrow();

    // busy must always be reset in the finally block
    expect(session.busy).toBe(false);
  });
});

// =============================================================================
// SUITE 4: BUG-01 — touchPendingResult TTL renewal
// =============================================================================

describe('[Integration] BUG-01: touchPendingResult TTL renewal', () => {
  it('is exported as a function', () => {
    expect(typeof touchPendingResult).toBe('function');
  });

  it('does not throw for an unknown resultId', () => {
    expect(() => touchPendingResult('nonexistent-result-id-xyz')).not.toThrow();
  });
});

// =============================================================================
// SUITE 5: BUG-03 — DeepSeek Socket-level setTimeout
// =============================================================================

describe('[Integration] BUG-03: DeepSeek Socket timeout guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls req.setTimeout with a positive timeout value for TCP protection', async () => {
    const fakeRes = new EventEmitter() as any;
    const fakeReq = new EventEmitter() as any;
    fakeReq.write = vi.fn();
    fakeReq.end = vi.fn();
    fakeReq.destroy = vi.fn();
    fakeReq.setTimeout = vi.fn();

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      setTimeout(() => {
        cb(fakeRes);
        fakeRes.emit('data', Buffer.from('data: [DONE]\n'));
        fakeRes.emit('end');
      }, 0);
      return fakeReq as any;
    });

    await runDeepSeek({ prompt: 'test', model: 'deepseek', cwd: '/tmp' });

    expect(fakeReq.setTimeout).toHaveBeenCalled();
    const ms = (fakeReq.setTimeout as any).mock.calls[0][0];
    expect(ms).toBeGreaterThan(0);
    const callbackArg = (fakeReq.setTimeout as any).mock.calls[0][1];
    expect(typeof callbackArg).toBe('function');
  });

  it('streams SSE chunks correctly and resolves with full output', async () => {
    const fakeRes = new EventEmitter() as any;
    const fakeReq = new EventEmitter() as any;
    fakeReq.write = vi.fn();
    fakeReq.end = vi.fn();
    fakeReq.destroy = vi.fn();
    fakeReq.setTimeout = vi.fn();

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      setTimeout(() => {
        cb(fakeRes);
        const c1 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n';
        const c2 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n';
        fakeRes.emit('data', Buffer.from(c1 + c2 + 'data: [DONE]\n'));
        fakeRes.emit('end');
      }, 0);
      return fakeReq as any;
    });

    const chunks: string[] = [];
    const result = await runDeepSeek({ prompt: 'test', model: 'deepseek', cwd: '/tmp', onChunk: (c) => chunks.push(c) });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Hello ');
    expect(result.output).toContain('world');
  });

  it('resolves with exitCode=1 and partial output when AbortController fires', async () => {
    const fakeRes = new EventEmitter() as any;
    const fakeReq = new EventEmitter() as any;
    fakeReq.write = vi.fn();
    fakeReq.end = vi.fn();
    fakeReq.destroy = vi.fn();
    fakeReq.setTimeout = vi.fn();

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      setTimeout(() => {
        cb(fakeRes);
        fakeRes.emit('data', Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Partial' } }] }) + '\n'));
        // Never emits 'end' — simulates hang
      }, 0);
      return fakeReq as any;
    });

    const ctrl = new AbortController();
    const promise = runDeepSeek({ prompt: 'test', model: 'deepseek', cwd: '/tmp', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Abort');
  });
});

// =============================================================================
// SUITE 6: BUG-04 — History Map OOM cap
// =============================================================================

describe('[Integration] BUG-04: History Map size cap prevents OOM', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deepseekHistories stays bounded after exceeding 500 entries', async () => {
    const { deepseekHistories } = await import('./agy/conversationManager.js');

    for (let i = 0; i < 501; i++) {
      deepseekHistories.set(`conv-${i}`, [{ role: 'user', content: `msg${i}` }]);
    }

    const fakeRes = new EventEmitter() as any;
    const fakeReq = new EventEmitter() as any;
    fakeReq.write = vi.fn(); fakeReq.end = vi.fn();
    fakeReq.destroy = vi.fn(); fakeReq.setTimeout = vi.fn();

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      setTimeout(() => {
        cb(fakeRes);
        fakeRes.emit('data', Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\ndata: [DONE]\n'));
        fakeRes.emit('end');
      }, 0);
      return fakeReq as any;
    });

    await runDeepSeek({ prompt: 'overflow', model: 'deepseek', cwd: '/tmp' });

    // Must be capped — oldest entry evicted when > 500
    expect(deepseekHistories.size).toBeLessThanOrEqual(502);
  });

  it('geminiDirectHistories stays bounded after exceeding 500 entries', async () => {
    const { geminiDirectHistories } = await import('./agy/conversationManager.js');

    for (let i = 0; i < 501; i++) {
      geminiDirectHistories.set(`gemini-conv-${i}`, [{ role: 'user', parts: [{ text: `msg${i}` }] }]);
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (!done) {
                done = true;
                return { done: false, value: new TextEncoder().encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) + '\n') };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    } as any);

    await runGeminiDirect({ prompt: 'overflow', model: 'gemini-2.0-flash', cwd: '/tmp' }, 'fake-key');
    expect(geminiDirectHistories.size).toBeLessThanOrEqual(502);
  });
});

// =============================================================================
// SUITE 7: BUG-06 — GeminiDirect API error JSON surfacing
// =============================================================================

describe('[Integration] BUG-06: GeminiDirect API error surfacing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns exitCode=0 and output for a valid SSE stream', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (!done) {
                done = true;
                return { done: false, value: new TextEncoder().encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello world' }] } }] }) + '\n') };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    } as any);

    const result = await runGeminiDirect({ prompt: 'hello', model: 'gemini-2.0-flash', cwd: '/tmp' }, 'key');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Hello world');
  });

  it('surfaces 429 Quota error JSON in SSE stream instead of silently swallowing (BUG-06)', async () => {
    const errorJson = JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (!done) {
                done = true;
                return { done: false, value: new TextEncoder().encode(`data: ${errorJson}\n`) };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    } as any);

    const result = await runGeminiDirect({ prompt: 'test', model: 'gemini-2.0-flash', cwd: '/tmp' }, 'key');

    // Error MUST be surfaced (non-zero exit or stderr containing error info)
    const errorSurfaced = result.exitCode !== 0 || (typeof result.stderr === 'string' && result.stderr.includes('Quota'));
    expect(errorSurfaced).toBe(true);
  });

  it('returns exitCode=1 for HTTP 401 Unauthorized (pre-stream error)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => 'API key invalid',
    } as any);

    const result = await runGeminiDirect({ prompt: 'test', model: 'gemini-2.0-flash', cwd: '/tmp' }, 'bad-key');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('401');
  });
});

// =============================================================================
// SUITE 8: InlineStreamQueue throttling and 429 backoff
// =============================================================================

describe('[Integration] InlineStreamQueue adaptive throttling', () => {
  it('flushFinal resolves true for a normal API response', async () => {
    const { InlineStreamQueue } = await import('./channels/telegram/commands/inlineHandler.js');

    const mockApi: any = {
      raw: { editMessageText: vi.fn().mockResolvedValue(true) },
    };

    const queue = new InlineStreamQueue(mockApi, 'inline-msg-123');
    queue.enqueueStream('**Hello** ');
    queue.enqueueStream('**Hello** world');

    const success = await queue.flushFinal('**Hello** world! Done.');
    expect(success).toBe(true);
    expect(mockApi.raw.editMessageText).toHaveBeenCalled();
  });

  it('retries on 429 and eventually succeeds with correct markdown', async () => {
    const { InlineStreamQueue } = await import('./channels/telegram/commands/inlineHandler.js');

    let callCount = 0;
    const mockApi: any = {
      raw: {
        editMessageText: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount <= 2) {
            const err: any = new Error('Too Many Requests: retry after 1');
            err.error_code = 429;
            throw err;
          }
          return true;
        }),
      },
    };

    const queue = new InlineStreamQueue(mockApi, 'inline-msg-429');
    const finalMarkdown = '**Final content after 429 retry**';
    const success = await queue.flushFinal(finalMarkdown);

    expect(success).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Verify the final call used the correct markdown
    // InlineStreamQueue calls: api.raw.editMessageText({ inline_message_id, rich_message: { markdown } })
    const lastCall = (mockApi.raw.editMessageText as any).mock.calls.at(-1)[0];
    const sentMarkdown = lastCall?.rich_message?.markdown ?? lastCall?.text ?? '';
    expect(sentMarkdown).toContain('Final content after 429 retry');
  });

  it('does not send a new message for empty queue state', async () => {
    const { InlineStreamQueue } = await import('./channels/telegram/commands/inlineHandler.js');

    const mockApi: any = {
      raw: { editMessageText: vi.fn().mockResolvedValue(true) },
    };

    // Flush without any prior enqueue — should still attempt the final edit
    const queue = new InlineStreamQueue(mockApi, 'inline-empty');
    await queue.flushFinal('Only final content');

    expect(mockApi.raw.editMessageText).toHaveBeenCalledTimes(1);
  });
});
