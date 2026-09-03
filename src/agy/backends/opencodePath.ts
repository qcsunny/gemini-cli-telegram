/**
 * @file opencodePath.ts
 * @description Resolve the local opencode binary path. Kept dependency-free
 * so light-weight modules (model listing, tests) can import it without
 * pulling in better-sqlite3 & friends from the full backend runner.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Path to the opencode binary — OPENCODE_PATH env, then common install locations. */
export function getOpenCodePath(): string {
  if (process.env['OPENCODE_PATH']) return process.env['OPENCODE_PATH'];
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'opencode';
}
