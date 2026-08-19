import { describe, it, expect } from 'vitest';
import {
  stripTimestampPrefix,
  stripControlCharacters,
  sanitizeToolResultContent,
  formatToolCall,
  buildTurnTranscript,
  TOOL_RESULT_LABELS,
} from './transcript.js';

const TURN = new Date('2026-08-15T01:38:10+08:00').getTime();

describe('stripTimestampPrefix', () => {
  it('strips the Created At / Completed At header', () => {
    const content = 'Created At: 2026-08-15T01:38:17+08:00\nCompleted At: 2026-08-15T01:38:26+08:00\nThe search for "x" returned:\nbody';
    expect(stripTimestampPrefix(content)).toBe('The search for "x" returned:\nbody');
  });

  it('keeps content unchanged when no header is present', () => {
    const content = 'The command exited with code 0.\nOutput:\nfoo';
    expect(stripTimestampPrefix(content)).toBe(content);
  });
});

describe('stripControlCharacters', () => {
  it('strips ANSI escape and other Telegram-forbidden control chars', () => {
    const input = 'ok\x1b[31mred\x07bell\u200Bzwsp\uFEFFbom';
    expect(stripControlCharacters(input)).toBe('okredbellzwspbom');
  });

  it('keeps \\n \\r \\t', () => {
    expect(stripControlCharacters('a\nb\rc\td')).toBe('a\nb\rc\td');
  });
});

describe('sanitizeToolResultContent', () => {
  it('neutralizes blockquote markers and HTML tags so the details block stays flat', () => {
    const content = '> quoted line\n<details><summary>x</summary></details>\nplain\n> > nested';
    expect(sanitizeToolResultContent(content)).toBe('&gt; quoted line\n&lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;&lt;/details&gt;\nplain\n&gt; &gt; nested');
  });

  it('strips control characters while escaping', () => {
    expect(sanitizeToolResultContent('a\x1b[0mb')).toBe('ab');
  });
});

describe('formatToolCall', () => {
  it('formats a search_web call', () => {
    const tc = {
      name: 'search_web',
      args: {
        query: '"Nature SARS-CoV-2 latent virus reactivation EBV Long COVID"',
        toolAction: '"Searching scientific papers"',
        toolSummary: '"Search Nature studies"',
      },
    };
    expect(formatToolCall(tc)).toBe('- `search_web` — Searching scientific papers：`Nature SARS-CoV-2 latent virus reactivation EBV Long COVID`');
  });

  it('formats a run_command call', () => {
    const tc = { name: 'run_command', args: { CommandLine: 'node dist/bin/json.js ORCL' } };
    expect(formatToolCall(tc)).toBe('- `run_command`：`node dist/bin/json.js ORCL`');
  });

  it('surfaces agy PascalCase target arguments', () => {
    expect(formatToolCall({ name: 'view_file', args: { AbsolutePath: '/tmp/a.jpg', toolAction: 'Viewing image' } }))
      .toBe('- `view_file` — Viewing image：`/tmp/a.jpg`');
    expect(formatToolCall({ name: 'grep_search', args: { Query: 'runAgyPrint', SearchPath: '/src' } }))
      .toBe('- `grep_search`：`runAgyPrint`');
    expect(formatToolCall({ name: 'list_dir', args: { DirectoryPath: '/src/agy' } }))
      .toBe('- `list_dir`：`/src/agy`');
    expect(formatToolCall({ name: 'read_url_content', args: { Url: 'https://example.com' } }))
      .toBe('- `read_url_content`：`https://example.com`');
    expect(formatToolCall({ name: 'write_to_file', args: { TargetFile: '/src/a.ts' } }))
      .toBe('- `write_to_file`：`/src/a.ts`');
  });

  it('flattens multi-line details and neutralizes backticks so inline code stays intact', () => {
    expect(formatToolCall({ name: 'run_command', args: { CommandLine: 'echo `date`\n  && ls' } }))
      .toBe("- `run_command`：`echo 'date' && ls`");
  });

  it('returns null for malformed calls', () => {
    expect(formatToolCall(null)).toBeNull();
    expect(formatToolCall({})).toBeNull();
  });
});

describe('buildTurnTranscript', () => {
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      step_index: 1,
      created_at: '2026-08-15T01:38:13+08:00',
      thinking: '**Examining the Article**\n\nfirst thought',
      tool_calls: [
        { name: 'search_web', args: { query: '"Nature EBV Long COVID"', toolAction: '"Searching scientific papers"' } },
      ],
    }),
    JSON.stringify({
      type: 'SEARCH_WEB',
      status: 'DONE',
      step_index: 2,
      created_at: '2026-08-15T01:38:17+08:00',
      content:
        'Created At: 2026-08-15T01:38:17+08:00\nCompleted At: 2026-08-15T01:38:26+08:00\nThe search for "Nature EBV Long COVID" returned the following summary:\nResearch published in *Nature* indicates a connection[1][2].',
    }),
    JSON.stringify({ type: 'VIEW_FILE', status: 'DONE', step_index: 3, created_at: '2026-08-15T01:38:22+08:00', content: 'File Path: `file:///tmp/a.ts`' }),
    JSON.stringify({ type: 'GREP_SEARCH', status: 'DONE', step_index: 4, created_at: '2026-08-15T01:38:23+08:00', content: '{"File":"/src/a.ts","LineNumber":1}' }),
    JSON.stringify({ type: 'LIST_DIRECTORY', status: 'DONE', step_index: 5, created_at: '2026-08-15T01:38:24+08:00', content: '{"name":"a.ts"}' }),
    JSON.stringify({
      type: 'RUN_COMMAND',
      status: 'RUNNING',
      step_index: 6,
      created_at: '2026-08-15T01:38:25+08:00',
      content: 'Created At: 2026-08-15T01:38:25+08:00\nTool is running as a background task with task id: t-1',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      step_index: 7,
      created_at: '2026-08-15T01:38:26+08:00',
      thinking: '**Reviewing Rule Set**\n\nsecond thought',
      content: 'the answer body',
    }),
    // Pre-turn noise plus prompt-side context that must never leak into the thought
    JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', step_index: 8, created_at: '2026-08-15T01:37:00+08:00', thinking: 'stale pre-turn thought' }),
    JSON.stringify({ type: 'SEARCH_WEB', status: 'DONE', step_index: 9, created_at: '2026-08-15T01:37:00+08:00', content: 'stale pre-turn result' }),
    JSON.stringify({ type: 'EPHEMERAL_MESSAGE', status: 'DONE', step_index: 10, created_at: '2026-08-15T01:38:27+08:00', content: 'CRITICAL INSTRUCTION 1: reminder noise' }),
    JSON.stringify({ type: 'CHECKPOINT', status: 'DONE', step_index: 11, created_at: '2026-08-15T01:38:27+08:00', content: '{{ CHECKPOINT 0 }} truncated context' }),
    JSON.stringify({ type: 'USER_INPUT', status: 'DONE', step_index: 12, created_at: '2026-08-15T01:38:11+08:00', content: 'the user prompt' }),
  ];

  it('emits every non-body output of the turn in step order', () => {
    const { markdown, hasThinking } = buildTurnTranscript(lines, TURN);
    expect(hasThinking).toBe(true);

    const order = [
      'first thought',
      '**🔧 工具调用**',
      '- `search_web` — Searching scientific papers：`Nature EBV Long COVID`',
      TOOL_RESULT_LABELS.SEARCH_WEB,
      TOOL_RESULT_LABELS.VIEW_FILE,
      TOOL_RESULT_LABELS.GREP_SEARCH,
      TOOL_RESULT_LABELS.LIST_DIRECTORY,
      TOOL_RESULT_LABELS.RUN_COMMAND,
      'second thought',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = markdown.indexOf(needle);
      expect(at, `missing or out of order: ${needle}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(markdown).toContain('Research published in *Nature* indicates a connection[1][2].');
    expect(markdown).not.toContain('Created At:');
  });

  it('keeps the status of a tool that has not finished yet', () => {
    const { markdown } = buildTurnTranscript(lines, TURN);
    expect(markdown).toContain(`**${TOOL_RESULT_LABELS.RUN_COMMAND} · RUNNING**`);
    expect(markdown).toContain(`**${TOOL_RESULT_LABELS.SEARCH_WEB}**`);
  });

  it('excludes pre-turn entries and prompt-side context injections', () => {
    const { markdown } = buildTurnTranscript(lines, TURN);
    expect(markdown).not.toContain('stale pre-turn thought');
    expect(markdown).not.toContain('stale pre-turn result');
    expect(markdown).not.toContain('reminder noise');
    expect(markdown).not.toContain('CHECKPOINT');
    expect(markdown).not.toContain('the user prompt');
    // The answer body itself stays out of the thought block
    expect(markdown).not.toContain('the answer body');
  });

  it('keeps a re-emitted planner step (deliberately no dedup)', () => {
    const repeated = [lines[0], lines[0], lines[6]];
    const { markdown } = buildTurnTranscript(repeated, TURN);
    // agy's re-emitted copy is usually the more complete one, so the step is
    // kept twice rather than collapsed — MAX_TRANSCRIPT_CHARS bounds the cost.
    expect(markdown.match(/first thought/g)).toHaveLength(2);
    expect(markdown.match(/工具调用/g)).toHaveLength(2);
  });

  it('reorders physically misordered lines into step order', () => {
    // Physical line order is not authoritative (~23% of files misorder steps,
    // e.g. the final answer can land last). Feed a scrambled order and require
    // the assembly to follow step_index instead.
    const scrambled = [lines[6], lines[2], lines[0], lines[3], lines[4], lines[5], lines[1]];
    const { markdown } = buildTurnTranscript(scrambled, TURN);
    const order = [
      'first thought',
      '**🔧 工具调用**',
      '- `search_web` — Searching scientific papers：`Nature EBV Long COVID`',
      TOOL_RESULT_LABELS.SEARCH_WEB,
      TOOL_RESULT_LABELS.VIEW_FILE,
      TOOL_RESULT_LABELS.GREP_SEARCH,
      TOOL_RESULT_LABELS.LIST_DIRECTORY,
      TOOL_RESULT_LABELS.RUN_COMMAND,
      'second thought',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = markdown.indexOf(needle);
      expect(at, `missing or out of order: ${needle}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('keeps a single oversized tool result in full', () => {
    const huge = [
      JSON.stringify({ type: 'RUN_COMMAND', status: 'DONE', step_index: 1, created_at: '2026-08-15T01:38:20+08:00', content: 'x'.repeat(5000) }),
    ];
    const { markdown, hasThinking } = buildTurnTranscript(huge, TURN);
    expect(hasThinking).toBe(false);
    // No truncation anywhere: the full 5000-char body survives verbatim.
    expect(markdown).toContain('x'.repeat(5000));
    expect(markdown).not.toContain('已截断');
    expect(markdown.length).toBeGreaterThan(5000);
  });

  it('keeps reasoning AND every tool log even when their combined size is huge', () => {
    // Reasoning before and after a long tool chain must all survive in full —
    // the Thinking Process block is never truncated, whatever the total size.
    const bigTool = (i: number) =>
      JSON.stringify({
        type: 'RUN_COMMAND',
        status: 'DONE',
        step_index: i,
        created_at: `2026-08-15T01:38:2${i}+08:00`,
        content: 'y'.repeat(1500),
      });
    const lines = [
      JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', step_index: 1, created_at: '2026-08-15T01:38:20+08:00', thinking: '**First** opening reasoning' }),
      ...Array.from({ length: 7 }, (_, i) => bigTool(2 + i)),
      JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', step_index: 10, created_at: '2026-08-15T01:38:28+08:00', thinking: '**Final Conclusion** closing reasoning' }),
    ];
    const { markdown, hasThinking } = buildTurnTranscript(lines, TURN);
    expect(hasThinking).toBe(true);
    expect(markdown).toContain('opening reasoning');
    expect(markdown).toContain('closing reasoning');
    expect(markdown.match(/⚙️ 执行命令/g)).toHaveLength(7);
    expect(markdown.match(/y{1500}/g)).toHaveLength(7);
    expect(markdown).not.toContain('已截断');
  });

  it('returns empty when the turn produced nothing outside the body', () => {
    const bodyOnly = [
      JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', step_index: 1, created_at: '2026-08-15T01:38:13+08:00', content: 'answer only' }),
      JSON.stringify({ type: 'SEARCH_WEB', status: 'DONE', step_index: 2, created_at: '2026-08-15T01:37:00+08:00', content: 'stale pre-turn result' }),
    ];
    const { markdown, hasThinking } = buildTurnTranscript(bodyOnly, TURN);
    expect(markdown).toBe('');
    expect(hasThinking).toBe(false);
  });
});

import { stripWholeMessageCodeFence, normalizeCodeFences } from './textUtils.js';
import { parseAgyTranscriptThoughtUpdates, describeAgyStreamEvent, pickNewConversationId } from '../../agy/transcriptStream.js';

describe('stripWholeMessageCodeFence', () => {
  it('strips a whole-message fence with a language tag', () => {
    const input = '```markdown\nhello world\n```';
    expect(stripWholeMessageCodeFence(input)).toBe('hello world');
  });

  it('strips a whole-message fence with no language tag', () => {
    const input = '```\nplain body\n```';
    expect(stripWholeMessageCodeFence(input)).toBe('plain body');
  });

  it('keeps the inner body when the model appends a remark after the closing fence', () => {
    const input =
      '```markdown\n这是一个顶尖学者的思考。\n```\n以上就是对这位学者的分析。';
    expect(stripWholeMessageCodeFence(input)).toBe('这是一个顶尖学者的思考。');
  });

  it('does not strip a fence in the middle of text', () => {
    const input = 'Here is:\n```js\ncode\n```\nend';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('does not strip when inner content has nested fences', () => {
    const input = '```\n```json\n{"a":1}\n```\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('does not strip non-markdown language tags (real code block)', () => {
    const input = '```js\nconsole.log(1)\n```';
    expect(stripWholeMessageCodeFence(input)).toBe(input);
  });

  it('strips a whole-message fence with four backticks (model quirk)', () => {
    const input = '````markdown\n# 人机协同的深度演进\n\n图片展示了论文。\n````';
    expect(stripWholeMessageCodeFence(input)).toBe(
      '# 人机协同的深度演进\n\n图片展示了论文。'
    );
  });

  it('strips a four-backtick fence even with a remark appended after close', () => {
    const input =
      '````markdown\n# 标题\n\n正文内容。\n````\n以上是我对该论文的解读';
    expect(stripWholeMessageCodeFence(input)).toBe('# 标题\n\n正文内容。');
  });

  it('strips a four-backtick opening fence closed with three backticks (model quirk)', () => {
    const input = '````markdown\n# 标题\n\n正文内容。\n```';
    expect(stripWholeMessageCodeFence(input)).toBe('# 标题\n\n正文内容。');
  });
});

describe('normalizeCodeFences', () => {
  it('no-ops on clean text', () => {
    expect(normalizeCodeFences('plain text')).toBe('plain text');
  });
});

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
