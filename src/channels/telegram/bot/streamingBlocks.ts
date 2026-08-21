/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file streamingBlocks.ts
 * @description Native-block builders for the streaming (draft / editRich) path.
 * Extracted from channelReply.ts: the details-flattening transform, the
 * phase-aware thinking/body block builders, and the thinking-pill renderer.
 */

import type { RichBlock } from '../richMessage.js';
import type { StructuredMessage } from '../../../core/types.js';
import { markdownToRichBlocks } from '../formatter.js';
import { stripThoughtTags } from '../../../utils/textUtils.js';
import { getTuningConfig } from '../../../config/userConfig.js';
import { getIncrementalParser } from '../formatter/incrementalBlocks.js';

/**
 * Streaming-safe body transform: flattens any collapsible block inside the BODY
 * to its plain-text summary + visible body. The client re-renders the whole
 * message on every edit, which resets the `<details>` open state each time, so
 * a folded block appears "stuck" and can never be opened. Only the summary line
 * (plus a short hint) is streamed; the full folded content is restored at
 * finalize (editRich → buildFinalBlocks). Also strips literal `<details>` tags
 * (markdown mode only understands `**bold**` / `*italic*`).
 */
function collapseDetailsInStreaming(s: string): string {
  let t = s;
  // `<details>` may be unclosed mid-stream: strip the opening tag and turn
  // `<summary>...</summary>` into a bold heading. The following body lines
  // (if any) are kept verbatim so folded content is visible while streaming.
  t = t.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>/gi, (m, summaryHtml) => {
    const summary = summaryHtml.replace(/<[^>]*>/g, '').trim() || 'Details';
    return `**${summary}**\n`;
  });
  // A bare unclosed `<details>` (summary may be emitted later): drop the tag,
  // keep whatever follows.
  t = t.replace(/<details[^>]*>/gi, '\n');
  // Drop every closing tag — body content before it is preserved.
  t = t.replace(/<\/details>/gi, '');
  // A `> [details] summary` blockquote → flatten to bold summary + body lines.
  t = t.replace(/(^|\n)(?:[ \t]*> *)+\[details\]\s*([^\n]*)(?:\n(?:[ \t]*> *)[^\n]*)*/g, (m, lead, summary) => {
    const sTrim = (summary || '').trim();
    if (!sTrim) return `${lead}${m}`;
    // Keep the quoted body (indented lines) but drop the `> [details]` marker
    // and unquote the lines so they render as plain body text.
    const body = m
      .replace(/(^|\n)[ \t]*> *\[details\]\s*[^\n]*/, '')
      .replace(/(^|\n)[ \t]*> */g, '$1')
      .trim();
    return `${lead}**${sTrim}**${body ? `\n${body}` : ''}`;
  });
  // Model-native collapsible prompts: `> 点击展开...` / `> ▶ ...` / a bare
  // `[details]` line followed by a blockquote line. Flatten to bold summary.
  t = t.replace(/(^|\n)(?:[ \t]*> *)*(?:点击展开[.。…]*|Click to expand[.…]*|▶+|▼+|\[details\])[ \t]*([^\n]*)(?:\n(?:[ \t]*> *)[^\n]*)*/g, (m, lead, summary) => {
    const sTrim = (summary || '').trim();
    const body = m
      .replace(/(^|\n)(?:[ \t]*> *)*(?:点击展开[.。…]*|Click to expand[.…]*|▶+|▼+|\[details\])[ \t]*[^\n]*/, '')
      .replace(/(^|\n)[ \t]*> */g, '$1')
      .trim();
    return `${lead}${sTrim ? `**${sTrim}**` : ''}${body ? `\n${body}` : ''}`;
  });
  return t;
}

/**
 * Streaming-safe markdown: strips any literal <thought>/<think> XML so the
 * typewriter render never shows raw tags. Body content renders as markdown;
 * while only thinking, show the actual reasoning text typewriter-style so the
 * user sees the thinking chain grow (not a static placeholder).
 *
 * Phase 1 (thought present, no body): stream the thinking text verbatim under a
 * "🧠 Thinking..." header.
 * Phase 2 (body present): fold the thinking into a collapsed <details> block
 * (summary matches finalize's "🧠 Thinking Process") and stream the body below.
 * Phase 3 (finalize): handled separately by buildFinalBlocks (native blocks).
 *
 * Used by the rich-markdown fallback path; the primary streaming path emits
 * native blocks via `buildPrivateStreamingBlocks` (same semantics).
 */
export function getStreamingMarkdown(text: string | StructuredMessage): string {
  if (typeof text === 'string') {
    const content = collapseDetailsInStreaming(stripThoughtTags(text));
    return content || '🧠 Thinking...';
  }
  const rawThought = stripThoughtTags(text.thought || '');
  const rawContent = stripThoughtTags(text.content || '');
  if (rawThought) {
    if (rawContent) {
      // Phase 2: thinking is done — fold it into a collapsed block (summary
      // matches the finalize details block) and stream the body below it.
      return `<details><summary>🧠 Thinking Process</summary>\n\n${rawThought}\n\n</details>\n\n${collapseDetailsInStreaming(rawContent)}`;
    }
    // Phase 1: typewriter-stream the actual thinking text as it grows.
    return `**🧠 Thinking...**\n\n${rawThought}`;
  }
  const content = collapseDetailsInStreaming(rawContent);
  return content || '🧠 Thinking...';
}

/**
 * Build native 10.2 blocks for a streaming draft update (private chat).
 *
 * Mirrors the phases of `getStreamingMarkdown` so the typewriter UX is
 * identical, but emits native blocks instead of raw markdown:
 *  - Phase 1 (thought, no body): bold "🧠 Thinking..." header + growing thought.
 *  - Phase 2 (thought + body): the thought folds into a native collapsible
 *    `details` block (summary matches finalize's "🧠 Thinking Process") and the
 *    body streams below it; body `<details>` blocks stay flattened (see
 *    collapseDetailsInStreaming).
 *  - Body only: body blocks.  - Empty: plain "🧠 Thinking..." paragraph
 *    (RICH_MESSAGE_EMPTY guard).
 *
 * Uses the lightweight per-frame `markdownToRichBlocks` (<50ms at 21KB) — NOT
 * the heavy finalize pipeline (buildFinalBlocks), whose per-update use caused
 * the visible stutter that previously forced streaming back to markdown.
 */
export function buildPrivateStreamingBlocks(
  text: string | StructuredMessage,
  cacheKey?: string | number,
): RichBlock[] {
  // With a cacheKey the (potentially long) body reuses the frozen stable
  // prefix instead of re-tokenizing the whole text every frame.
  const bodyBlocks = (s: string) => {
    const transformed = collapseDetailsInStreaming(stripThoughtTags(s));
    if (cacheKey === undefined) return markdownToRichBlocks(transformed);
    return getIncrementalParser(`${cacheKey}:body`).feed(transformed);
  };

  if (typeof text === 'string') {
    const blocks = bodyBlocks(text);
    return blocks.length > 0 ? blocks : markdownToRichBlocks('🧠 Thinking...');
  }
  const thought = stripThoughtTags(text.thought || '');
  const content = stripThoughtTags(text.content || '');
  if (thought && content) {
    const thoughtBlocks = markdownToRichBlocks(thought);
    return [
      {
        type: 'details',
        summary: '🧠 Thinking Process',
        blocks: thoughtBlocks.length > 0 ? thoughtBlocks : [{ type: 'paragraph', text: thought }],
      },
      ...bodyBlocks(content),
    ];
  }
  if (thought) {
    return markdownToRichBlocks(`**🧠 Thinking...**\n\n${thought}`);
  }
  if (content) {
    return bodyBlocks(content);
  }
  return markdownToRichBlocks('🧠 Thinking...');
}

/**
 * Max characters of reasoning carried inside the native `thinking` pill. The
 * pill is a status placeholder, not a document block, so a long chain is
 * trimmed to its tail (the newest reasoning); the complete chain is restored at
 * finalize inside the "🧠 Thinking Process" details block.
 */
const THINKING_PILL_MAX_CHARS = 3500;

/**
 * Renders the streamed reasoning into the pill's single `text` field. Inline
 * entities are dropped on purpose: `validateBlocksPayload` accepts only a plain
 * string for `thinking`, and a shimmering status pill has no use for links or
 * bold runs.
 */
function buildThinkingPillText(thought: string): string {
  const flat = thought.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!flat) return '🧠 Thinking...';
  return flat.length <= THINKING_PILL_MAX_CHARS
    ? `🧠 ${flat}`
    : `🧠 …${flat.slice(flat.length - THINKING_PILL_MAX_CHARS)}`;
}

/**
 * Draft-mode variant of buildPrivateStreamingBlocks. During the thinking phase
 * (thought growing, body not yet started) the reasoning is streamed INSIDE the
 * native `thinking` block — the official pill animation, valid only inside
 * sendRichMessageDraft — so the reasoning text itself gets the pill treatment
 * instead of only the "🧠 Thinking..." label, which is all the pill used to
 * carry (the reasoning was emitted as plain paragraphs beside it). The pill is
 * also the very first frame, before any thought arrives, so the whole thinking
 * phase is one block whose text grows: no per-frame block-type churn for the
 * client to re-render. Once the body starts, phase 2/3 render exactly like the
 * real-message path (shared via buildPrivateStreamingBlocks), dropping the pill
 * — `thinking` is rejected outside drafts.
 *
 * `opts.pillOnly === false` (from `tuning.richDraftThinkingInPill: false`, or
 * latched by the caller when Telegram rejects a pill-only payload) restores the
 * previous split layout: a label-only pill with the reasoning as plain
 * paragraphs below it, for clients that render the pill collapsed and hide its
 * text.
 */
export function buildDraftStreamingBlocks(
  text: string | StructuredMessage,
  opts?: { pillOnly?: boolean; cacheKey?: string | number },
): RichBlock[] {
  const thought = typeof text === 'string' ? '' : stripThoughtTags(text.thought || '');
  const content = typeof text === 'string' ? '' : stripThoughtTags(text.content || '');
  const pillOnly = opts?.pillOnly ?? (getTuningConfig().richDraftThinkingInPill !== false);
  const cacheKey = opts?.cacheKey;

  // Thinking phase: stream the reasoning inside the native pill.
  if (thought && !content) {
    if (!pillOnly) {
      return [
        { type: 'thinking', text: '🧠 Thinking...' },
        ...markdownToRichBlocks(thought),
      ];
    }
    return [{ type: 'thinking', text: buildThinkingPillText(thought) }];
  }

  // Waiting for the first thought/text event: the pill is the native placeholder
  // for exactly this state, so start it here and let its text grow.
  if (pillOnly && !thought && !content && typeof text !== 'string') {
    return [{ type: 'thinking', text: '🧠 Thinking...' }];
  }

  // Body phase or final: drop the pill, use shared builder
  return buildPrivateStreamingBlocks(text, cacheKey);
}

/** True when `blocks` is a single native pill (the payload shape Telegram may reject). */
export function isPillOnlyPayload(blocks: RichBlock[]): boolean {
  return blocks.length === 1 && blocks[0]?.type === 'thinking';
}

