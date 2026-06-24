/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processMessage } from './messageLoop.js';
import type { MultimodalInput } from './types.js';

// Mock agyCli module
vi.mock('../agy/agyCli.js', () => ({
  runAgyPrint: vi.fn(),
}));

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
      // Simulate onChunk callback being triggered
      if (options.onChunk) {
        options.onChunk('Hi ');
        options.onChunk('there!');
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
    expect(mockReply.sendPlain).toHaveBeenCalledWith('Hi ');

    // After completion (final rendering)
    expect(mockReply.edit).toHaveBeenCalledWith(456, 'Hi there!');
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
        if (options.onChunk) {
          options.onChunk('Hi fallback!');
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
});
