import { describe, expect, it } from 'vitest';
import { parseAgyTranscriptThoughtUpdates } from './transcriptStream.js';

describe('parseAgyTranscriptThoughtUpdates', () => {
  it('emits completed planner thinking once and ignores other steps', () => {
    const startedAt = Date.parse('2026-08-16T00:00:00Z');
    const processed = new Set<number>();
    const raw = [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-16T00:00:00Z', thinking: 'reasoning' }),
      JSON.stringify({ step_index: 2, type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-08-16T00:00:01Z', content: 'output' }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'ACTIVE', created_at: '2026-08-16T00:00:01Z', thinking: 'partial' }),
    ].join('\n');

    expect(parseAgyTranscriptThoughtUpdates(raw, processed, startedAt)).toEqual([
      { stepIndex: 1, content: 'reasoning' },
    ]);
    expect(parseAgyTranscriptThoughtUpdates(raw, processed, startedAt)).toEqual([]);
  });

  it('does not replay old thinking from a resumed conversation', () => {
    const processed = new Set<number>();
    const raw = [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-15T23:00:00Z', thinking: 'old' }),
      JSON.stringify({ step_index: 8, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-16T00:00:01Z', thinking: 'new' }),
    ].join('\n');

    expect(parseAgyTranscriptThoughtUpdates(raw, processed, Date.parse('2026-08-16T00:00:00Z'))).toEqual([
      { stepIndex: 8, content: 'new' },
    ]);
  });

  it('tolerates a partially written trailing JSON line', () => {
    const raw = `${JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'ready' })}\n{"step_index":5`;
    expect(parseAgyTranscriptThoughtUpdates(raw, new Set(), Date.now())).toEqual([
      { stepIndex: 4, content: 'ready' },
    ]);
  });
});
