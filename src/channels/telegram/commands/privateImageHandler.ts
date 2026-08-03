/**
 * @file privateImageHandler.ts
 * @description Private-chat /img image generation. Reuses the inline task
 * prefix parser, model fallback chain, and artifact scanner so private chats
 * can generate images with the same behavior as inline mode. Unlike inline
 * messages, private chats can upload the generated file directly (no relay).
 */

import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import { logger } from '../../../utils/logger.js';
import {
  parseInlineModelAndPrompt,
  runModelWithFallbackChain,
  findNewImageArtifacts,
  IMAGE_TASK_INSTRUCTION,
  MAX_COLLAGE_IMAGES,
} from './inlineHandler.js';

const IMG_RE = /^\s*\/img(?:@\w+)?(?:\s+(.*))?$/s;

export function isPrivateImageRequest(text: string): boolean {
  return IMG_RE.test(text);
}

/**
 * Handle a private-chat /img request. Parses the prompt, runs the model,
 * scans for the freshly generated artifact, and sends it as a rich message
 * straight into the current chat.
 *
 * @returns true if the request was handled as an image generation.
 */
export async function handlePrivateImageRequest(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
): Promise<boolean> {
  const text = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!text || !chatId) return false;
  const match = text.match(IMG_RE);
  if (!match) return false;

  const rawPrompt = (match[1] ?? '').trim();
  if (!rawPrompt) {
    await ctx.reply('🖼️ 请提供图片提示词：<code>/img 一只赛博朋克风格的猫</code>', { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }

  const session = sessionManager.getSession(chatId);
  const availableProjects = sessionManager.getProjectsInConfigOrder() as any[];
  const defaultModel = session?.model
    || session?.config?.getModel?.()
    || defaultOptions.model
    || 'Gemini 3.5 Flash';

  const parsed = parseInlineModelAndPrompt(rawPrompt, defaultModel, availableProjects);
  const targetProjectPath = parsed.projectUsed?.path ?? session?.currentProject?.path ?? defaultOptions.cwd;
  const imagePrompt = `${IMAGE_TASK_INSTRUCTION}${parsed.prompt}`;

  logger.info(`[PrivateImage] chatId=${chatId} model=${parsed.model} prompt="${parsed.prompt.slice(0, 40)}..." project="${parsed.projectUsed?.name || 'default'}"`);

  await ctx.replyWithChatAction('upload_photo').catch(() => {});

  try {
    const { result, modelUsed } = await runModelWithFallbackChain(
      imagePrompt,
      parsed.model,
      defaultOptions,
      undefined,
      targetProjectPath,
    );

    if (!result?.conversationId) {
      await ctx.reply('🎨 <b>图像生成失败</b>\n模型未返回会话信息，请重试。', { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    const images = await findNewImageArtifacts(result.conversationId, Date.now() - (result.durationMs || 60_000));
    if (images.length === 0) {
      const output = (result.output || '').trim();
      await ctx.reply(`🎨 图像生成完成，但未发现图片文件。\n\n${output || '模型未生成图片文件。'}`, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    // Chunk into collages of MAX_COLLAGE_IMAGES so more than 10 photos still
    // render (each chunk becomes its own <tg-collage> block in one message).
    const chunks: string[][] = [];
    for (let i = 0; i < images.length; i += MAX_COLLAGE_IMAGES) {
      chunks.push(images.slice(i, i + MAX_COLLAGE_IMAGES));
    }
    const displayPrompt = parsed.prompt.length > 300 ? parsed.prompt.slice(0, 300) + '...' : parsed.prompt;
    const caption = `**🎨 图片生成完成**\n\n**💬 提示词：** ${displayPrompt}\n\n_模型: ${modelUsed} · 共 ${images.length} 张_`;
    // Each collage references its photos via tg://photo?id=, with matching media.
    const collageMarkdown = chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![生成的图片](tg://photo?id=c${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n');
    const media = chunks.flatMap((chunk, ci) =>
      chunk.map((imgPath, i) => ({
        id: `c${ci}_${i}`,
        media: { type: 'photo' as const, media: new InputFile(imgPath) },
      })),
    );

    await ctx.api.sendRichMessage(chatId, {
      markdown: `${collageMarkdown}\n\n${caption}`,
      media,
    });
    logger.info(`[PrivateImage] Sent ${images.length} generated image(s) in ${chunks.length} collage(s) to chatId=${chatId}`);
    return true;
  } catch (e) {
    logger.error(`[PrivateImage] Failed to generate image for chatId=${chatId}: ${e}`);
    await ctx.reply('🎨 <b>图像生成失败</b>\n请稍后重试。', { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }
}
