import { Bot } from 'grammy';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/home/user/.gemini-cli-telegram/config.json', 'utf8'));
const token = cfg.telegramBotToken;
const chatId = 8431249190;
const bot = new Bot(token);

// Build HTML of approx `len` chars using repeated <br> separated short lines.
function makeHtml(len) {
  const unit = '行内容测试数据ABCDEFGH';
  let s = '';
  while (s.length < len) s += unit + '<br>';
  return s.slice(0, len);
}

const TIMEOUT_MS = 20000;
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms)),
  ]);
}

async function trySend(len) {
  const html = makeHtml(len);
  try {
    const res = await withTimeout(bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: { html },
    }), TIMEOUT_MS);
    // delete immediately to keep chat clean
    try { await withTimeout(bot.api.deleteMessage(chatId, res.message_id), TIMEOUT_MS); } catch {}
    return { ok: true, id: res.message_id, actual: html.length };
  } catch (e) {
    return { ok: false, err: (e?.message || String(e)).slice(0, 200) };
  }
}

// Binary search for max length between lo and hi
let lo = 1000, hi = 60000, best = -1, bestErr = '';
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  process.stdout.write(`probing ${mid} ... `);
  const r = await trySend(mid);
  if (r.ok) {
    console.log(`OK (len=${r.actual})`);
    best = mid; lo = mid + 1;
  } else {
    console.log(`FAIL: ${r.err}`);
    bestErr = r.err; hi = mid - 1;
  }
  await new Promise(r => setTimeout(r, 300));
}
console.log(`\n=== MAX working length ≈ ${best} chars ===`);
if (bestErr) console.log(`last failure: ${bestErr}`);
