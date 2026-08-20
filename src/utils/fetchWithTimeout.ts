/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file fetchWithTimeout.ts
 * @description fetch wrapper with a hard abort timeout, so callers don't repeat
 * the AbortController + setTimeout + clearTimeout boilerplate at every call site.
 */

import { fetch as undiciFetch, type RequestInit, type Response } from 'undici';

/**
 * Fetch `url` and abort if the response headers haven't arrived within
 * `timeoutMs`. Returns the raw Response — the caller still parses the body.
 *
 * NOTE: any `init.signal` is overridden by the timeout controller; this helper
 * is intended for requests whose only cancellation trigger is the timeout.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await undiciFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
