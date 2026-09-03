/**
 * @file opencodeModels.ts
 * @description Fetches the models available to the local `opencode` CLI via
 * `opencode models opencode --verbose`. Output is an alternating sequence of
 * `<provider/id>` lines and pretty-printed JSON blocks:
 *
 *   opencode/big-pickle
 *   {
 *     "id": "big-pickle",
 *     "name": "Big Pickle",
 *     "status": "active",
 *     "cost": { "input": 0, "output": 0, ... },
 *     ...
 *   }
 *   opencode/claude-fable-5
 *   { ... }
 *
 * The JSON `name` field is the official display name — `OpenCode: ${name}`
 * matches the config.json naming convention verbatim.
 */
import { spawn } from 'node:child_process';
import { getOpenCodePath } from './backends/opencodePath.js';
import { loadUserConfig } from '../config/userConfig.js';
import { logger } from '../utils/logger.js';

export interface OpenCodeModelEntry {
  /** Full routing id (e.g. 'opencode/big-pickle'), taken from the id line. */
  id: string;
  /** Official display name from the verbose JSON block (e.g. 'Big Pickle'). */
  name: string;
  /** status === 'active'. */
  active: boolean;
  /** cost.input === 0 && cost.output === 0. Exposed for reference only — addition gating uses the '-free' suffix. */
  free: boolean;
}

const ID_LINE_RE = /^[A-Za-z0-9][^\s{/]*\/\S+$/;

interface VerboseBlock {
  name?: unknown;
  status?: unknown;
  cost?: { input?: unknown; output?: unknown };
}

function entryFromBlock(id: string, block: VerboseBlock): OpenCodeModelEntry | null {
  if (typeof block.name !== 'string' || !block.name) return null;
  const input = typeof block.cost?.input === 'number' ? block.cost.input : NaN;
  const output = typeof block.cost?.output === 'number' ? block.cost.output : NaN;
  return {
    id,
    name: block.name,
    active: block.status === 'active',
    free: input === 0 && output === 0,
  };
}

/**
 * Parse `opencode models <provider> --verbose` output. Scans line by line:
 * a bare id line registers the current id; a `{` line starts a brace-depth
 * counted JSON block that is paired with the most recent id. Malformed
 * blocks are skipped (tolerant — never throw on partial output).
 */
export function parseOpenCodeModelsOutput(stdout: string): OpenCodeModelEntry[] {
  const entries: OpenCodeModelEntry[] = [];
  const lines = stdout.split('\n');
  let currentId: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (ID_LINE_RE.test(trimmed)) {
      currentId = trimmed;
      continue;
    }

    if (trimmed.startsWith('{')) {
      // Accumulate the JSON block using brace depth (strings inside are
      // pretty-printed with quoted keys; naive depth counting is safe enough
      // for opencode's output and any misparse just skips the block).
      let depth = 0;
      const blockLines: string[] = [];
      for (; i < lines.length; i++) {
        const inner = lines[i]!;
        const innerTrim = inner.trim();
        // An unterminated block running into the next id line is a truncated
        // block — cut it here and reprocess the id line as a fresh entry.
        if (blockLines.length > 0 && ID_LINE_RE.test(innerTrim)) {
          i--;
          break;
        }
        blockLines.push(inner);
        for (const ch of inner) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth === 0 && innerTrim.endsWith('}')) break;
      }
      if (!currentId) continue; // block without a preceding id line
      try {
        const block = JSON.parse(blockLines.join('\n')) as VerboseBlock;
        const entry = entryFromBlock(currentId, block);
        if (entry) entries.push(entry);
      } catch {
        // tolerate malformed blocks
      }
      currentId = null;
    }
  }
  return entries;
}

/**
 * List `opencode/`-namespace models from the local opencode CLI. Not cached —
 * each call makes a real request (what /model sync wants).
 * Rejects on spawn failure, non-zero exit, timeout, or an empty result (the
 * empty gate is a safety net: never let a flaky upstream wipe config entries).
 */
export async function listOpenCodeModels(timeoutMs: number = 90_000): Promise<OpenCodeModelEntry[]> {
  const opencode = getOpenCodePath();
  const proxy = loadUserConfig()?.proxy || process.env['HTTP_PROXY'] || process.env['http_proxy'];
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
  if (proxy) {
    env['HTTP_PROXY'] = proxy;
    env['HTTPS_PROXY'] = proxy;
  }

  return new Promise<OpenCodeModelEntry[]>((resolve, reject) => {
    const child = spawn(opencode, ['models', 'opencode', '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`opencode models timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn opencode (${opencode}): ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`opencode models exited with code ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }
      const entries = parseOpenCodeModelsOutput(stdout);
      if (entries.length === 0) {
        logger.warn(`[opencodeModels] opencode models returned no parseable entries. stdout=${stdout.slice(0, 200)}`);
        reject(new Error('opencode models 返回 0 个 opencode/ 模型（安全起见未做任何修改）'));
        return;
      }
      resolve(entries);
    });
  });
}
