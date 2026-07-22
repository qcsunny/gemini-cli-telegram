/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file formatter.ts
 * @description Barrel re-export for the formatter module.
 * The actual implementation has been split into formatter/core.ts, html.ts,
 * blocks.ts, and media.ts. This file maintains backward compatibility for
 * existing `import { ... } from './formatter.js'` statements.
 */

export * from './formatter/index.js';
