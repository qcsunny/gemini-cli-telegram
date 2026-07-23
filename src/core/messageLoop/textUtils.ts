import { extractThoughtAndContent } from '../../agy/agyCli.js';

export function stripWholeMessageCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/.exec(trimmed);
  if (!fenceMatch) return text;
  const lang = (fenceMatch[1] || '').toLowerCase();
  if (lang && lang !== 'markdown' && lang !== 'md') return text;
  const inner = fenceMatch[2];
  if (/^```/m.test(inner.trim())) return text;
  return inner;
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
