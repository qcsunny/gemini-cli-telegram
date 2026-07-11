/**
 * Exact replica of the Telegram Bot's child process spawning logic.
 * Captures raw stdout and stderr bytes without any parsing or modification.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const AGY = '/home/user/.local/bin/agy';
const CWD = '/home/user/Documents/通用知识专家_RichText';
const PROMPT = '证明：任何奇素数 p 都可以表示为两个连续整数的平方差。如果要求 x, y 必须是正整数，请详述你的推导思考过程。';
const MODEL = 'Gemini 3.1 Pro (High)';
// Real project ID from global configs as injected by bot.ts
const PROJECT_ID = 'ac8952cd-52dc-40c3-9305-dd7b87243ce4'; 

const args = [
  '--print', PROMPT,
  '--output-format', 'events',
  '--model', MODEL,
  '--project', PROJECT_ID
];

console.log('--- 1. SPAWN COMMAND DETAILS ---');
console.log('Executable:', AGY);
console.log('Arguments:', JSON.stringify(args));
console.log('CWD:', CWD);
console.log('Environment: { NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", CI: "1" }');
console.log('--------------------------------\n');

const cleanEnv = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  TERM: 'dumb',
  CI: '1'
};
// Strip agent specific variables just like agyCli.ts
delete cleanEnv['ANTIGRAVITY_AGENT'];
delete cleanEnv['ANTIGRAVITY_LS_ADDRESS'];
delete cleanEnv['ANTIGRAVITY_CONVERSATION_ID'];
delete cleanEnv['ANTIGRAVITY_PROJECT_ID'];
delete cleanEnv['ANTIGRAVITY_TRAJECTORY_ID'];
cleanEnv['ANTIGRAVITY_PROJECT_ID'] = PROJECT_ID;

const child = spawn(AGY, args, {
  cwd: CWD,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: cleanEnv,
});

let rawStdout = Buffer.alloc(0);
let rawStderr = Buffer.alloc(0);

child.stdout.on('data', (chunk) => {
  console.log(`[STDOUT EVENT] Received chunk of size: ${chunk.length} bytes`);
  rawStdout = Buffer.concat([rawStdout, chunk]);
});

child.stderr.on('data', (chunk) => {
  console.log(`[STDERR EVENT] Received chunk of size: ${chunk.length} bytes`);
  rawStderr = Buffer.concat([rawStderr, chunk]);
});

child.on('close', (code) => {
  console.log(`\n--- Process exited with code ${code} ---`);
  
  console.log('\n--- 2. RAW STDOUT STREAM (String) ---');
  console.log(rawStdout.toString('utf-8'));
  console.log('--- END OF RAW STDOUT ---');
  
  console.log('\n--- 3. RAW STDOUT STREAM (Hex representation of first 500 bytes) ---');
  console.log(rawStdout.slice(0, 500).toString('hex'));
  console.log('---------------------------------------');

  console.log('\n--- 4. RAW STDERR STREAM (String) ---');
  console.log(rawStderr.toString('utf-8'));
  console.log('--- END OF RAW STDERR ---');

  // Let's write them to raw output files to be absolutely sure of contents
  fs.writeFileSync('scripts/raw_stdout.bin', rawStdout);
  fs.writeFileSync('scripts/raw_stderr.bin', rawStderr);
  console.log('\nSaved raw output to scripts/raw_stdout.bin and scripts/raw_stderr.bin');
});
