import { describe, it, expect } from 'vitest';
import {
  stripTimestampPrefix,
  stripControlCharacters,
  sanitizeToolResultContent,
  formatToolCall,
  collectTurnThinking,
  buildToolChainSection,
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
    expect(stripControlCharacters(input)).toBe('ok[31mredbellzwspbom');
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
    expect(sanitizeToolResultContent('a\x1b[0mb')).toBe('a[0mb');
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

  it('returns null for malformed calls', () => {
    expect(formatToolCall(null)).toBeNull();
    expect(formatToolCall({})).toBeNull();
  });
});

describe('collectTurnThinking', () => {
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T01:38:13+08:00',
      thinking: '**Examining the Article**\n\nfirst thought',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T01:38:26+08:00',
      thinking: '**Reviewing Rule Set**\n\nsecond thought',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T01:37:00+08:00',
      thinking: 'stale pre-turn thought',
    }),
    JSON.stringify({ type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-15T01:38:11+08:00', content: 'x' }),
  ];

  it('merges this-turn planner thinking chronologically and skips pre-turn entries', () => {
    const merged = collectTurnThinking(lines, TURN);
    expect(merged).toBe('**Examining the Article**\n\nfirst thought\n\n**Reviewing Rule Set**\n\nsecond thought');
    expect(merged).not.toContain('stale pre-turn thought');
  });

  it('returns empty when nothing is in this turn', () => {
    expect(collectTurnThinking(lines, new Date('2026-08-15T02:00:00+08:00').getTime())).toBe('');
  });
});

describe('buildToolChainSection', () => {
  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T01:38:13+08:00',
      thinking: 't',
      tool_calls: [
        {
          name: 'search_web',
          args: { query: '"Nature EBV Long COVID"', toolAction: '"Searching scientific papers"' },
        },
      ],
    }),
    JSON.stringify({
      type: 'SEARCH_WEB',
      status: 'DONE',
      created_at: '2026-08-15T01:38:17+08:00',
      content:
        'Created At: 2026-08-15T01:38:17+08:00\nCompleted At: 2026-08-15T01:38:26+08:00\nThe search for "Nature EBV Long COVID" returned the following summary:\nResearch published in *Nature* indicates a connection[1][2].',
    }),
    JSON.stringify({
      type: 'RUN_COMMAND',
      status: 'DONE',
      created_at: '2026-08-15T01:38:20+08:00',
      content: 'Created At: 2026-08-15T01:38:20+08:00\nCompleted At: 2026-08-15T01:38:21+08:00\n\n\t\t\t\tThe command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\tok',
    }),
    JSON.stringify({
      type: 'SEARCH_WEB',
      status: 'DONE',
      created_at: '2026-08-15T01:37:00+08:00',
      content: 'stale pre-turn result',
    }),
    JSON.stringify({ type: 'VIEW_FILE', status: 'DONE', created_at: '2026-08-15T01:38:22+08:00', content: 'File Path: `file:///tmp/a.ts`' }),
  ];

  it('emits tool calls and result sections, skipping pre-turn and unlisted types', () => {
    const section = buildToolChainSection(lines, TURN);
    expect(section).toContain('**🔧 工具调用**');
    expect(section).toContain('- `search_web` — Searching scientific papers：`Nature EBV Long COVID`');
    expect(section).toContain(`**${TOOL_RESULT_LABELS.SEARCH_WEB}**`);
    expect(section).toContain('Research published in *Nature* indicates a connection[1][2].');
    expect(section).not.toContain('Created At:');
    expect(section).toContain(`**${TOOL_RESULT_LABELS.RUN_COMMAND}**`);
    expect(section).toContain('The command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\tok');
    expect(section).not.toContain('stale pre-turn result');
    expect(section).not.toContain('VIEW_FILE');
  });

  it('returns empty when no tools were used in this turn', () => {
    const noTools = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-15T01:38:13+08:00',
        thinking: 't',
      }),
      JSON.stringify({ type: 'SEARCH_WEB', status: 'DONE', created_at: '2026-08-15T01:37:00+08:00', content: 'stale pre-turn result' }),
    ];
    expect(buildToolChainSection(noTools, TURN)).toBe('');
  });
});
