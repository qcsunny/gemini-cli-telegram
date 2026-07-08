/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processMessage } from './messageLoop.js';
import { extractThoughtAndContent } from '../agy/agyCli.js';
import type { MultimodalInput } from './types.js';

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

  it('should automatically fallback to a lower model when rate limit (429) is hit', async () => {
    mockSession.model = 'Gemini 3.1 Pro (High)';
    const input: MultimodalInput = { text: 'hello fallback' };

    let callCount = 0;
    vi.mocked(runAgyPrint).mockImplementation(async (options) => {
      callCount++;
      if (callCount === 1) {
        return {
          output: '',
          stderr: 'Error: Resource exhausted (429) - Quota limit reached.',
          conversationId: 'test-conv-id',
          exitCode: 1,
        };
      } else {
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

    // Should have called runAgyPrint twice
    expect(runAgyPrint).toHaveBeenCalledTimes(2);

    // First call uses original model
    expect(runAgyPrint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: 'Gemini 3.1 Pro (High)',
      })
    );

    // Second call uses fallback model
    expect(runAgyPrint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'Gemini 3.5 Flash (High)',
      })
    );

    // Warning should have been sent to channel
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

  it('should send separate messages for thought and formal reply', async () => {
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

    await processMessage(mockSession, input, mockReply, mockFormatter);

    // During stream or final render, separate message targets should be sent
    expect(mockReply.sendPlain).toHaveBeenCalledWith(expect.stringContaining('Let me think'));
    expect(mockReply.sendPlain).toHaveBeenCalledWith(expect.stringContaining('Haha!'));
  });

  it('should split messages when split delimiters like ---split--- or ---spilt--- are present', async () => {
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

    // It should edit the streaming message with the first part
    expect(mockReply.edit).toHaveBeenCalledWith(456, '___RAW_HTML___Intro part');

    // And send subsequent parts as separate messages (with footer markers)
    expect(mockReply.send).toHaveBeenCalledWith(expect.stringContaining('___RAW_HTML___Main content part'));
  });

  it('should combine thought and stats into a single message at the end', async () => {
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

    // First message should be the final reply text (bodyHtmlChunks[0])
    expect(mockReply.edit).toHaveBeenCalledWith(456, expect.stringContaining('final reply text'));

    // Second message should contain both thinking process AND footer (since they are combined)
    expect(mockReply.send).toHaveBeenCalledWith(expect.stringContaining('thinking process'));
    expect(mockReply.send).toHaveBeenCalledWith(expect.stringContaining('🤖 运行模型'));
  });
});
