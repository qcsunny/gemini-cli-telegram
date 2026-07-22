/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file index.ts
 * @description Barrel re-export for the formatter module.
 * Re-exports everything from core, html, blocks, and media sub-modules
 * so existing `import { ... } from './formatter.js'` statements continue working.
 */

export * from './core.js';
export * from './html.js';
export * from './blocks.js';
export * from './media.js';
