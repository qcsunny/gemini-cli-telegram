/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { formatFooterMarker } from './pricing.js';

describe('Pricing and Token Estimation', () => {
  describe('formatFooterMarker', () => {
    it('should format footer marker string correctly', () => {
      const marker = formatFooterMarker('Claude Sonnet 4.6 (Thinking)', 'hello', 'world');
      expect(marker).toBe('[footer: Claude Sonnet 4.6 (Thinking) (Estimated / 预估) | 2 | 2 | $0.000036]');
    });
  });
});
