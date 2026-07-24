/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file setup.ts
 * @description Interactive terminal setup wizard for configuring gemini-cli-telegram.
 * Guides the user through entering/verifying Telegram bot tokens via BotFather,
 * adding allowed Telegram user IDs (interactive or manual), and selecting default LLM models via terminal radio UI.
 */

import * as readline from 'node:readline';
import { Bot } from 'grammy';
import { getAvailableModels } from './agy/agyCli.js';
import {
  saveUserConfig,
  loadUserConfig,
  configExists,
  CONFIG_PATH,
  type UserConfig,
} from './config/userConfig.js';
const ICONS = {
  bot: '🤖', sparkles: '✨', loading: '⏳',
  success: '✅', error: '🚫', user: '👤',
};

/** Valid setup step identifier flags */
export type SetupStep = 'token' | 'users' | 'model' | 'auth';

/**
 * Prompts the user with a question via readline interface.
 */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function validateBotToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return data.ok ? (data.result?.username ?? null) : null;
  } catch {
    return null;
  }
}

async function setupToken(rl: readline.Interface): Promise<string> {
  console.log(`${ICONS.bot} <b>Telegram Bot Token</b>`);
  console.log('  1. Open Telegram and search for @BotFather');
  console.log('  2. Send /newbot and follow the prompts');
  console.log('  3. Copy the token and paste it here\n');

  while (true) {
    const token = await ask(rl, 'Bot token: ');
    if (!token) {
      console.log('Token is required.\n');
      continue;
    }
    console.log(`${ICONS.loading} Validating...`);
    const username = await validateBotToken(token);
    if (username) {
      console.log(`${ICONS.success} Verified: @${username}\n`);
      return token;
    }
    console.log(`${ICONS.error} Invalid token. Try again.\n`);
  }
}

async function setupUsers(rl: readline.Interface, token: string): Promise<number[]> {
  console.log(`${ICONS.user} <b>Allowed Users</b>`);
  console.log('  You can enter IDs manually or let the bot detect you.');
  console.log('  (Comma-separated IDs, or press Enter to use interactive detection)\n');

  const input = await ask(rl, 'User IDs (manual): ');
  if (input) {
    const users = input
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !isNaN(n) && n > 0);
    if (users.length > 0) {
      console.log(`${ICONS.success} Allowed users: ${users.join(', ')}\n`);
      return users;
    }
  }

  // Interactive detection
  console.log(`\n${ICONS.bot} <b>Interactive Detection Started</b>`);
  console.log(`  1. Open your bot in Telegram`);
  console.log(`  2. Send any message to it`);
  console.log(`  ${ICONS.loading} Waiting for message...\n`);

  const bot = new Bot(token);
  return new Promise((resolve) => {
    bot.on('message', async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) {
        console.log(`${ICONS.success} Detected User ID: <code>${userId}</code> (${ctx.from.first_name})`);
        await ctx.reply(`${ICONS.sparkles} <b>Setup: Authentication Successful</b>\n\nYour User ID <code>${userId}</code> has been whitelisted.\n\nYou can now finish the setup in your terminal.`);
        bot.stop();
        resolve([userId]);
      }
    });
    bot.start();
  });
}

function radioSelect(
  options: { label: string; value: string | undefined }[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let selected = 0;

    const render = () => {
      // Move cursor up to overwrite previous render (skip on first render)
      if (rendered) {
        process.stdout.write(`\x1b[${options.length}A`);
      }
      for (let i = 0; i < options.length; i++) {
        const marker = i === selected ? '◉' : '◯';
        const dim = i === selected ? '' : '\x1b[2m';
        const reset = '\x1b[0m';
        process.stdout.write(`\x1b[2K  ${dim}${marker} ${options[i]!.label}${reset}\n`);
      }
    };

    let rendered = false;
    render();
    rendered = true;

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();

      if (key === '\x1b[A' || key === 'k') {
        // Up arrow or k
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        // Down arrow or j
        selected = (selected + 1) % options.length;
        render();
      } else if (key === '\r' || key === '\n') {
        // Enter
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        const choice = options[selected]!;
        console.log(`\nSelected: ${choice.label}\n`);
        resolve(choice.value);
      } else if (key === '\x03') {
        // Ctrl+C
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        process.exit(0);
      }
    };

    stdin.on('data', onData);
  });
}

async function setupModel(rl: readline.Interface): Promise<{ model: string | undefined; rl: readline.Interface }> {
  console.log('Default Model');
  console.log('  Use ↑↓ to navigate, Enter to select.\n');

  // Close readline entirely to flush its buffer before raw mode
  rl.close();

  const models = await getAvailableModels();
  const options = [
    { label: 'Use Gemini CLI default', value: undefined as string | undefined },
    ...models.map((m) => {
      return { label: m, value: m as string | undefined };
    }),
  ];

  const model = await radioSelect(options);

  // Create a fresh readline for subsequent steps
  const newRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return { model, rl: newRl };
}

/**
 * Run the setup wizard.
 * If `only` is specified, only that step runs and the rest is preserved from existing config.
 * If `only` is undefined, runs all steps (full setup).
 */
export async function runSetup(only?: SetupStep): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('gemini-cli-telegram setup\n');

  const existing = loadUserConfig();

  // Full setup: confirm overwrite if config exists
  if (!only && configExists()) {
    const overwrite = await ask(rl, 'Config already exists. Overwrite? [y/N]: ');
    if (!['y', 'yes'].includes(overwrite.toLowerCase())) {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
    console.log();
  }

  // Single step with no existing config for required fields
  if (only && !existing) {
    console.log('No existing config. Run full setup first: gemini-cli-telegram setup');
    rl.close();
    return;
  }

  let currentRl = rl;

  const token = only === 'token' || only === 'auth' || !only
    ? await setupToken(currentRl)
    : existing!.telegramBotToken;

  const allowedUsers = only === 'users' || only === 'auth' || !only
    ? await setupUsers(currentRl, token)
    : existing!.allowedUsers;

  let model: string | undefined;
  if (only === 'model' || !only) {
    const result = await setupModel(currentRl);
    model = result.model;
    currentRl = result.rl;
  } else {
    model = existing?.model;
  }

  const config: UserConfig = {
    telegramBotToken: token,
    allowedUsers,
    ...(model && { model }),
  };

  saveUserConfig(config);
  currentRl.close();

  console.log(`Config saved to ${CONFIG_PATH}`);
}
