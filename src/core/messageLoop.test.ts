/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processMessage } from './messageLoop.js';
import { extractThoughtAndContent } from '../agy/agyCli.js';
import type { MultimodalInput, ChannelReply } from './types.js';

// Mock agyCli module
vi.mock('../agy/agyCli.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    runAgyPrint: vi.fn(),
    getModelCapabilities: vi.fn((model) => {
      const isGemini = model && (model.toLowerCase().includes('gemini') || model === 'test-model-rich');
      return {
        supportsThinkingSummary: !!isGemini,
      };
    }),
  };
});

// Mock conversationStore module
vi.mock('../agy/conversationStore.js', () => ({
  setConversation: vi.fn(),
}));

import { runAgyPrint } from '../agy/agyCli.js';
import { setConversation } from '../agy/conversationStore.js';

describe('processMessage', () => {
  let mockSession: any;
  let mockReply: any;
  let mockFormatter: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockSession = {
      sessionId: '123456',
      conversationId: 'test-conv-id',
      model: 'test-model',
      currentProject: {
        path: '/test/project/path',
      },
      abortController: new AbortController(),
      turnCount: 0,
      busy: false,
    };

    mockReply = {
      send: vi.fn().mockResolvedValue(123),
      edit: vi.fn(),
      sendPlain: vi.fn().mockResolvedValue(456),
      editPlain: vi.fn(),
      delete: vi.fn(),
    };

    mockFormatter = {
      chunkText: vi.fn((text) => [text]),
      truncateForEdit: vi.fn((text) => text),
      truncateForStream: vi.fn((text) => text),
      findSafeCutPoint: vi.fn((text: string, maxLen: number) => Math.min(text.length, maxLen)),
    };
  });

  it('should process text-only input and stream response', async () => {
    const input: MultimodalInput = { text: 'hello' };

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      // Simulate onEvent callback being triggered
      if (options.onEvent) {
        options.onEvent({ type: 'text', content: 'Hi ' });
        options.onEvent({ type: 'text', content: 'there!' });
        options.onEvent({ type: 'done' });
      }
      return {
        output: 'Hi there!',
        conversationId: 'updated-conv-id',
        exitCode: 0,
      };
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    expect(runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello',
        cwd: '/test/project/path',
        conversationId: 'test-conv-id',
        model: 'test-model',
      })
    );

    // During streaming
    expect(mockReply.sendPlain).toHaveBeenCalledWith('Hi there!');

    // After completion (final rendering)
    expect(mockReply.edit).toHaveBeenCalledWith(456, expect.stringContaining('Hi there!'));
    expect(mockSession.conversationId).toBe('updated-conv-id');
    expect(setConversation).toHaveBeenCalledWith(123456, 'updated-conv-id', '/test/project/path', 'test-model');
  });

  it('should retry the same model 3x then downgrade to a lower model when rate limit (429) is hit', async () => {
    mockSession.model = 'Gemini 3.1 Pro (High)';
    const input: MultimodalInput = { text: 'hello fallback' };

    let callCount = 0;
    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      callCount++;
      if (callCount <= 3) {
        // First 3 attempts on the ORIGINAL model fail (rate limit); the
        // retry policy retries the same model up to 3 times before downgrading.
        return {
          output: '',
          stderr: 'Error: Resource exhausted (429) - Quota limit reached.',
          conversationId: 'test-conv-id',
          exitCode: 1,
        };
      } else {
        // 4th call is on the fallback model and succeeds.
        if (options.onEvent) {
          options.onEvent({ type: 'text', content: 'Hi fallback!' });
          options.onEvent({ type: 'done' });
        }
        return {
          output: 'Hi fallback!',
          conversationId: 'fallback-conv-id',
          exitCode: 0,
        };
      }
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    // 3 failed attempts on the original model + 1 success on the fallback = 4 calls.
    expect(runAgyPrint).toHaveBeenCalledTimes(4);

    // First three calls use the original model.
    expect(runAgyPrint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'Gemini 3.1 Pro (High)' })
    );
    expect(runAgyPrint).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ model: 'Gemini 3.1 Pro (High)' })
    );

    // Fourth call uses the fallback model.
    expect(runAgyPrint).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ model: 'Gemini 3.5 Flash (High)' })
    );

    // Warning should have been sent to channel (original + fallback models).
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.stringContaining('Gemini 3.1 Pro (High)')
    );
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.stringContaining('Gemini 3.5 Flash (High)')
    );

    // Session model must have updated
    expect(mockSession.model).toBe('Gemini 3.5 Flash (High)');
    expect(mockSession.conversationId).toBe('fallback-conv-id');

    // Conversation should be saved to database with fallback model
    expect(setConversation).toHaveBeenCalledWith(
      123456,
      'fallback-conv-id',
      '/test/project/path',
      'Gemini 3.5 Flash (High)'
    );
  });

  it('should walk exactly one full loop and terminate when the last model also fails (no second pass)', async () => {
    // Chain from Web2API: Gemini Flash Lite is exactly 2 long:
    //   [Web2API: Gemini Flash Lite, Web2API: Gemini Auto]
    // Each model is retried 3x, then downgraded. When the LAST model
    // (Web2API: Gemini Auto) also fails its 3 retries, the session must
    // terminate — it must NOT wrap back to the first model for a 2nd pass.
    mockSession.model = 'Web2API: Gemini Flash Lite';
    const input: MultimodalInput = { text: 'hello full loop' };

    vi.mocked(runAgyPrint).mockResolvedValue({
      output: '',
      stderr: 'Error: Resource exhausted (429) - Quota limit reached.',
      conversationId: 'test-conv-id',
      exitCode: 1,
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    // chain.length (2) * RETRIES_PER_MODEL (3) = 6 total attempts, one loop.
    expect(runAgyPrint).toHaveBeenCalledTimes(6);
    // First 3 attempts: original model.
    expect(runAgyPrint).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'Web2API: Gemini Flash Lite' }));
    expect(runAgyPrint).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: 'Web2API: Gemini Flash Lite' }));
    // Next 3 attempts: downgraded last model.
    expect(runAgyPrint).toHaveBeenNthCalledWith(4, expect.objectContaining({ model: 'Web2API: Gemini Auto' }));
    expect(runAgyPrint).toHaveBeenNthCalledWith(6, expect.objectContaining({ model: 'Web2API: Gemini Auto' }));
    // NO 7th call: the loop did NOT wrap back to the first model.
    // Session model is unchanged (it never succeeded).
    expect(mockSession.model).toBe('Web2API: Gemini Flash Lite');
    // An error/termination message must have been surfaced to the channel.
    expect(mockReply.send).toHaveBeenCalled();
  });

  it('should format multimodal input into the prompt', async () => {
    const input: MultimodalInput = {
      text: 'Describe this image',
      media: [{ type: 'photo', path: '/local/test.jpg', mimeType: 'image/jpeg', fileName: 'test.jpg' }],
    };

    vi.mocked(runAgyPrint).mockResolvedValue({
      output: 'It is a beautiful landscape.',
      conversationId: 'updated-conv-id',
      exitCode: 0,
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    const expectedPrompt = '[本地关联文件 - 类型: photo, 物理路径: "/local/test.jpg", 原始文件名: "test.jpg"]\n\nDescribe this image';
    expect(runAgyPrint).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expectedPrompt,
      })
    );
  });

  describe('extractThoughtAndContent', () => {
    it('should extract closed thought blocks', () => {
      const input = '<thought>thinking hard</thought>Actual answer';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: 'thinking hard',
        content: 'Actual answer',
      });
    });

    it('should extract unclosed thought blocks at start', () => {
      const input = '<thought>still thinking...';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: 'still thinking...',
        content: '',
      });
    });

    it('should handle text with no thought block', () => {
      const input = 'Just normal text';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: '',
        content: 'Just normal text',
      });
    });

    it('should ignore thought tags in code blocks', () => {
      const input = '<thought>real thought</thought>Here is code:\n```xml\n<thought>code example</thought>\n```';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: 'real thought',
        content: 'Here is code:\n```xml\n<thought>code example</thought>\n```',
      });
    });

    it('should ignore thought tags in inline code', () => {
      const input = 'Here is inline code: `<thought>nested</thought>` outside tag <thought>real thought</thought>';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: 'real thought',
        content: 'Here is inline code: `<thought>nested</thought>` outside tag ',
      });
    });

    it('should ignore unclosed thought tags after content', () => {
      const input = 'Pre-text <thought> unclosed';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: '',
        content: 'Pre-text <thought> unclosed',
      });
    });

    it('should ignore partial match words like thoughtful', () => {
      const input = '<thoughtful>something';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: '',
        content: '<thoughtful>something',
      });
    });

    it('should not corrupt Chinese characters at the beginning of thoughts', () => {
      const input = '<thought>我a</thought>';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: '我a',
        content: '',
      });
    });

    it('should not lock parser with unclosed inline backtick on a line', () => {
      const input = '`\n<thought>subsequent thought</thought>Some text';
      const result = extractThoughtAndContent(input);
      expect(result).toEqual({
        thought: 'subsequent thought',
        content: '`\nSome text',
      });
    });
  });

  it('should combine thought and body into a single append-only message', async () => {
    const input: MultimodalInput = { text: 'tell me a joke' };

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      if (options.onEvent) {
        options.onEvent({ type: 'thought', content: 'Let me think' });
        options.onEvent({ type: 'text', content: 'Haha!' });
        options.onEvent({ type: 'done' });
      }
      return {
        output: '<thought>Let me think</thought>Haha!',
        conversationId: 'conv-1',
        exitCode: 0,
      };
    });

    // Plain fallback path: thought + body rendered into one final message.
    await processMessage(mockSession, input, mockReply, mockFormatter);

    // Only one message is created (sendPlain called once for draft creation)
    expect(mockReply.sendPlain).toHaveBeenCalledTimes(1);
    // Final render must contain BOTH thought and body in a single message.
    expect(mockReply.edit).toHaveBeenCalledWith(
      456,
      expect.stringContaining('Let me think'),
    );
    expect(mockReply.edit).toHaveBeenCalledWith(
      456,
      expect.stringContaining('Haha!'),
    );
  });

  it('should NOT drop the trailing paragraph when the stream ends without a trailing newline (rich path)', async () => {
    const input: MultimodalInput = { text: 'test' };

    // Build a 3-paragraph answer whose FINAL paragraph has NO trailing newline.
    const full =
      '第一段内容。\n\n第二段内容。\n\n第三段（末尾没有换行，易被吞掉）';

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      if (options.onEvent) {
        options.onEvent({ type: 'text', content: full.slice(0, 18) });
        options.onEvent({ type: 'text', content: full.slice(18, 30) });
        options.onEvent({ type: 'text', content: full.slice(30) }); // ends mid-last-paragraph, no \n
        options.onEvent({ type: 'done' });
      }
      return { output: full, conversationId: 'conv-rich', exitCode: 0 };
    });

    // Rich path requires the rich primitives on the reply object.
    const richReply = {
      ...mockReply,
      sendRichDraftBlocks: vi.fn().mockResolvedValue(789),
      editRichBlocks: vi.fn().mockResolvedValue(789),
      sendRich: vi.fn().mockResolvedValue(790),
    };

    await processMessage(mockSession, input, richReply, mockFormatter);

    expect(richReply.sendRichDraftBlocks).toHaveBeenCalled();
    expect(richReply.editRichBlocks).toHaveBeenCalled();
    const finalBlocks = richReply.editRichBlocks.mock.calls[0][1] as any[];
    const flatten = (bs: any[]): string =>
      bs
        .map((b) => (Array.isArray(b.text) ? b.text.join('') : b.text || ''))
        .join('');
    const rendered = flatten(finalBlocks);
    expect(rendered).toContain('第一段内容。');
    expect(rendered).toContain('第二段内容。');
    // The regression: the trailing paragraph must NOT be silently dropped.
    expect(rendered).toContain('第三段（末尾没有换行，易被吞掉）');
  });

  it('should NOT split on ---split--- delimiters (single message only)', async () => {
    const input: MultimodalInput = { text: 'split test' };

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      if (options.onEvent) {
        options.onEvent({ type: 'text', content: 'Intro part\n---split---\nMain content part' });
        options.onEvent({ type: 'done' });
      }
      return {
        output: 'Intro part\n---split---\nMain content part',
        conversationId: 'conv-split',
        exitCode: 0,
      };
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    // Body stays in ONE message; nothing is sent as a separate message.
    expect(mockReply.send).not.toHaveBeenCalled();
    expect(mockReply.edit).toHaveBeenCalledWith(
      456,
      expect.stringContaining('Main content part'),
    );
  });

  it('should fold thought and stats into a single message (no separate footer message)', async () => {
    const input: MultimodalInput = { text: 'test combination' };

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      if (options.onEvent) {
        options.onEvent({ type: 'thought', content: 'thinking process' });
        options.onEvent({ type: 'text', content: 'final reply text' });
        options.onEvent({ type: 'done' });
      }
      return {
        output: '<thought>thinking process</thought>final reply text',
        conversationId: 'conv-combine',
        exitCode: 0,
      };
    });

    await processMessage(mockSession, input, mockReply, mockFormatter);

    // Everything lands in ONE message (456) — no separate footer send.
    expect(mockReply.send).not.toHaveBeenCalled();
    expect(mockReply.edit).toHaveBeenCalledWith(
      456,
      expect.stringContaining('thinking process'),
    );
    expect(mockReply.edit).toHaveBeenCalledWith(
      456,
      expect.stringContaining('final reply text'),
    );
  });

  it('Rich mode: thinking process is rendered into the trailing details block of a single message', async () => {
    // User preference: keep the thinking folded into the end (a native `details`
    // block), in the SAME message as the body — never a separate message.
    const input: MultimodalInput = { text: 'footer thinking test' };

    const capturedBlocks: any[] = [];
    const richReply: ChannelReply = {
      send: vi.fn().mockResolvedValue(700),
      edit: vi.fn(),
      sendPlain: vi.fn().mockResolvedValue(456),
      editPlain: vi.fn(),
      delete: vi.fn(),
      sendDocument: vi.fn(),
      sendRich: vi.fn().mockResolvedValue(701),
      sendRichDraft: vi.fn().mockResolvedValue(702),
      editRich: vi.fn(),
      editRichDraft: vi.fn(),
      sendRichDraftBlocks: vi.fn(async (_draftId: number, blocks: unknown[]) => {
        capturedBlocks.length = 0;
        capturedBlocks.push(...(blocks as any[]));
        return 702;
      }),
      editRichBlocks: vi.fn(async (_id: number, blocks: unknown[]) => {
        capturedBlocks.length = 0;
        capturedBlocks.push(...(blocks as any[]));
        return 702;
      }),
    };
    const richFormatter = {
      ...mockFormatter,
      chunkText: vi.fn((text: string) => [text]),
      truncateForStream: vi.fn((text: string) => text),
    };

    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      if (options.onEvent) {
        options.onEvent({ type: 'thought', content: 'the model reasons step by step' });
        options.onEvent({ type: 'text', content: 'final answer' });
        options.onEvent({ type: 'done' });
      }
      return {
        output: '<thought>the model reasons step by step</thought>final answer',
        conversationId: 'conv-footer-thinking',
        exitCode: 0,
      };
    });

    await processMessage(mockSession, input, richReply, richFormatter);

    // Exactly ONE message worth of blocks, with fixed order: [details(thinking), ...body, footer?].
    expect(capturedBlocks.length).toBeGreaterThan(0);
    // The thinking block (details) carries the real thought text.
    const thinking = capturedBlocks.find(
      (b) => b?.type === 'details' && String(b?.blocks?.[0]?.text ?? '').includes('the model reasons step by step'),
    );
    expect(thinking).toBeDefined();
    // The body block carries the real answer.
    const bodyText = JSON.stringify(capturedBlocks);
    expect(bodyText).toContain('final answer');
    // No second message was sent.
    expect(richReply.send).not.toHaveBeenCalled();
  });
});
