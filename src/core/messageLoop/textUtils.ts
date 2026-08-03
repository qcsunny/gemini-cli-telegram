import { extractThoughtAndContent } from '../../agy/agyCli.js';

export function stripWholeMessageCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match a leading fence wrapping the body. The whole fragment need not be
  // JUST the fence — models often append a brief remark after the closing
  // fence, which would otherwise leave the entire body framed as a code block.
  const opening = /^```([a-zA-Z0-9_+-]*)\s*\n/.exec(trimmed);
  if (!opening) return text;
  const lang = (opening[1] || '').toLowerCase();
  // Allow empty lang tag, or markdown/md/text/plaintext/none
  const allowedLangs = new Set(['', 'markdown', 'md', 'text', 'plaintext', 'none', 'txt']);
  if (lang && !allowedLangs.has(lang)) return text;
  const rest = trimmed.slice(opening[0].length);
  // Find the FIRST fence-close line (a line that is only backticks). Inner
  // nested fences cast as code can't be the closer because a proper closing
  // fence must be flush (no info string). Use the earliest one to keep the
  // tail that follows the outer fence (e.g. a human remark after the block).
  const closeMatch = /^```[ \t]*$/m.exec(rest);
  if (!closeMatch) return text;
  const inner = rest.slice(0, closeMatch.index).trim();
  // If the inner content contains nested fences (e.g. real code snippets),
  // don't strip when lang is empty and it might break code.
  if (lang === '' && /^```/m.test(inner)) return text;
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
