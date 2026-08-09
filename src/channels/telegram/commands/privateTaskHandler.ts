/**
 * @file privateTaskHandler.ts
 * @description Private-chat task commands (/translate /summarize /v). These
 * reuse the inline task prefix parser, model fallback chain, and output footer
 * so private chats get the same focused behaviors as inline mode. Unlike the
 * inline variant they reply directly into the chat as a normal message.
 */

import type { Bot, Context } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { logger } from '../../../utils/logger.js';
import { getDefaultModels } from '../../../config/userConfig.js';
import {
  parseInlineModelAndPrompt,
  runModelWithFallbackChain,
  type InlineTask,
} from './inlineHandler.js';

const PRIVATE_TASK: Record<string, InlineTask> = {
  translate: 'translate',
  summarize: 'summarize',
  v: 'compare',
};

const TASK_TITLES: Record<InlineTask, string> = {
  translate: '🌐 Translation Result',
  summarize: '📝 Content Summary',
  image: '🖼️ Image Generation',
  compare: '🔀 Model Comparison',
};

export function registerPrivateTaskHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): void {
  for (const [cmd, task] of Object.entries(PRIVATE_TASK)) {
    bot.command(cmd, async (ctx: Context) => {
      await handlePrivateTask(ctx, sessionManager, defaultOptions, task);
    });
  }
}

async function handlePrivateTask(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  task: InlineTask,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
  if (!chatId) return;

  const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (!arg) {
    await ctx
      .reply(`${TASK_TITLES[task]}: please provide content. E.g. /translate Hello world, or /summarize a paragraph.`)
      .catch(() => {});
    return;
  }

  // Reuse the shared prefix parser: pass `/task <payload>` so /p /@ /task
  // tokens are honored and the task instruction is injected automatically.
  const session = sessionManager.getSession(chatId, threadId);
  const availableProjects = sessionManager.getProjectsInConfigOrder() as any[];
  const defaultModel =
    session?.model || session?.config?.getModel?.() || defaultOptions.model || getDefaultModels()?.taskModel || '';

  const parsed = parseInlineModelAndPrompt(`/${task} ${arg}`, defaultModel, availableProjects);
  const targetProjectPath = parsed.projectUsed?.path ?? session?.currentProject?.path ?? defaultOptions.cwd;

  logger.info(
    `[PrivateTask] chatId=${chatId} cmd=${task} model=${parsed.model} prompt="${parsed.prompt.slice(0, 40)}..." project="${parsed.projectUsed?.name || 'default'}"`,
  );

  await ctx.replyWithChatAction('typing').catch(() => {});

  try {
    const { result, modelUsed } = await runModelWithFallbackChain(
      parsed.prompt,
      parsed.model,
      defaultOptions,
      undefined,
      targetProjectPath,
    );

    if (!result?.output) {
      await ctx.reply(`${TASK_TITLES[task]} <b>failed</b>\nThe model returned no result, please retry.`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    const cleanOutput = stripWholeMessageCodeFence(result.output).trim();
    const displayPrompt = arg.length > 300 ? arg.slice(0, 300) + '...' : arg;
    const duration = ((result.durationMs || 1000) / 1000).toFixed(1);

    const footerParts: string[] = [`⏱️ ${duration}s`];
    const inCount = result.usage?.input || 0;
    const outCount = result.usage?.output || 0;
    if (inCount) footerParts.push(`📥 In: ${inCount}`);
    if (outCount) footerParts.push(`📤 Out: ${outCount}`);

    const reply =
      `**${TASK_TITLES[task]}**\n\n` +
      `**📌 Input:** ${displayPrompt}\n\n` +
      `**🤖 Output (${modelUsed}):**\n\n${cleanOutput}\n\n` +
      `_${footerParts.join(' · ')}_`;

    await ctx.reply(reply, { parse_mode: 'MarkdownV2' }).catch(async () => {
      await ctx.reply(reply).catch(() => {});
    });
    logger.info(`[${task}] Delivered result (${cleanOutput.length} chars) to chatId=${chatId}`);
  } catch (e) {
    logger.error(`[PrivateTask] ${task} failed for chatId=${chatId}: ${e}`);
    await ctx.reply(`${TASK_TITLES[task]} <b>failed</b>\nPlease try again later.`, { parse_mode: 'HTML' }).catch(() => {});
  }
}