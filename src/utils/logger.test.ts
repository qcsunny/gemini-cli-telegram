/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  let writeSpy: any;

  beforeEach(async () => {
    vi.resetModules();
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('should log info messages by default', async () => {
    const { logger } = await import('./logger.js');
    logger.info('test info');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('test info'));
  });

  it('should log error messages by default', async () => {
    const { logger } = await import('./logger.js');
    logger.error('test error');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('test error'));
  });

  it('should NOT log debug messages by default', async () => {
    const { logger } = await import('./logger.js');
    logger.debug('test debug');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('should respect LOG_LEVEL=debug', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const { logger } = await import('./logger.js');
    logger.debug('test debug');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('test debug'));
    vi.unstubAllEnvs();
  });
});
