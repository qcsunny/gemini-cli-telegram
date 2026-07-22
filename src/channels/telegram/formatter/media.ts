/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file media.ts
 * @description Media collection state for RichBlocks path.
 * Collects media attachments (photos, videos, audio) discovered during
 * markdown-to-RichBlocks conversion.
 */

// --- Media collection (RichBlocks path) ------------------------------------
// Collects media attachments (photos, videos, audio) discovered during
// markdown-to-RichBlocks conversion. Media URLs are assigned unique IDs
// and referenced via tg://photo?id=... (etc.) in the output blocks.
export let mediaStore: { id: string; url: string; type: 'photo' | 'video' | 'audio' | 'animation' | 'voice_note' }[] = [];
let _mediaIdCounter = 0;

/** Return current counter value and increment (post-increment semantics). */
export function nextMediaId(): string {
  const id = `media_${_mediaIdCounter}`;
  _mediaIdCounter++;
  return id;
}

export function resetMediaStore(): void {
  mediaStore = [];
  _mediaIdCounter = 0;
}
