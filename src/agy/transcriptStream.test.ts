import { describe, expect, it } from 'vitest';
import { parseAgyTranscriptThoughtUpdates, describeAgyStreamEvent, pickNewConversationId } from './transcriptStream.js';

describe('describeAgyStreamEvent', () => {
  it('exposes field names and nested keys so the real contract is visible', () => {
    const shape = describeAgyStreamEvent(JSON.stringify({
      event: 'step_update',
      step_index: 3,
      step_update: { step_type: 'planner', state: 'ACTIVE', text_delta: 'hello' },
    }));
    expect(shape).not.toBeNull();
    expect(shape!.detail).toContain('keys=[event,step_index,step_update]');
    expect(shape!.detail).toContain('step_update.keys=[step_type,state,text_delta]');
    expect(shape!.detail).toContain('step_update.step_type="planner"');
    expect(shape!.detail).toContain('step_update.state="ACTIVE"');
  });

  it('never echoes content fields, only their length', () => {
    const shape = describeAgyStreamEvent(JSON.stringify({
      event: 'step_update',
      step_update: { text_delta: 'secret chat text', thinking: 'private reasoning' },
    }));
    expect(shape!.detail).toContain('step_update.text_delta=str(len=16)');
    expect(shape!.detail).toContain('step_update.thinking=str(len=17)');
    expect(shape!.detail).not.toContain('secret chat text');
    expect(shape!.detail).not.toContain('private reasoning');
  });

  it('shows short identifier values verbatim — that is the point of the dump', () => {
    const shape = describeAgyStreamEvent(JSON.stringify({
      event: 'init',
      conversation_id: '1e2ea425-7d36-4b74-92d6-135bcbbd2e7e',
    }));
    expect(shape!.detail).toContain('conversation_id="1e2ea425-7d36-4b74-92d6-135bcbbd2e7e"');
  });

  it('truncates long non-content strings to a length', () => {
    const shape = describeAgyStreamEvent(JSON.stringify({ event: 'x', blob: 'a'.repeat(200) }));
    expect(shape!.detail).toContain('blob=str(len=200)');
  });

  it('gives the same signature to same-shaped events and a different one otherwise', () => {
    const a = describeAgyStreamEvent(JSON.stringify({
      event: 'step_update', step_update: { step_type: 'planner', state: 'ACTIVE', text_delta: 'aa' },
    }));
    const b = describeAgyStreamEvent(JSON.stringify({
      event: 'step_update', step_update: { step_type: 'planner', state: 'ACTIVE', text_delta: 'bbbbbb' },
    }));
    const c = describeAgyStreamEvent(JSON.stringify({
      event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', text_delta: 'aa' },
    }));
    // Payload length must not affect the fingerprint, or dedupe degenerates to
    // one log line per event.
    expect(a!.signature).toBe(b!.signature);
    expect(a!.signature).not.toBe(c!.signature);
  });

  it('is insensitive to top-level key ordering', () => {
    const a = describeAgyStreamEvent('{"event":"init","conversation_id":"x"}');
    const b = describeAgyStreamEvent('{"conversation_id":"x","event":"init"}');
    expect(a!.signature).toBe(b!.signature);
  });

  it('reports arrays and nulls without expanding them', () => {
    const shape = describeAgyStreamEvent(JSON.stringify({ event: 'x', items: [1, 2, 3], missing: null }));
    expect(shape!.detail).toContain('items=array(3)');
    expect(shape!.detail).toContain('missing=null');
  });

  it('returns null for blank lines and non-object JSON the CLI interleaves', () => {
    expect(describeAgyStreamEvent('')).toBeNull();
    expect(describeAgyStreamEvent('   ')).toBeNull();
    expect(describeAgyStreamEvent('not json at all')).toBeNull();
    expect(describeAgyStreamEvent('[1,2,3]')).toBeNull();
    expect(describeAgyStreamEvent('"a string"')).toBeNull();
    expect(describeAgyStreamEvent('null')).toBeNull();
  });
});

describe('pickNewConversationId', () => {
  it('returns the single conversation created during the run', () => {
    const before = new Set(['a', 'b']);
    expect(pickNewConversationId(before, ['a', 'b', 'c'])).toBe('c');
  });

  it('returns undefined when nothing new appeared yet', () => {
    const before = new Set(['a', 'b']);
    expect(pickNewConversationId(before, ['a', 'b'])).toBeUndefined();
  });

  it('refuses to guess when a concurrent turn also created one', () => {
    // Picking either could stream another chat's reasoning into this one.
    const before = new Set(['a']);
    expect(pickNewConversationId(before, ['a', 'mine', 'theirs'])).toBeUndefined();
  });

  it('ignores conversations that disappeared', () => {
    const before = new Set(['a', 'b']);
    expect(pickNewConversationId(before, ['b', 'c'])).toBe('c');
  });

  it('handles an empty before-snapshot', () => {
    expect(pickNewConversationId(new Set(), ['only'])).toBe('only');
    expect(pickNewConversationId(new Set(), ['x', 'y'])).toBeUndefined();
  });
});

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
