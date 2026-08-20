import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../../utils/logger.js';
import { extractThoughtAndContent } from '../../agy/agyCli.js';
import { normalizeText } from './textUtils.js';
import { getAgyDataDir } from '../../config/userConfig.js';

/**
 * agy transcript step types that carry TOOL OUTPUT (what a tool returned to the
 * model). Everything a turn produced outside the answer body belongs in the
 * Thinking Process block, so every tool-result type MUST be listed here — an
 * unlisted type is silently dropped from the rendered thought.
 *
 * Deliberately absent, because they are prompt-side context injected INTO the
 * model rather than output produced BY it: USER_INPUT, CONVERSATION_HISTORY,
 * CHECKPOINT, SYSTEM_MESSAGE, EPHEMERAL_MESSAGE, DIRECTORY_RULES.
 */
export const TOOL_RESULT_LABELS: Record<string, string> = {
  SEARCH_WEB: '🔍 联网搜索',
  READ_URL_CONTENT: '🔗 读取网页',
  RUN_COMMAND: '⚙️ 执行命令',
  CODE_ACTION: '💻 代码操作',
  VIEW_FILE: '📄 读取文件',
  GREP_SEARCH: '🔎 代码检索',
  LIST_DIRECTORY: '📂 列出目录',
  MCP_TOOL: '🧩 MCP 工具',
  INVOKE_SUBAGENT: '🤖 子代理',
  ASK_QUESTION: '❓ 追问确认',
  GENERIC: '🛠 工具',
  GENERATE_IMAGE: '🎨 生成图片',
  ERROR_MESSAGE: '⚠️ 工具错误',
};

/**
 * agy tool argument keys that identify WHAT a call operated on, most specific
 * first. agy uses PascalCase for most tools (`AbsolutePath`, `CommandLine`,
 * `Query`…) and lowercase only for a few (`query` on search_web), so both
 * spellings must be probed or the call renders as a bare tool name.
 */
const TOOL_DETAIL_KEYS = [
  'query', 'Query',
  'CommandLine', 'command',
  'AbsolutePath', 'TargetFile', 'path',
  'DirectoryPath', 'SearchPath',
  'Url', 'url',
  'ToolName', 'ImageName', 'TaskId',
  'Instruction', 'Prompt',
];

/** Flatten a value into a single-line inline-code payload. */
function toInlineDetail(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function safeParse(line: string): JsonRecord | null {
  try {
    return asJsonRecord(JSON.parse(line.trim()));
  } catch {
    return null;
  }
}

export function stripTimestampPrefix(content: string): string {
  return content
    // Finished tools carry a Created At / Completed At pair …
    .replace(/^Created At:[\s\S]*?Completed At:.*?(?:\n+|$)/, '')
    // … while a still-running one only has Created At.
    .replace(/^Created At:.*?(?:\n+|$)/, '')
    .trim();
}

export function stripControlCharacters(text: string): string {
  const withoutAnsi = text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
  return withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF0-\uFFFF\uD800-\uDFFF]/g, '');
}

export function sanitizeToolResultContent(content: string): string {
  const cleaned = stripControlCharacters(content);
  return cleaned.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

export function formatToolCall(tc: unknown): string | null {
  const toolCall = asJsonRecord(tc);
  if (!toolCall || typeof toolCall['name'] !== 'string') return null;
  const args = asJsonRecord(toolCall['args']) ?? {};
  const clean = (v: unknown): string =>
    typeof v === 'string' ? stripControlCharacters(v).replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim() : '';
  const desc = clean(args['toolAction']) || clean(args['toolSummary']);
  let detail = '';
  for (const key of TOOL_DETAIL_KEYS) {
    detail = clean(args[key]);
    if (detail) break;
  }
  let line = `- \`${toolCall['name']}\``;
  if (desc) line += ` — ${desc}`;
  if (detail) line += `：\`${toInlineDetail(detail)}\``;
  return line;
}

interface TurnTranscript {
  /**
   * Every non-body output of the turn, in transcript order: planner reasoning,
   * the tool calls it issued, and what those tools returned.
   */
  markdown: string;
  /** True when at least one planner step carried native reasoning text. */
  hasThinking: boolean;
}

/**
 * Assemble one turn's complete non-body output from raw transcript lines.
 *
 * The turn's steps are stable-sorted by `step_index` before assembly: agy
 * appends steps asynchronously, so the physical line order is NOT guaranteed to
 * match step_index (measurements: ~23% of transcript files contain adjacent
 * out-of-order steps, and the final answer step can land last). `created_at` is
 * only used to cut the turn at `turnStartTime` — it has second resolution and
 * would scramble same-second steps, so it can't order them. In multi-turn files
 * `step_index` resets per turn, so the time filter MUST run before the sort.
 * Steps are not deduplicated: agy can re-emit a planner step with the same
 * index, but the re-emitted copy is usually the more complete one. Nothing is
 * truncated here — the Thinking Process block carries the full reasoning and
 * tool logs of the turn, and oversized rich messages are handled downstream by
 * splitRichBlocks (multi-message split, no content loss).
 */
export function buildTurnTranscript(lines: string[], turnStartTime: number): TurnTranscript {
  const parts: { kind: 'thinking' | 'tool'; text: string }[] = [];
  let hasThinking = false;

  const push = (kind: 'thinking' | 'tool', text: string): void => {
    if (!text) return;
    parts.push({ kind, text });
  };

  // Filter to this turn first, then stable-sort by step_index (see the JSDoc
  // above: file order is not authoritative, and step_index resets per turn).
  const turnSteps: { parsed: JsonRecord; createdAt: number }[] = lines
    .map(safeParse)
    .filter((parsed): parsed is JsonRecord => parsed !== null)
    .map((parsed) => ({
      parsed,
      createdAt: typeof parsed['created_at'] === 'string' ? new Date(parsed['created_at']).getTime() : NaN,
    }))
    .filter(({ createdAt }) => !isNaN(createdAt) && createdAt >= turnStartTime)
    .sort((a, b) => Number(a.parsed['step_index'] ?? 0) - Number(b.parsed['step_index'] ?? 0));

  for (const { parsed } of turnSteps) {
    if (parsed['type'] === 'PLANNER_RESPONSE') {
      if (parsed['status'] !== 'DONE') continue;
      if (typeof parsed['thinking'] === 'string' && parsed['thinking'].trim()) {
        hasThinking = true;
        push('thinking', parsed['thinking'].trim());
      }
      const calls = (Array.isArray(parsed['tool_calls']) ? parsed['tool_calls'] : [])
        .map(formatToolCall)
        .filter((l: string | null): l is string => Boolean(l));
      if (calls.length) push('tool', `**🔧 工具调用**\n\n${calls.join('\n')}`);
      continue;
    }

    const type = typeof parsed['type'] === 'string' ? parsed['type'] : '';
    const label = TOOL_RESULT_LABELS[type];
    if (!label) continue;
    const body = sanitizeToolResultContent(stripTimestampPrefix(String(parsed['content'] ?? '')));
    if (!body) continue;
    // Background tools report RUNNING first and finish in a later step; keep the
    // status so a still-running task is not mistaken for a completed one.
    const status = parsed['status'] === 'DONE' ? '' : ` · ${String(parsed['status'] ?? '')}`;
    push('tool', `**${label}${status}**\n\n\`\`\`\n${body}\n\`\`\``);
  }

  let markdown = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // A rule separates tool activity from prose; consecutive reasoning blocks
      // just get a blank line so a plain thought stays readable.
      markdown += parts[i].kind === 'tool' || parts[i - 1].kind === 'tool' ? '\n\n---\n\n' : '\n\n';
    }
    markdown += parts[i].text;
  }

  return { markdown: markdown.trim(), hasThinking };
}

/**
 * Read one turn's transcript lines, preferring `transcript_full.jsonl`:
 * `transcript.jsonl` truncates long `content` fields (marked by
 * `truncated_fields`), which would clip tool results and break answer matching.
 */
async function readTranscriptLines(logsDir: string): Promise<{ lines: string[]; filePath: string } | null> {
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const filePath = path.join(logsDir, name);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      if (!raw.trim()) continue;
      return { lines: raw.trim().split('\n'), filePath };
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
      if (code !== 'ENOENT') {
        logger.debug(`[messageLoop] Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

export async function readThoughtFromTranscript(
  conversationId: string,
  answerBuffer: string,
  turnStartTime: number,
  opts?: { maxAttempts?: number }
): Promise<{ thought: string; source: string } | null> {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return null;
  }
  const startTime = Date.now();
  const baseDir = getAgyDataDir();
  const brainDir = path.join(baseDir, 'brain', conversationId);
  const logsDir = path.join(brainDir, '.system_generated', 'logs');

  // Only native agy runs have a brain/ directory. opencode/deepseek/web2api use
  // synthetic conversation ids, so polling them for seconds is pure added latency.
  try {
    await fs.access(brainDir);
  } catch {
    logger.debug(`[messageLoop] [TRANSCRIPT] No brain dir for conversationId=${conversationId} — not an agy conversation`);
    return null;
  }

  let attempts = 0;
  const maxAttempts = opts?.maxAttempts ?? 50; // 50 * 100ms = 5 seconds total

  // Normalize the expected answer buffer for accurate validation
  const normAnswer = normalizeText(answerBuffer);
  const answerPrefix = normAnswer.slice(0, 100);

  while (attempts < maxAttempts) {
    attempts++;
    const transcript = await readTranscriptLines(logsDir);
    if (transcript) {
      const { lines, filePath } = transcript;
      let foundStep: JsonRecord | null = null;
      let matchedReason = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = asJsonRecord(JSON.parse(line));
          if (parsed && parsed['type'] === 'PLANNER_RESPONSE' && parsed['status'] === 'DONE') {
            // Check 1: Recency verification — skip entries that predate this turn
            const createdAtTime = typeof parsed['created_at'] === 'string' ? new Date(parsed['created_at']).getTime() : NaN;
            if (!isNaN(createdAtTime)) {
              if (createdAtTime < turnStartTime) {
                matchedReason = 'Entry predates turn start';
                continue;
              }
            }

            // Check 2: Content consistency validation on isolated answer body
            if (answerPrefix) {
              const normContent = normalizeText(typeof parsed['content'] === 'string' ? parsed['content'] : '');
              if (!normContent.includes(answerPrefix)) {
                matchedReason = `Content mismatch: prefix "${answerPrefix.slice(0, 20)}..." not in content`;
                continue;
              }
            }

            foundStep = parsed;
            matchedReason = 'Matched successfully';
            break;
          }
        } catch {
          // ignore corrupted/partially written lines during poll
        }
      }

      if (foundStep) {
        const stats = await fs.stat(filePath);
        const latency = Date.now() - startTime;

        // The turn's full non-body output: reasoning + tool calls + tool results.
        const turn = buildTurnTranscript(lines, turnStartTime);

        // Priority 1: native Gemini reasoning tokens
        if (turn.hasThinking && turn.markdown) {
          logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=thinking, length=${turn.markdown.length}, hasNewlines=${turn.markdown.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
          return { thought: turn.markdown, source: 'thinking' };
        }

        // Priority 2: parsed.content extracted thought, still carrying the tool chain
        if (typeof foundStep['content'] === 'string' && foundStep['content']) {
          const { thought } = extractThoughtAndContent(foundStep['content']);
          if (thought.trim()) {
            const recovered = turn.markdown
              ? `${thought.trim()}\n\n---\n\n${turn.markdown}`
              : thought.trim();
            logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=content:extracted, length=${recovered.length}, hasNewlines=${recovered.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
            return { thought: recovered, source: 'content:extracted' };
          }
        }

        // Priority 3: no reasoning at all, but tools ran — their log is still
        // non-body output and must not be dropped.
        if (turn.markdown) {
          logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, waitCount=${attempts}, source=toolchain, length=${turn.markdown.length}, latency=${latency}ms, matchedReason="${matchedReason}"`);
          return { thought: turn.markdown, source: 'toolchain' };
        }
      }
    }
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const latency = Date.now() - startTime;
  logger.warn(`[messageLoop] [TRANSCRIPT] Timeout waiting for transcript: conversationId=${conversationId}, logsDir=${logsDir}, waitCount=${attempts}, latency=${latency}ms`);
  return null;
}
