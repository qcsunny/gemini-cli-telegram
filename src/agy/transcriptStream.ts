/**
 * @file transcriptStream.ts
 * @description Diagnostics and polling helpers for agy's stream-json stdout and
 * transcript logs: event-shape discovery, new-conversation detection, and
 * extracting completed planner thinking from transcript_full.jsonl.
 */

interface AgyTranscriptThoughtUpdate {
  stepIndex: number;
  content: string;
}

/** Narrow an unknown value to a plain record (never arrays). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** One distinct event *shape* observed on agy's stream-json stdout. */
interface AgyStreamEventShape {
  /**
   * Structural fingerprint, stable across events of the same kind. Used to log
   * each shape once per run instead of once per event (a single turn emits
   * hundreds of `text_delta` events).
   */
  signature: string;
  /** Field-by-field description, with content values reduced to lengths. */
  detail: string;
}

/** Fields carrying model/user content: report length only, never the value. */
const CONTENT_FIELDS = new Set([
  'text_delta', 'thinking', 'response', 'content', 'text', 'output', 'prompt', 'query',
]);

/** Strings longer than this are treated as payloads rather than identifiers. */
const MAX_VALUE_CHARS = 80;

/** How many object levels to expand before reporting keys only. */
const MAX_DEPTH = 2;

function summarize(label: string, value: unknown, depth: number, out: string[]): void {
  if (value === null || value === undefined) {
    out.push(`${label}=null`);
    return;
  }
  if (Array.isArray(value)) {
    out.push(`${label}=array(${value.length})`);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    out.push(`${label}.keys=[${Object.keys(obj).join(',')}]`);
    if (depth < MAX_DEPTH) {
      for (const [k, v] of Object.entries(obj)) summarize(`${label}.${k}`, v, depth + 1, out);
    }
    return;
  }
  if (typeof value === 'string') {
    const leaf = label.slice(label.lastIndexOf('.') + 1);
    // Content is never echoed: it would leak chat text into the log and bloat it.
    if (CONTENT_FIELDS.has(leaf) || value.length > MAX_VALUE_CHARS) {
      out.push(`${label}=str(len=${value.length})`);
    } else {
      out.push(`${label}=${JSON.stringify(value)}`);
    }
    return;
  }
  out.push(`${label}=${String(value)}`);
}

/**
 * Describe the shape of one agy stream-json line for diagnostics.
 *
 * agy's event contract is undocumented; the code relies on
 * `event === 'init'` carrying `conversation_id` (consumed by agyCli for
 * mid-run conversation discovery) and `step_update.step_type === 'tool'`
 * for tool-activity notes.
 * This makes the real structure visible without dumping chat content.
 *
 * @returns `null` for blank lines and non-object JSON (the CLI interleaves
 * plain diagnostic text with the JSON stream).
 */
export function describeAgyStreamEvent(raw: string): AgyStreamEventShape | null {
  const line = raw.trim();
  if (!line) return null;
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    event = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const parts: string[] = [`keys=[${Object.keys(event).join(',')}]`];
  for (const [k, v] of Object.entries(event)) summarize(k, v, 1, parts);

  const stepUpdate = event['step_update'];
  const step = stepUpdate && typeof stepUpdate === 'object' && !Array.isArray(stepUpdate)
    ? (stepUpdate as Record<string, unknown>)
    : undefined;
  const signature = [
    `event=${String(event['event'] ?? '-')}`,
    `keys=${Object.keys(event).sort().join(',')}`,
    step ? `step.keys=${Object.keys(step).sort().join(',')}` : 'step=-',
    `step_type=${String(step?.['step_type'] ?? '-')}`,
    `state=${String(step?.['state'] ?? '-')}`,
  ].join('|');

  return { signature, detail: parts.join(' ') };
}

/**
 * Pick the conversation id created by the current run, comparing a snapshot
 * taken before spawning against one taken now.
 *
 * Deliberately refuses to guess when several ids appeared: a concurrent turn in
 * another chat creates its own conversation, and picking the wrong one would
 * stream that chat's reasoning into this one. Callers that run *after* the
 * process exited can afford a heuristic (e.g. newest mtime); callers polling
 * mid-run cannot, because there is no way to undo content already shown.
 *
 * @returns the single new id, or `undefined` when there is none or it is ambiguous.
 */
export function pickNewConversationId(before: ReadonlySet<string>, after: Iterable<string>): string | undefined {
  const added: string[] = [];
  for (const id of after) {
    if (!before.has(id)) added.push(id);
  }
  return added.length === 1 ? added[0] : undefined;
}

/**
 * Extract completed planner-reasoning updates from a transcript file's raw
 * JSONL. Skips already-processed steps, non-DONE statuses, and entries that
 * predate the current run; tolerates a partially written trailing line.
 */
export function parseAgyTranscriptThoughtUpdates(
  raw: string,
  processedSteps: Set<number>,
  startedAt: number,
): AgyTranscriptThoughtUpdate[] {
  const updates: AgyTranscriptThoughtUpdate[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    const stepIndex = Number(event['step_index']);
    if (!Number.isFinite(stepIndex) || processedSteps.has(stepIndex)) continue;
    if (event['status'] !== 'DONE') continue;

    const createdAt = typeof event['created_at'] === 'string'
      ? Date.parse(event['created_at'])
      : NaN;
    if (Number.isFinite(createdAt) && createdAt < startedAt - 2_000) {
      processedSteps.add(stepIndex);
      continue;
    }

    processedSteps.add(stepIndex);
    if (event['type'] === 'PLANNER_RESPONSE' && typeof event['thinking'] === 'string' && event['thinking']) {
      updates.push({ stepIndex, content: event['thinking'] });
    }
  }
  return updates;
}
