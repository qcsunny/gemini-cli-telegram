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
import { getDefaultModel } from '../../../config/userConfig.js';
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
    await ctx.reply('🖼️ Please provide an image prompt: <code>/img a cyberpunk-style cat</code>', { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }

  const session = sessionManager.getSession(chatId);
  const availableProjects = sessionManager.getProjectsInConfigOrder() as any[];
  const defaultModel = session?.model
    || session?.config?.getModel?.()
    || defaultOptions.model
    || getDefaultModel()
    || '';

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
      await ctx.reply('🎨 <b>Image generation failed</b>\nThe model returned no session info, please retry.', { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    const images = await findNewImageArtifacts(result.conversationId, Date.now() - (result.durationMs || 60_000));
    if (images.length === 0) {
      const output = (result.output || '').trim();
      await ctx.reply(`🎨 Image generation completed, but no image files were found.\n\n${output || 'The model did not generate image files.'}`, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    // Chunk into collages of MAX_COLLAGE_IMAGES so more than 10 photos still
    // render (each chunk becomes its own <tg-collage> block in one message).
    const chunks: string[][] = [];
    for (let i = 0; i < images.length; i += MAX_COLLAGE_IMAGES) {
      chunks.push(images.slice(i, i + MAX_COLLAGE_IMAGES));
    }
    const displayPrompt = parsed.prompt.length > 300 ? parsed.prompt.slice(0, 300) + '...' : parsed.prompt;
    const caption = `**🎨 Image generation complete**\n\n**💬 Prompt:** ${displayPrompt}\n\n_Model: ${modelUsed} · ${images.length} image(s) in total_`;
    // Each collage references its photos via tg://photo?id=, with matching media.
    const collageMarkdown = chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=c${ci}_${i})`).join('\n')}\n</tg-collage>`)
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
    await ctx.reply('🎨 <b>Image generation failed</b>\nPlease try again later.', { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }
}
