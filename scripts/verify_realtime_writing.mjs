import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BRAIN_DIR = '/home/user/.gemini/antigravity-cli/brain';
const AGY = '/home/user/.local/bin/agy';
const CWD = '/home/user/Documents/通用知识专家_RichText';
const PROMPT = '证明：任何奇素数 p 都可以表示为两个连续整数的平方差。如果要求 x, y 必须是正整数，请详述你的推导思考过程。并且写一篇包含5000字以上的超长论文进行数学拓展。';
const PROJECT_ID = 'ac8952cd-52dc-40c3-9305-dd7b87243ce4';

// 1. Snapshot directories before spawn
const beforeDirs = new Set(fs.existsSync(BRAIN_DIR) ? fs.readdirSync(BRAIN_DIR) : []);

const args = [
  '--print', PROMPT,
  '--model', 'Gemini 3.1 Pro (High)',
  '--project', PROJECT_ID
];

console.log('Spawning agy...');
const startTime = Date.now();

const child = spawn(AGY, args, {
  cwd: CWD,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1' }
});

let foundTranscriptPath = null;
let lastSize = -1;
let historyLog = [];

const interval = setInterval(() => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  if (!foundTranscriptPath) {
    // Try to find the new directory
    const currentDirs = fs.readdirSync(BRAIN_DIR);
    const newDir = currentDirs.find(d => !beforeDirs.has(d));
    if (newDir) {
      const transcriptPath = path.join(BRAIN_DIR, newDir, '.system_generated/logs/transcript.jsonl');
      if (fs.existsSync(transcriptPath)) {
        foundTranscriptPath = transcriptPath;
        console.log(`[${elapsed}s] Found transcript file: ${foundTranscriptPath}`);
      }
    }
  }

  if (foundTranscriptPath) {
    try {
      const stats = fs.statSync(foundTranscriptPath);
      if (stats.size !== lastSize) {
        const content = fs.readFileSync(foundTranscriptPath, 'utf8');
        const numLines = content.split('\n').filter(Boolean).length;
        console.log(`[${elapsed}s] File size changed: ${lastSize} -> ${stats.size} bytes. Number of lines: ${numLines}`);
        lastSize = stats.size;
        
        // Log the lines content
        historyLog.push({
          elapsed,
          size: stats.size,
          lines: content.split('\n').filter(Boolean).map(l => {
            try {
              const parsed = JSON.parse(l);
              return {
                type: parsed.type,
                status: parsed.status,
                contentLength: parsed.content ? parsed.content.length : 0,
                thinkingLength: parsed.thinking ? parsed.thinking.length : 0
              };
            } catch {
              return 'UNPARSABLE_LINE';
            }
          })
        });
      }
    } catch (e) {
      console.log(`[${elapsed}s] Read error: ${e.message}`);
    }
  }
}, 200);

child.stdout.on('data', (chunk) => {
  // We don't print stdout to keep logs clean
});

child.stderr.on('data', (chunk) => {
  // console.error(`[STDERR] ${chunk.toString()}`);
});

child.on('close', (code) => {
  clearInterval(interval);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n--- agy exited with code ${code} after ${elapsed}s ---`);
  
  console.log('\n--- Timeline of transcript.jsonl changes ---');
  console.log(JSON.stringify(historyLog, null, 2));
  
  if (foundTranscriptPath) {
    const finalContent = fs.readFileSync(foundTranscriptPath, 'utf8');
    console.log(`\n--- Final transcript lines count: ${finalContent.split('\n').filter(Boolean).length}`);
  }
});
