/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

describe('logger', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { ERROR_LOG_PATH } = await import('./logger.js');
    if (fs.existsSync(ERROR_LOG_PATH)) {
      try {
        fs.unlinkSync(ERROR_LOG_PATH);
      } catch {
        // ignore cleanup error
      }
    }
  });

  it('should export logger, pinoInstance and ERROR_LOG_PATH', async () => {
    const { logger, pinoInstance, ERROR_LOG_PATH } = await import('./logger.js');
    expect(logger).toBeDefined();
    expect(pinoInstance).toBeDefined();
    expect(ERROR_LOG_PATH).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should delegate info/error calls to pinoInstance', async () => {
    const { logger, pinoInstance } = await import('./logger.js');
    const infoSpy = vi.spyOn(pinoInstance, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(pinoInstance, 'error').mockImplementation(() => {});

    logger.info('test info message', { key: 'val' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('test info message {"key":"val"}'));

    logger.error('test error message', new Error('boom'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test error message'));

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should write error logs to error.log file', async () => {
    const { logger, ERROR_LOG_PATH } = await import('./logger.js');

    if (fs.existsSync(ERROR_LOG_PATH)) {
      fs.unlinkSync(ERROR_LOG_PATH);
    }

    logger.error('unit test error writing to log', new Error('test failure details'));

    expect(fs.existsSync(ERROR_LOG_PATH)).toBe(true);
    const content = fs.readFileSync(ERROR_LOG_PATH, 'utf-8');
    expect(content).toContain('unit test error writing to log');
    expect(content).toContain('test failure details');
  });

  it('should NOT log debug messages when LOG_LEVEL is default info', async () => {
    const { logger, pinoInstance } = await import('./logger.js');
    const debugSpy = vi.spyOn(pinoInstance, 'debug').mockImplementation(() => {});

    logger.debug('test debug message');
    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it('should respect LOG_LEVEL=debug', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const { logger, pinoInstance } = await import('./logger.js');
    const debugSpy = vi.spyOn(pinoInstance, 'debug').mockImplementation(() => {});

    logger.debug('test debug message');
    expect(debugSpy).toHaveBeenCalledWith('test debug message');

    debugSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
