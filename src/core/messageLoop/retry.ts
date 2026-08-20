/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file retry.ts
 * @description Error classification, exponential backoff, and retry/downgrade evaluation for messageLoop.
 */

import { isConnectionError } from '../backendHealth.js';

/**
 * Error code mapping for better error detection and user-friendly messages.
 */
const ERROR_CODE_MAP: Record<string, {
  type: string;
  message: string;
  suggestion: string;
}> = {
  // Rate Limit
  '429': { type: 'rate_limit', message: 'Rate limit exceeded (throttled)', suggestion: 'Wait 1-2 minutes and retry, or switch models' },
  'quota': { type: 'rate_limit', message: 'Quota exhausted', suggestion: 'Quota used up, wait for recovery or downgrade model' },
  'exhausted': { type: 'rate_limit', message: 'Resources exhausted', suggestion: 'Please retry later' },
  'rate_limit': { type: 'rate_limit', message: 'Rate limit exceeded', suggestion: 'Lower call frequency or downgrade model' },
  'rate_limit_exceeded': { type: 'rate_limit', message: 'Rate limit exceeded', suggestion: 'Lower call frequency or downgrade model' },

  // Connection
  'ECONNREFUSED': { type: 'connection', message: 'Connection refused', suggestion: 'Backend not started, check service status' },
  'ECONNRESET': { type: 'connection', message: 'Connection reset', suggestion: 'Unstable network, please retry later' },
  'ENETUNREACH': { type: 'connection', message: 'Network unreachable', suggestion: 'Check network connection' },
  'ETIMEDOUT': { type: 'connection', message: 'Connection timed out', suggestion: 'Increase timeout or check network' },
  'socket hang up': { type: 'connection', message: 'Connection hung up', suggestion: 'Unstable network, please retry later' },
  'connection refused': { type: 'connection', message: 'Connection refused', suggestion: 'Check backend service status' },

  // Authentication
  '401': { type: 'auth', message: 'Authentication failed (invalid token)', suggestion: 'Check the token in the config file' },
  '403': { type: 'auth', message: 'Access forbidden (no permission)', suggestion: 'Check if the bot token is correct' },
  'invalid token': { type: 'auth', message: 'Invalid token', suggestion: 'Reconfigure the bot token' },
  'unauthorized': { type: 'auth', message: 'Unauthorized (401)', suggestion: 'Check if the bot token is correct' },
  'authentication failed': { type: 'auth', message: 'Authentication failed', suggestion: 'Check if the bot token is correct' },

  // Timeout
  'timeout': { type: 'timeout', message: 'Request timed out', suggestion: 'Increase timeout or check network' },
  'client timeout': { type: 'timeout', message: 'Client timed out', suggestion: 'Increase timeout' },
  'upstream timeout': { type: 'timeout', message: 'Upstream timed out', suggestion: 'Increase timeout' },

  // Backend Unavailable
  'backend_unavailable': { type: 'backend', message: 'Backend unavailable', suggestion: 'Backend under maintenance, please retry later' },

  // Unknown
  'unknown': { type: 'unknown', message: 'Unknown error', suggestion: 'Please retry later or downgrade model' },
};

/**
 * Error severity levels
 */
const ERROR_SEVERITY: Record<string, 'critical' | 'warning' | 'info'> = {
  // Critical - immediate attention needed
  'ECONNREFUSED': 'critical',
  '401': 'critical',
  '403': 'critical',
  'invalid_token': 'critical',

  // Warning - can retry
  '429': 'warning',
  'quota': 'warning',
  'ETIMEDOUT': 'warning',
  'ECONNRESET': 'warning',

  // Info - normal errors
  'backend_unavailable': 'info',
  'unknown': 'info',
};

/**
 * Extract error channel from error message.
 */
export function extractErrorChannel(reason: string): string | undefined {
  const lowerReason = reason.toLowerCase();
  if (lowerReason.includes('agy')) return 'agy (local)';
  if (lowerReason.includes('deepseek')) return 'deepseek-api (proxy)';
  if (lowerReason.includes('web2api')) return 'web2api (proxy)';
  if (lowerReason.includes('opencode')) return 'opencode (local)';
  return undefined;
}

/**
 * Parse error message and extract key information.
 */
export function parseErrorMessage(reason: string): {
  type: string;
  code: string;
  channel: string | undefined;
  message: string;
  suggestion: string;
} {
  const text = reason.trim();
  const lowerText = text.toLowerCase();

  // Find error type
  let errorType = 'unknown';
  let errorCode = '';

  // Check for specific error codes
  for (const [code, info] of Object.entries(ERROR_CODE_MAP)) {
    const lowerCode = code.toLowerCase();
    if (lowerText.includes(lowerCode) || lowerText.includes(info.type)) {
      errorType = info.type;
      errorCode = code;
      break;
    }
  }

  // Extract error code from message
  if (!errorCode && lowerText.match(/ \d{3} /)) {
    const match = lowerText.match(/ (\d{3}) /);
    if (match) {
      errorCode = match[1];
      errorType = 'unknown';
    }
  }

  // Extract channel
  const channel = extractErrorChannel(reason);

  // Build suggestion
  const suggestion = ERROR_CODE_MAP[errorCode]?.suggestion ||
    (ERROR_SEVERITY[errorCode] === 'critical'
      ? 'Please retry later or downgrade the model'
      : 'Please retry later');

  return {
    type: errorType,
    code: errorCode,
    channel,
    message: text,
    suggestion,
  };
}

/**
 * Calculate exponential backoff duration for rate-limit retries.
 */
export function calculateRateLimitBackoffMs(failsForModel: number): number {
  return Math.min(1000 * Math.pow(2, failsForModel), 30000);
}

interface RetryEvaluation {
  reason: string;
  isRateLimited: boolean;
  isPermanent: boolean;
  isConnection: boolean;
  backoffMs: number;
}

/**
 * Evaluates whether an execution failure (exitCode !== 0 or thrown error) is rate-limited,
 * connection-related, permanent, and what backoff delay to apply.
 */
export function evaluateRetryState(
  errorOrStderr: unknown,
  failsForModel: number,
  retriesPerModel: number,
): RetryEvaluation {
  const rawMsg = errorOrStderr instanceof Error ? errorOrStderr.message : String(errorOrStderr || '');
  const lowerMsg = rawMsg.toLowerCase();
  const parsed = parseErrorMessage(rawMsg || 'Unknown error');
  const isRateLimited = parsed.type === 'rate_limit';
  const isEof = lowerMsg.includes('eof') || lowerMsg.includes('streamgeneratecontent') || lowerMsg.includes('daily-cloudcode-pa');
  const isConn = isConnectionError(errorOrStderr) ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('connection refused') ||
    lowerMsg.includes('socket hang up') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('enetunreach') ||
    lowerMsg.includes('etimedout');
  const isPermanent = isConn || isEof || parsed.type === 'auth' || parsed.type === 'critical';
  const reason = isEof ? 'Google cloud API connection dropped (EOF network fluctuation)' : parsed.message;

  const backoffMs = isRateLimited && failsForModel < retriesPerModel
    ? calculateRateLimitBackoffMs(failsForModel)
    : 0;

  return {
    reason,
    isRateLimited,
    isPermanent,
    isConnection: isConn,
    backoffMs,
  };
}
