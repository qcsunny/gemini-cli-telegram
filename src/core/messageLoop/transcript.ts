import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logger } from '../../utils/logger.js';
import { extractThoughtAndContent } from '../../agy/agyCli.js';
import { normalizeText } from './textUtils.js';
import { getAgyDataDir } from '../../config/userConfig.js';

export const TOOL_RESULT_LABELS: Record<string, string> = {
  SEARCH_WEB: '🔍 联网搜索',
  READ_URL_CONTENT: '🔗 读取网页',
  RUN_COMMAND: '⚙️ 执行命令',
  CODE_ACTION: '💻 代码操作',
  MCP_TOOL: '🧩 MCP 工具',
  GENERIC: '🛠 工具',
  GENERATE_IMAGE: '🎨 生成图片',
  ERROR_MESSAGE: '⚠️ 工具错误',
};

function safeParse(line: string): any {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

export function stripTimestampPrefix(content: string): string {
  return content.replace(/^Created At:[\s\S]*?Completed At:.*?(?:\n+|$)/, '').trim();
}

export function stripControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF0-\uFFFF\uD800-\uDFFF]/g, '');
}

export function sanitizeToolResultContent(content: string): string {
  const cleaned = stripControlCharacters(content);
  return cleaned.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

export function formatToolCall(tc: any): string | null {
  if (!tc || typeof tc.name !== 'string') return null;
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const clean = (v: unknown): string =>
    typeof v === 'string' ? stripControlCharacters(v).replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim() : '';
  const desc = clean(args.toolAction) || clean(args.toolSummary);
  const detail = clean(args.query) || clean(args.CommandLine) || clean(args.command) || clean(args.path) || clean(args.url);
  let line = `- \`${tc.name}\``;
  if (desc) line += ` — ${desc}`;
  if (detail) line += `：\`${detail}\``;
  return line;
}

export function collectTurnThinking(lines: string[], turnStartTime: number): string {
  const parts: string[] = [];
  for (const line of lines) {
    const parsed = safeParse(line);
    if (!parsed || parsed.type !== 'PLANNER_RESPONSE' || parsed.status !== 'DONE') continue;
    const createdAtTime = new Date(parsed.created_at).getTime();
    if (isNaN(createdAtTime) || createdAtTime < turnStartTime) continue;
    if (typeof parsed.thinking === 'string' && parsed.thinking.trim()) parts.push(parsed.thinking.trim());
  }
  return parts.join('\n\n');
}

export function buildToolChainSection(lines: string[], turnStartTime: number): string {
  const calls: string[] = [];
  const results: { label: string; content: string }[] = [];
  for (const line of lines) {
    const parsed = safeParse(line);
    if (!parsed) continue;
    const createdAtTime = new Date(parsed.created_at).getTime();
    if (isNaN(createdAtTime) || createdAtTime < turnStartTime) continue;
    if (parsed.type === 'PLANNER_RESPONSE' && parsed.status === 'DONE' && Array.isArray(parsed.tool_calls)) {
      for (const tc of parsed.tool_calls) {
        const formatted = formatToolCall(tc);
        if (formatted) calls.push(formatted);
      }
    } else if (parsed.status === 'DONE' && TOOL_RESULT_LABELS[parsed.type] && typeof parsed.content === 'string') {
      const body = sanitizeToolResultContent(stripTimestampPrefix(parsed.content));
      if (body) results.push({ label: TOOL_RESULT_LABELS[parsed.type], content: body });
    }
  }
  const sections: string[] = [];
  if (calls.length) sections.push('**🔧 工具调用**\n\n' + calls.join('\n'));
  for (const r of results) sections.push(`**${r.label}**\n\n${r.content}`);
  if (!sections.length) return '';
  return '\n\n---\n\n' + sections.join('\n\n');
}

export async function readThoughtFromTranscript(
  conversationId: string,
  answerBuffer: string,
  turnStartTime: number
): Promise<{ thought: string; source: string } | null> {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return null;
  }
  const startTime = Date.now();
  const baseDir = getAgyDataDir();

  const filePath = path.join(
    baseDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  let attempts = 0;
  const maxAttempts = 50; // 50 * 100ms = 5 seconds total

  // Normalize the expected answer buffer for accurate validation
  const normAnswer = normalizeText(answerBuffer);
  const answerPrefix = normAnswer.slice(0, 100);

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.trim().split('\n');
      
      let foundStep: any = null;
      let matchedReason = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'PLANNER_RESPONSE' && parsed.status === 'DONE') {
            // Check 1: Recency verification — skip entries that predate this turn
            const createdAtTime = new Date(parsed.created_at).getTime();
            if (!isNaN(createdAtTime)) {
              if (createdAtTime < turnStartTime) {
                matchedReason = 'Entry predates turn start';
                continue;
              }
            }

            // Check 2: Content consistency validation on isolated answer body
            if (answerPrefix) {
              const normContent = normalizeText(parsed.content || '');
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

        // Merge this turn's full reasoning chain (all PLANNER_RESPONSE thinking,
        // chronological), then append the tool-chain log (tool calls + results).
        const mergedThinking = collectTurnThinking(lines, turnStartTime);
        const toolChain = buildToolChainSection(lines, turnStartTime);

        // Priority 1: native Gemini reasoning tokens
        if (mergedThinking) {
          const thought = (mergedThinking + toolChain).trim();
          logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=thinking, length=${thought.length}, thoughtLen=${mergedThinking.length}, toolChainLen=${toolChain.length}, hasNewlines=${thought.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
          return { thought, source: 'thinking' };
        }

        // Priority 2: parsed.content extracted thought
        if (foundStep.content && typeof foundStep.content === 'string') {
          const { thought } = extractThoughtAndContent(foundStep.content);
          if (thought.trim()) {
            const recovered = (thought.trim() + toolChain).trim();
            logger.info(`[messageLoop] [TRANSCRIPT] Success: conversationId=${conversationId}, filePath=${filePath}, fileSize=${stats.size}, mtime=${stats.mtime.toISOString()}, waitCount=${attempts}, source=content:extracted, length=${recovered.length}, thoughtLen=${thought.trim().length}, toolChainLen=${toolChain.length}, hasNewlines=${recovered.includes('\n')}, latency=${latency}ms, matchedReason="${matchedReason}", normAnswerLen=${normAnswer.length}`);
            return { thought: recovered, source: 'content:extracted' };
          }
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.debug(`[messageLoop] Error polling transcript: ${err.message || err}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const latency = Date.now() - startTime;
  logger.warn(`[messageLoop] [TRANSCRIPT] Timeout waiting for transcript: conversationId=${conversationId}, filePath=${filePath}, waitCount=${attempts}, latency=${latency}ms`);
  return null;
}
