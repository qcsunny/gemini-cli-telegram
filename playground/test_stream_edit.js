import { Bot as GrammyBot } from 'grammy';
import { ProxyAgent as UndiciProxyAgent, fetch as UndiciFetch } from 'undici';

const token = "8855898234:AAHR8-eQttz91staGVp7TAUfskrfrMqi1r8";
const proxy = "http://127.0.0.1:7890";
const chatId = 8431249190;

const clientConfig = {};
const proxyAgent = new UndiciProxyAgent(proxy);
clientConfig.baseFetchConfig = {
  dispatcher: proxyAgent,
  compress: true,
};
clientConfig.fetch = (url, init) => {
  const { signal, ...rest } = init;
  return UndiciFetch(url, {
    ...rest,
    dispatcher: proxyAgent,
  });
};

const bot = new GrammyBot(token, { client: clientConfig });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTestForInterval(delayMs, editCount = 10) {
  console.log(`\n========================================`);
  console.log(`Starting test: Interval = ${delayMs}ms, Edits = ${editCount}`);
  console.log(`========================================`);

  let message;
  try {
    message = await bot.api.sendMessage(chatId, `[Test Init] Starting stream edit test with delay ${delayMs}ms...`);
    console.log(`Initial message sent. Message ID: ${message.message_id}`);
  } catch (error) {
    console.error(`Failed to send initial message:`, error);
    return { success: false, error: error.message };
  }

  const messageId = message.message_id;
  const results = [];
  let successCount = 0;
  let failCount = 0;
  let rateLimited = false;
  let rateLimitResetTime = 0;

  for (let i = 1; i <= editCount; i++) {
    await sleep(delayMs);
    const text = `[Test Run] Delay: ${delayMs}ms | Edit: ${i}/${editCount} | Time: ${new Date().toISOString()}`;
    const startTime = Date.now();
    try {
      await bot.api.editMessageText(chatId, messageId, text);
      const duration = Date.now() - startTime;
      console.log(`Edit ${i}/${editCount} succeeded in ${duration}ms`);
      results.push({ edit: i, status: 'SUCCESS', duration, error: null });
      successCount++;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`Edit ${i}/${editCount} FAILED in ${duration}ms: ${error.message}`);
      
      let is429 = false;
      let retryAfter = null;
      if (error.parameters && error.parameters.retry_after) {
        is429 = true;
        retryAfter = error.parameters.retry_after;
        rateLimited = true;
        rateLimitResetTime = retryAfter;
      } else if (error.message.includes('429')) {
        is429 = true;
        rateLimited = true;
      }
      
      results.push({ 
        edit: i, 
        status: is429 ? '429_LIMIT' : 'FAILED', 
        duration, 
        error: error.message,
        retryAfter
      });
      failCount++;
    }
  }

  try {
    await bot.api.editMessageText(chatId, messageId, `[Test Done] Delay: ${delayMs}ms | Success: ${successCount}/${editCount} | Rate limited: ${rateLimited ? 'YES' : 'NO'}`);
  } catch (e) {
    // Ignore cleanup errors
  }

  return {
    interval: delayMs,
    total: editCount,
    successCount,
    failCount,
    rateLimited,
    rateLimitResetTime,
    results
  };
}

async function runPipelinedTest(delayMs, editCount = 10) {
  console.log(`\n========================================`);
  console.log(`Starting Pipelined test: Interval = ${delayMs}ms, Edits = ${editCount}`);
  console.log(`========================================`);

  let message;
  try {
    message = await bot.api.sendMessage(chatId, `[Pipelined Test Init] Starting pipelined stream edit test with delay ${delayMs}ms...`);
    console.log(`Initial message sent. Message ID: ${message.message_id}`);
  } catch (error) {
    console.error(`Failed to send initial message:`, error);
    return { success: false, error: error.message };
  }

  const messageId = message.message_id;
  const promises = [];
  const results = [];
  let successCount = 0;
  let failCount = 0;
  let rateLimited = false;
  let rateLimitResetTime = 0;

  const startTime = Date.now();
  for (let i = 1; i <= editCount; i++) {
    const text = `[Pipelined Test] Delay: ${delayMs}ms | Edit: ${i}/${editCount} | Time: ${new Date().toISOString()}`;
    
    // We construct the promise and push it to array, executing it in the background
    const p = (async (index) => {
      const start = Date.now();
      try {
        await bot.api.editMessageText(chatId, messageId, text);
        const duration = Date.now() - start;
        console.log(`Pipelined Edit ${index}/${editCount} succeeded in ${duration}ms`);
        successCount++;
        results.push({ edit: index, status: 'SUCCESS', duration, error: null });
      } catch (error) {
        const duration = Date.now() - start;
        console.log(`Pipelined Edit ${index}/${editCount} FAILED in ${duration}ms: ${error.message}`);
        
        let is429 = false;
        let retryAfter = null;
        if (error.parameters && error.parameters.retry_after) {
          is429 = true;
          retryAfter = error.parameters.retry_after;
          rateLimited = true;
          rateLimitResetTime = Math.max(rateLimitResetTime, retryAfter);
        } else if (error.message.includes('429')) {
          is429 = true;
          rateLimited = true;
        }
        
        results.push({ 
          edit: index, 
          status: is429 ? '429_LIMIT' : 'FAILED', 
          duration, 
          error: error.message,
          retryAfter
        });
        failCount++;
      }
    })(i);

    promises.push(p);
    
    if (i < editCount) {
      await sleep(delayMs);
    }
  }

  // Wait for all requests to finish
  await Promise.all(promises);

  try {
    await bot.api.editMessageText(chatId, messageId, `[Pipelined Done] Delay: ${delayMs}ms | Success: ${successCount}/${editCount} | Rate limited: ${rateLimited ? 'YES' : 'NO'}`);
  } catch (e) {
    // Ignore cleanup errors
  }

  return {
    interval: delayMs,
    total: editCount,
    successCount,
    failCount,
    rateLimited,
    rateLimitResetTime,
    results
  };
}

async function main() {
  const intervals = [100, 200, 500, 1000];
  const sequentialSummary = [];
  const pipelinedSummary = [];

  console.log("=== RUNNING SEQUENTIAL TESTS (AWAITING EACH REQUEST) ===");
  for (const interval of intervals) {
    const res = await runTestForInterval(interval, 10);
    sequentialSummary.push(res);
    console.log(`Waiting 5 seconds cool down...`);
    await sleep(5000);
  }

  console.log("\n=== RUNNING PIPELINED TESTS (STRICT DELAY WITHOUT AWAIT) ===");
  for (const interval of intervals) {
    const res = await runPipelinedTest(interval, 10);
    pipelinedSummary.push(res);
    console.log(`Waiting 5 seconds cool down...`);
    await sleep(5000);
  }

  console.log(`\n======================================================`);
  console.log(`             FINAL RESULTS: SEQUENTIAL                `);
  console.log(`======================================================`);
  console.table(sequentialSummary.map(s => ({
    Interval: `${s.interval}ms`,
    Total: s.total,
    Success: s.successCount,
    Failed: s.failCount,
    "Rate Limited": s.rateLimited ? "YES" : "NO",
    "Retry After": s.rateLimitResetTime ? `${s.rateLimitResetTime}s` : "N/A"
  })));

  console.log(`\n======================================================`);
  console.log(`             FINAL RESULTS: PIPELINED                 `);
  console.log(`======================================================`);
  console.table(pipelinedSummary.map(s => ({
    Interval: `${s.interval}ms`,
    Total: s.total,
    Success: s.successCount,
    Failed: s.failCount,
    "Rate Limited": s.rateLimited ? "YES" : "NO",
    "Retry After": s.rateLimitResetTime ? `${s.rateLimitResetTime}s` : "N/A"
  })));
}

main().catch(console.error);
