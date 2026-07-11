/**
 * Pipeline audit script — traces every step from agy stdout to final Telegram call.
 * Run: node scripts/audit_pipeline.mjs
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as os from 'node:os';

const AGY = `${os.homedir()}/.local/bin/agy`;
const PROMPT = '用一句话说1+1等于几';
const MODEL = 'Gemini 3.5 Flash (Medium)';

const log = (step, msg, data) => {
  const prefix = `[AUDIT][Step ${step}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${msg}`);
  }
};

// ── Step 1: Capture raw stdout exactly as emitted ─────────────────────────────
log(1, 'Spawning agy with --output-format events');
log(1, `Command: ${AGY} --print "${PROMPT}" --output-format events --model "${MODEL}"`);

const child = spawn(AGY, ['--print', PROMPT, '--output-format', 'events', '--model', MODEL], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1' },
});

log(1, `Child PID: ${child.pid}`);

const rawLines = [];
let stdoutDecoder = new StringDecoder('utf-8');
let stdoutBuf = '';
let errBuf = '';

// ── Step 2+3: Parse each line and show what type it is ────────────────────────
let onEventCallCount = 0;
let onChunkCallCount = 0;
const simulatedThoughtBuffer = [];
const simulatedAnswerBuffer = [];
let simulatedDone = false;

function simulateOnEvent(ev) {
  onEventCallCount++;
  log(3, `onEvent #${onEventCallCount} received:`, ev);
  if (ev.type === 'thought') {
    simulatedThoughtBuffer.push(ev.content || '');
    log(4, `thoughtBuffer updated (total ${simulatedThoughtBuffer.join('').length} chars)`);
  } else if (ev.type === 'text') {
    simulatedAnswerBuffer.push(ev.content || '');
    log(4, `answerBuffer updated (total ${simulatedAnswerBuffer.join('').length} chars)`);
  } else if (ev.type === 'done') {
    simulatedDone = true;
    log(4, 'isDone set to true');
  }
  // Step 5: would Rich Message builder be invoked?
  const thought = simulatedThoughtBuffer.join('').trim();
  const answer = simulatedAnswerBuffer.join('').trim();
  const unifiedText = answer || thought;
  log(5, `Rich Message builder check: unifiedText="${unifiedText.slice(0,80)}" (empty=${!unifiedText})`);
}

function simulateOnChunk(chunk) {
  onChunkCallCount++;
  // Don't flood the log
}

child.stdout.on('data', (chunk) => {
  stdoutBuf += stdoutDecoder.write(chunk);
  const lines = stdoutBuf.split('\n');
  stdoutBuf = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rawLines.push(trimmed);

    // Step 1: Raw line
    log(1, `RAW LINE: ${JSON.stringify(trimmed)}`);

    // Step 2: Attempt JSON parse
    try {
      const ev = JSON.parse(trimmed);
      log(2, `PARSED OK: type=${ev.type}, content_len=${ev.content?.length ?? 0}`, ev);

      // Step 3: Dispatch to onEvent
      if (ev.type === 'thought' || ev.type === 'text' || ev.type === 'done') {
        simulateOnEvent(ev);
      } else {
        log(2, `WARNING: unknown event type "${ev.type}" - NOT dispatched to onEvent`);
      }
      simulateOnChunk(trimmed);
    } catch (e) {
      log(2, `JSON.parse FAILED: "${trimmed.slice(0, 100)}" — falls to raw text fallback`);
      log(2, `CRITICAL: raw text fallback calls onChunk ONLY, NOT onEvent!`);
      log(2, `RESULT: answerBuffer stays empty; final render will find nothing to send.`);
      simulateOnChunk(trimmed);
    }
  }
});

child.stderr.on('data', (c) => { errBuf += c.toString(); });

child.on('close', (code) => {
  // Flush remaining
  const finalOut = stdoutDecoder.end();
  if (finalOut && finalOut.trim()) {
    log(1, `FINAL STDOUT FLUSH: ${JSON.stringify(finalOut.trim())}`);
  }

  // done event from close handler
  simulateOnEvent({ type: 'done' });

  console.log('\n' + '='.repeat(70));
  log('SUMMARY', `Exit code: ${code}`);
  log('SUMMARY', `Total raw lines from agy: ${rawLines.length}`);
  log('SUMMARY', `onEvent called: ${onEventCallCount} times`);
  log('SUMMARY', `onChunk called: ${onChunkCallCount} times`);
  log('SUMMARY', `thoughtBuffer length: ${simulatedThoughtBuffer.join('').length}`);
  log('SUMMARY', `answerBuffer length: ${simulatedAnswerBuffer.join('').length}`);
  log('SUMMARY', `isDone: ${simulatedDone}`);
  const finalAnswer = simulatedAnswerBuffer.join('').trim();
  const finalThought = simulatedThoughtBuffer.join('').trim();
  log('SUMMARY', `Final unified text that would be sent: ${JSON.stringify((finalAnswer || finalThought).slice(0, 200))}`);

  if (!finalAnswer && !finalThought) {
    console.log('\n' + '!'.repeat(70));
    console.log('ROOT CAUSE CONFIRMED:');
    console.log('  agy does NOT emit NDJSON events — --output-format events is silently ignored.');
    console.log('  agy emits plain markdown text to stdout.');
    console.log('  agyCli.ts JSON.parse() fails on every line -> raw text fallback path.');
    console.log('  Raw text fallback calls onChunk() but NOT onEvent().');
    console.log('  messageLoop.ts only fills answerBuffer from onEvent({type:"text"}).');
    console.log('  answerBuffer stays empty throughout -> updateMessageStream returns early.');
    console.log('  No message is ever sent to Telegram.');
    console.log('!'.repeat(70));
  }

  if (errBuf.trim()) {
    log('STDERR', errBuf.trim());
  }
});
