/**
 * @file agyModels.ts
 * @description Fetches the list of models available to the local `agy` binary
 * via `agy models`. Output format (tab-separated, first line is a banner):
 *
 *   Fetching available models...
 *   gemini-3.8-flash-high\tGemini 3.8 Flash (High)
 *   ...
 *
 * Display names match config.json model entries verbatim — unprefixed models
 * are passed to `agy --model` as-is, so no id mapping is needed.
 */
import { spawn } from 'node:child_process';
import { buildAgyEnv, getAgyPath } from './agyCli.js';
import { loadUserConfig } from '../config/userConfig.js';
import { logger } from '../utils/logger.js';

export interface AgyModelEntry {
  id: string;
  display: string;
}

/** Parse `agy models` stdout into model entries, skipping the banner line. */
export function parseAgyModelsOutput(stdout: string): AgyModelEntry[] {
  const entries: AgyModelEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    if (tabIdx <= 0) continue; // banner or malformed line
    const id = trimmed.slice(0, tabIdx).trim();
    const display = trimmed.slice(tabIdx + 1).trim();
    if (id && display) entries.push({ id, display });
  }
  return entries;
}

/**
 * List models available to the local agy CLI. Not cached — each call makes a
 * real request (this is exactly what /model sync wants).
 * @throws on non-zero exit, timeout, or spawn failure.
 */
export async function listAgyModels(timeoutMs: number = 30_000): Promise<AgyModelEntry[]> {
  const agy = getAgyPath();
  const proxy = loadUserConfig()?.proxy || process.env['HTTP_PROXY'] || process.env['http_proxy'];
  const env = buildAgyEnv(proxy) as NodeJS.ProcessEnv;

  return new Promise<AgyModelEntry[]>((resolve, reject) => {
    const child = spawn(agy, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`agy models timed out after ${timeoutMs}ms`));
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
      reject(new Error(`failed to spawn agy (${agy}): ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`agy models exited with code ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }
      const entries = parseAgyModelsOutput(stdout);
      if (entries.length === 0) {
        logger.warn(`[agyModels] agy models returned no parseable entries. stdout=${stdout.slice(0, 200)}`);
        reject(new Error('agy models returned no parseable model entries'));
        return;
      }
      resolve(entries);
    });
  });
}
