/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getSequentialKey } from './bot.js';

describe('getSequentialKey', () => {
  it('should return undefined if callbackQuery is present', () => {
    const ctx = {
      callbackQuery: { id: 'query_id', data: 'btn_click' },
      chat: { id: 123 },
    };
    expect(getSequentialKey(ctx)).toBeUndefined();
  });

  it('should return control key for /cancel commands', () => {
    const ctx = {
      chat: { id: 123 },
      message: { text: '/cancel' },
    };
    expect(getSequentialKey(ctx)).toBe('control:123');
  });

  it('should return chat key for normal messages', () => {
    const ctx = {
      chat: { id: 123 },
      message: { text: 'hello bot' },
    };
    expect(getSequentialKey(ctx)).toBe('chat:123');
  });

  it('should return undefined if chat.id is missing', () => {
    const ctx = {
      message: { text: 'hello' },
    };
    expect(getSequentialKey(ctx)).toBeUndefined();
  });
});
