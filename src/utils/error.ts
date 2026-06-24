/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Robustly stringifies an unknown error object.
 * Prevents common issues like '[object Object]' when an error is a plain object.
 */
export function formatError(err: unknown): string {
  if (!err) return 'Unknown error';
  
  if (err instanceof Error) {
    return err.message;
  }
  
  if (typeof err === 'object') {
    // Some OAuth/API errors are objects with a 'message' or 'error' field
    const anyErr = err as any;
    if (anyErr.message) return String(anyErr.message);
    if (anyErr.error) return String(anyErr.error);
    
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  
  return String(err);
}
