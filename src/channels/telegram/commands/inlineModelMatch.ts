/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineModelMatch.ts
 * @description Inline-query prompt parsing and model fuzzy matching
 * (extracted from inlineHandler.ts): task prefixes (/translate /sum /img ...),
 * project switches (/p2), @model-family tags, and token-substring model search.
 */

import type { ProjectInfo } from '../../../core/types.js';
import { getDefaultModel, getDefaultModels } from '../../../config/userConfig.js';

export type InlineTask = 'translate' | 'summarize' | 'image' | 'compare' | 'read';
export const TASK_PREFIX_MAP: Record<string, InlineTask> = {
  '/translate': 'translate',
  '/summarize': 'summarize',
  '/sum': 'summarize',
  '/img': 'image',
  '/v': 'compare',
  '/read': 'read',
  '/summary': 'read',
};

export const IMAGE_TASK_INSTRUCTION =
  'Use the generate_image tool to generate images for the topic below (can generate multiple images of different styles/compositions at once). Only call the tool to generate images, do not describe the images with text:\n\n';

/** Max photos a <tg-collage> / album can contain. */
export const MAX_COLLAGE_IMAGES = 10;

export const MAX_MODEL_SUGGESTIONS = 5;

/** Fallback model suggestions shown when no model keyword matched. */
export function getFallbackModelSuggestions(): string[] {
  const suggestions = [
    getDefaultModel(),
    ...(getDefaultModels()?.inlineSuggestions ?? []),
  ].filter((m): m is string => Boolean(m));
  const seen = new Set<string>();
  return suggestions.filter(m => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  }).slice(0, MAX_MODEL_SUGGESTIONS);
}

/**
 * Build an `InputRichMessage` for inline placeholder cards directly from native
 * `blocks` (RichBlock[]), instead of relying on the server-side markdown→blocks
 * parsing of `rich_message.markdown`. Some Telegram clients render
 * `rich_message.markdown` in `input_message_content` as plain/HTML text, so
 * sending pre-built blocks guarantees the placeholder renders as a true
 * RichMessage on first send.
 * Falls back to markdown only when the parser yields no blocks.
 */
export const CHANNEL_PREFIX_RE = /^(Web2API|DeepSeek|OpenCode)\s*:\s*/i;

/** Strips the channel prefix so "Web2API: Gemini 3.1 Pro" matches "gemini 3.1 pro". */
export function normalizeModelName(name: string): string {
  return name.replace(CHANNEL_PREFIX_RE, '').toLowerCase();
}

/**
 * Fuzzy-matches a query against available model names.
 * Each query token that appears as a substring of a normalized model name scores +1.
 * Returns up to `limit` models sorted by descending score.
 */
export function fuzzyMatchModels(query: string, models: string[], limit: number = MAX_MODEL_SUGGESTIONS): string[] {
  const tokens = query
    .toLowerCase()
    .replace(CHANNEL_PREFIX_RE, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const scored = models
    .map((model) => {
      const norm = normalizeModelName(model);
      const score = tokens.reduce((acc, tok) => acc + (norm.includes(tok) ? 1 : 0), 0);
      return { model, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

  return scored.slice(0, limit).map((x) => x.model);
}

export const TASK_INSTRUCTION: Record<InlineTask, string> = {
  translate: 'Translate the following content between Chinese and English (or to the target language if one is specified), preserving the original meaning and formatting:\n\n',
  summarize: 'Summarize the following content concisely and list the key points. Reply in the same language as the user\'s message:\n\n',
  read: 'Please read, analyze and extract key takeaways from the following content concisely:\n\n',
  image: IMAGE_TASK_INSTRUCTION,
  compare: '',
};

export function parseInlineModelAndPrompt(
  rawQuery: string,
  defaultModel: string,
  availableProjects: ProjectInfo[] = [],
): {
  model: string;
  prompt: string;
  family?: string;
  families: string[];
  projectUsed?: ProjectInfo;
  task?: InlineTask;
} {
  let text = rawQuery.trim();
  let selectedModel = defaultModel;
  const families: string[] = [];
  let projectUsed: ProjectInfo | undefined;
  let task: InlineTask | undefined;

  const parts = text.split(/\s+/);
  while (parts.length > 0 && (parts[0].startsWith('/') || parts[0].startsWith('@'))) {
    const token = parts[0];

    // Task prefixes take precedence over project switches so a literal
    // task flag is never swallowed by the /p project matcher below.
    const alias = token.toLowerCase();
    if (TASK_PREFIX_MAP[alias]) {
      task = TASK_PREFIX_MAP[alias];
      parts.shift();
      continue;
    }

    // Project switch: /p2 or /p:2 (index or name fragment).
    const projMatch = token.match(/^\/p:?(\d+|[^\s]+)/i);
    if (projMatch) {
      const target = projMatch[1];
      const num = parseInt(target, 10);
      if (!isNaN(num) && num >= 1 && num <= availableProjects.length) {
        projectUsed = availableProjects[num - 1];
      } else {
        projectUsed = availableProjects.find((p) => p.name.toLowerCase().includes(target.toLowerCase()));
      }
      parts.shift();
      continue;
    }

    // Model family search: any @keyword fuzzy-matches model names.
    if (token.startsWith('@')) {
      const tag = token.slice(1).toLowerCase();
      if (tag) families.push(tag);
      parts.shift();
      continue;
    }

    break;
  }
  text = parts.join(' ').trim();

  if (task) {
    const instr = TASK_INSTRUCTION[task];
    text = text ? `${instr}${text}` : instr.trim();
  }

  return {
    model: selectedModel,
    prompt: text,
    family: families.length > 0 ? families[families.length - 1] : undefined,
    families,
    projectUsed,
    task,
  };
}
