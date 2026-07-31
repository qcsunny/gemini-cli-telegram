import { extractThoughtAndContent } from '../../agy/agyCli.js';

export function stripWholeMessageCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match code fences wrapping the entire output (allowing any common text/markdown language tag or no tag)
  const fenceMatch = /^```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)\n```$/s.exec(trimmed);
  if (!fenceMatch) return text;
  const lang = (fenceMatch[1] || '').toLowerCase();
  // Allow empty lang tag, or markdown/md/text/plaintext/none
  const allowedLangs = new Set(['', 'markdown', 'md', 'text', 'plaintext', 'none', 'txt']);
  if (lang && !allowedLangs.has(lang)) return text;
  const inner = fenceMatch[2];
  // If the inner content contains nested fences (e.g. real code snippets), don't strip if lang is empty and it might break code
  if (lang === '' && /^```/m.test(inner.trim())) return text;
  return inner.trim();
}

export function normalizeCodeFences(text: string): string {
  let out = text.replace(/([^\n`])```([a-zA-Z0-9_+-]*)/g, '$1\n```$2');
  out = out.replace(/([^\n`])```/g, '$1\n```');
  return out;
}

export function stripSearchResultPayloads(text: string): string {
  return text
    .replace(/```(?:json)?\s*\{[^{}]*"open_url"[^{}]*\}\s*```/g, '')
    .replace(/\{[^{}]*"heading"[^{}]*"subheading"[^{}]*\}/g, '')
    .replace(/\{\s*"actions"\s*:\s*\{[^{}]*"open_url"[^{}]*\}\s*\}/g, '');
}

export function normalizeText(text: string): string {
  const { content } = extractThoughtAndContent(text);
  let clean = content.replace(/\r\n/g, '\n');
  clean = clean.replace(/[*_`#>\-+=()[\]]/g, '');
  return clean.replace(/\s+/g, ' ').trim().toLowerCase();
}
