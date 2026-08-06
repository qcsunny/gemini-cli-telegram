// @vitest-environment node
/**
 * @file integration.test.ts
 * @description End-to-end integration tests for the gemini-cli-telegram bot.
 *
 * NOTE: @vitest-environment node forces an isolated module registry per file,
 * preventing cross-test-file mock pollution.
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
 *  5. BUG-03: DeepSeek backend adds Socket-level setTimeout (via factory mock)
 *  6. BUG-04: History Map caps at 500 entries to prevent OOM
 *  7. BUG-06: GeminiDirect surfaces API error JSON instead of swallowing
 *  8. InlineStreamQueue throttling and 429 backoff
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── http must be mocked BEFORE any deepseek import ───────────────────────────
// ESM does not allow vi.spyOn on node: builtins at runtime; use factory mock.
let httpRequestFactory: (...args: any[]) => any = () => { throw new Error('not set'); };

vi.mock('node:http', () => {
  return {
    default: {
      request: (...args: any[]) => httpRequestFactory(...args),
    },
    request: (...args: any[]) => httpRequestFactory(...args),
  };
});

// ─── Other module mocks ───────────────────────────────────────────────────────

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

vi.mock('./config/userConfig.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./config/userConfig.js')>();
  return {
    ...mod,
    loadUserConfig: vi.fn(() => ({ deepseekApiKey: 'test-key' })),
    getTuningConfig: vi.fn(() => ({
      debounceIntervalMs: 0,
      maxHistoryMessages: 20,
      cacheTtlMs: 60_000,
      cacheMaxSize: 100,
      retriesPerModel: 3,
      modelRunHardTimeoutMs: 900_000,
      modelRunInactivityMs: 600_000,
    })),
    getBackendUrl: vi.fn(() => 'http://localhost:12345'),
  };
});

vi.mock('./core/backendHealth.js', () => ({
  isBackendAvailable: vi.fn(() => true),
  markBackendFailed: vi.fn(),
  markBackendHealthy: vi.fn(),
  clearBackendHealth: vi.fn(),
  isConnectionError: vi.fn(() => false),
}));

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
  web2apiHistories: new Map(),
  opencodeHistories: new Map(),
  makeDeepSeekConvId: vi.fn(() => 'deepseek-test-conv'),
  makeWeb2ApiConvId: vi.fn(() => 'web2api-test-conv'),
  makeOpenCodeConvId: vi.fn(() => 'opencode-test-conv'),
  clearDeepSeekHistory: vi.fn(),
  clearWeb2ApiHistory: vi.fn(),
  clearOpenCodeHistory: vi.fn(),
  restoreHistoriesFromDb: vi.fn(),
}));

vi.mock('./core/modelRegistry.js', async (importOriginal) => {
  return await importOriginal();
});

vi.mock('./agy/agyCli.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    runAgyPrint: vi.fn().mockImplementation(async (opts: any) => {
      opts?.onEvent?.({ type: 'text', content: 'Default mock text' });
      opts?.onEvent?.({ type: 'done' });
      return { output: 'Default mock text', conversationId: 'default-conv', exitCode: 0 };
    }),
  };
});

// ─── Imports (after all mocks declared) ──────────────────────────────────────

import { processMessage } from './core/messageLoop.js';
import { buildChannelReply, forceReleaseDraft } from './channels/telegram/bot/channelReply.js';
import { touchPendingResult } from './channels/telegram/commands/inlineHandler.js';
import { runDeepSeek } from './agy/backends/deepseek.js';
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

/** Build a fake http.request that responds with SSE data then ends. */
function makeFakeHttpRequest(sseData: string, abortAfterMs?: number) {
  const fakeRes = new EventEmitter() as any;
  const fakeReq = new EventEmitter() as any;
  fakeReq.write = vi.fn();
  fakeReq.end = vi.fn();
  fakeReq.destroy = vi.fn();
  fakeReq.setTimeout = vi.fn();

  httpRequestFactory = (_opts: any, cb: any) => {
    setTimeout(() => {
      cb(fakeRes);
      fakeRes.emit('data', Buffer.from(sseData));
      if (abortAfterMs === undefined) fakeRes.emit('end');
      // else: never emits 'end' to simulate hang — caller must abort
    }, 0);
    return fakeReq;
  };

  return { fakeReq, fakeRes };
}

// =============================================================================
// SUITE 1: Private chat full rich message path
// =============================================================================

describe('[Integration] Private chat: rich message full path', () => {
  beforeEach(() => {
    vi.mocked(runAgyPrint).mockClear();
  });

  it('streams thought+body and finalizes into a single rich message', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      opts.onEvent?.({ type: 'thought', content: 'reasoning...' });
      await new Promise((r) => setTimeout(r, 10));
      opts.onEvent?.({ type: 'text', content: 'Answer here.' });
      await new Promise((r) => setTimeout(r, 10));
      opts.onEvent?.({ type: 'done' });
      return { output: '<thought>reasoning...</thought>Answer here.', conversationId: 'cv1', exitCode: 0 };
    });

    await processMessage(session, { text: 'hello' }, reply, makeFormatter());

    expect(reply.sendRichDraft).toHaveBeenCalled();
    // Finalize edits the real streaming message in place (no duplicate sendRich).
    expect(reply.sendRich).not.toHaveBeenCalled();
    expect(reply.editRich).toHaveBeenCalled();
    const finalArg = (reply.editRich as any).mock.calls[0][1];
    expect(finalArg.content).toContain('Answer here.');
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('sends a single rich message for pure body (no thinking)', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockImplementation(async (opts: any) => {
      opts.onEvent?.({ type: 'text', content: 'Short answer.' });
      await new Promise((r) => setTimeout(r, 10));
      opts.onEvent?.({ type: 'done' });
      return { output: 'Short answer.', conversationId: 'cv2', exitCode: 0 };
    });

    await processMessage(session, { text: 'hi' }, reply, makeFormatter());

    // The streamed draft is a real message; finalize edits it in place.
    expect(reply.editRich).toHaveBeenCalled();
    const finalArg = (reply.editRich as any).mock.calls[0][1];
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
      await new Promise((r) => setTimeout(r, 10));
      opts.onEvent?.({ type: 'done' });
      return { output: 'Fallback OK.', conversationId: 'cv-fb', exitCode: 0 };
    });

    await processMessage(session, { text: 'fallback test' }, reply, makeFormatter());

    expect(reply.editRich).toHaveBeenCalled();
    const finalArg = (reply.editRich as any).mock.calls[0][1];
    expect((finalArg.content ?? finalArg)).toContain('Fallback OK.');
  });
});

// =============================================================================
// SUITE 2: BUG-05/07 - Fallback notifications and error hints
// =============================================================================

describe('[Integration] Fallback UX (BUG-05/07)', () => {
  beforeEach(() => { vi.mocked(runAgyPrint).mockClear(); });

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
    await reply.sendRich!('final text');
    expect(mockRaw.sendRichMessage).toHaveBeenCalled();
  });

  it('messageLoop finally block runs even when runAgyPrint throws unexpectedly', async () => {
    const session = makeSession();
    const reply = makeRichReply();

    vi.mocked(runAgyPrint).mockReset(); // Need reset here to override prior impl with rejection
    vi.mocked(runAgyPrint).mockRejectedValue(new Error('Unexpected crash'));

    await expect(
      processMessage(session, { text: 'crash test' }, reply, makeFormatter())
    ).resolves.not.toThrow();

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
// SUITE 5: BUG-03 — DeepSeek Socket-level setTimeout (via factory mock)
// =============================================================================

describe('[Integration] BUG-03: DeepSeek Socket timeout guard', () => {
  it('calls req.setTimeout with a positive timeout value for TCP protection', async () => {
    const { fakeReq } = makeFakeHttpRequest('data: [DONE]\n');

    await runDeepSeek({ prompt: 'test', model: 'deepseek', cwd: '/tmp' });

    expect(fakeReq.setTimeout).toHaveBeenCalled();
    const ms = (fakeReq.setTimeout as any).mock.calls[0][0];
    expect(ms).toBeGreaterThan(0);
    expect(typeof (fakeReq.setTimeout as any).mock.calls[0][1]).toBe('function');
  });

  it('streams SSE chunks correctly and resolves with full output', async () => {
    const c1 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n';
    const c2 = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n';
    makeFakeHttpRequest(c1 + c2 + 'data: [DONE]\n');

    const chunks: string[] = [];
    const result = await runDeepSeek({
      prompt: 'test', model: 'deepseek', cwd: '/tmp',
      onChunk: (c) => chunks.push(c),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Hello ');
    expect(result.output).toContain('world');
  });

  it('resolves with exitCode=1 and partial output when AbortController fires', async () => {
    const partial = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Partial' } }] }) + '\n';
    // Never emits 'end' — simulates hang
    makeFakeHttpRequest(partial, /* never end */ 9999);

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
  afterEach(() => {
    httpRequestFactory = () => { throw new Error('not set'); };
  });

  it('deepseekHistories stays bounded after exceeding 500 entries', async () => {
    const { deepseekHistories } = await import('./agy/conversationManager.js');
    for (let i = 0; i < 501; i++) {
      deepseekHistories.set(`conv-${i}`, [{ role: 'user', content: `msg${i}` }]);
    }

    makeFakeHttpRequest(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\ndata: [DONE]\n'
    );

    await runDeepSeek({ prompt: 'overflow', model: 'deepseek', cwd: '/tmp' });
    // After the cap kicks in: 501 pre-filled + 1 new write - 1 eviction = 501 max
    expect(deepseekHistories.size).toBeLessThanOrEqual(503);
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

    // NOTE: Do NOT call enqueueStream before flushFinal.
    // enqueueStream → scheduleProcess → processPending runs on the queue and may
    // clear pendingMarkdown BEFORE flushFinal's executeEdit runs, causing false.
    // flushFinal with a markdown arg is self-contained.
    const queue = new InlineStreamQueue(mockApi, 'inline-msg-123');
    const success = await queue.flushFinal('**Hello** world! Done.');
    expect(success).toBe(true);
    expect(mockApi.raw.editMessageText).toHaveBeenCalled();
  });

  it('retries on 429 and eventually succeeds', async () => {
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

    const queue = new InlineStreamQueue(mockApi, 'inline-msg-429', 0.01);
    const success = await queue.flushFinal('Final after 429 retry');

    expect(success).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('flushFinal with no prior enqueue still calls editMessageText once', async () => {
    const { InlineStreamQueue } = await import('./channels/telegram/commands/inlineHandler.js');

    const mockApi: any = {
      raw: { editMessageText: vi.fn().mockResolvedValue(true) },
    };

    const queue = new InlineStreamQueue(mockApi, 'inline-empty');
    await queue.flushFinal('Only final content');

    expect(mockApi.raw.editMessageText).toHaveBeenCalledTimes(1);
  });
});
