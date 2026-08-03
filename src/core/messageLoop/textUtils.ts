import { extractThoughtAndContent } from '../../agy/agyCli.js';

export function stripWholeMessageCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match a leading fence wrapping the body. Models sometimes emit MORE than
  // three backticks (e.g. ````markdown````) — accept any run of 3+ backticks
  // as the fence delimiter. Also tolerate a brief remark appended after the
  // closing fence instead of requiring the fragment to be exactly the fence.
  const opening = /^(`{3,})([a-zA-Z0-9_+-]*)\s*\n/.exec(trimmed);
  if (!opening) return text;
  const fenceTicks = opening[1];
  const lang = (opening[2] || '').toLowerCase();
  // Allow empty lang tag, or markdown/md/text/plaintext/none
  const allowedLangs = new Set(['', 'markdown', 'md', 'text', 'plaintext', 'none', 'txt']);
  if (lang && !allowedLangs.has(lang)) return text;
  const rest = trimmed.slice(opening[0].length);
  // Find the FIRST fence-close line. Prefer a run as long as the opener's
  // (spec-compliant); if the model closed with fewer backticks than it opened
  // with (common quirk: ````markdown … ```), fall back to any flush line of
  // >=3 backticks. The earliest match keeps the tail after the outer fence.
  let closeMatch = new RegExp('^' + fenceTicks + '[ \\t]*$', 'm').exec(rest);
  if (!closeMatch) {
    closeMatch = /^`{3,}[ \t]*$/m.exec(rest);
  }
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
