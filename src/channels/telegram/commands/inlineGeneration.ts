/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file inlineGeneration.ts
 * @description Inline answer generation engine (extracted from
 * inlineHandler.ts): runs the model fallback chain for one inline result,
 * finalizes the rich card (truncation, footer, full-doc button), and renders
 * image-task results via a transient rich-message upload relay.
 */

import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import * as path from 'node:path';
import type { SessionManager } from '../../../core/session.js';
import type { SessionOptions } from '../../../core/types.js';
import type { AgyRunResult } from '../../../agy/types.js';
import { extractThoughtAndContent } from '../../../agy/agyCli.js';
import { formatTokenCount } from '../formatter/core.js';
import { buildFinalBlocks } from '../formatter/blocks.js';
import { calculateCost, estimateTokens } from '../../../utils/pricing.js';
import { displayModelName } from '../../../core/modelRegistry.js';
import { stripWholeMessageCodeFence } from '../../../core/messageLoop/textUtils.js';
import { logger } from '../../../utils/logger.js';
import { regenerateContexts, fullInlineOutputs } from './inlineContext.js';
import {
  runModelWithFallbackChain,
  editInlineMessage,
  editInlineReplyMarkup,
  findNewImageArtifacts,
} from './inlineShared.js';
import { stripInlineImages } from './inlineStreamQueue.js';
import { MAX_COLLAGE_IMAGES, type InlineTask } from './inlineModelMatch.js';
import type { InlineStreamQueue } from './inlineStreamQueue.js';

interface InlineGenerationContext {
  resultId: string;
  inlineMessageId: string;
  fromId: number;
  prompt: string;
  model: string;
  projectPath?: string;
  task?: InlineTask;
  ctrl: AbortController;
  streamQueue: InlineStreamQueue;
  onModelStart: (modelName: string) => void;
  onChunk: (chunk: string) => void;
  onEvent?: (event: { type: 'thought' | 'text' | 'done'; content?: string }) => void;
  inlineThinkingStreaming: boolean;
  /** Allow the model to auto-approve tools (web fetch / file read). Only set for /invest. */
  allowTools?: boolean;
  /** Returns the text streamed so far; used to preserve partial output on manual stop. */
  getPartialOutput?: () => string;
}

export async function runInlineGeneration(
  ctx: Context,
  sessionManager: SessionManager,
  defaultOptions: SessionOptions,
  gctx: InlineGenerationContext,
): Promise<void> {
  const {
    resultId, inlineMessageId, fromId, prompt, model, projectPath,
    task, ctrl, streamQueue, onModelStart, onChunk, onEvent, allowTools, getPartialOutput, inlineThinkingStreaming,
  } = gctx;

  // Keep regenerate context alive so the 🔄 button can re-run this prompt.
  regenerateContexts.set(resultId, {
    prompt,
    model,
    projectPath,
    fromId,
    inlineMessageId,
    task,
    createdAt: Date.now(),
  });

  const { result, modelUsed, isFallback } = await runModelWithFallbackChain(
    prompt,
    model,
    defaultOptions,
    ctrl.signal,
    projectPath,
    onChunk,
    onModelStart,
    allowTools,
    onEvent,
  );

  // Remote media backends (Qwen t2i/t2v) hand their artifacts back as local
  // files on result.mediaFiles with the URL stripped from the text — render
  // those before the generic empty-output handling rejects the turn.
  if (result?.mediaFiles?.length) {
    await finalizeMediaResult(ctx, resultId, inlineMessageId, fromId, prompt, result, modelUsed);
    return;
  }

  if (task === 'image') {
    await finalizeImageResult(ctx, resultId, inlineMessageId, fromId, prompt, result, modelUsed);
    return;
  }

  if (result?.output) {
    const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

    const parsedOutput = extractThoughtAndContent(stripWholeMessageCodeFence(result.output));
    let finalThought = inlineThinkingStreaming ? parsedOutput.thought.trim() : '';
    // OpenCode can finish with a reasoning-only envelope even though its live
    // text events already delivered the answer. Preserve that answer buffer.
    const streamedContent = getPartialOutput?.().trim() ?? '';
    let cleanOutput = stripInlineImages(
      parsedOutput.content.trim() || streamedContent,
      'invalid-only',
    );
    if (!cleanOutput.trim()) {
      // Model returned reasoning only, no answer body (or an empty envelope).
      // Show a proper notice instead of flushing an empty card that Telegram
      // rejects with RICH_MESSAGE_EMPTY.
      const reasonText = ctrl.signal.aborted
        ? '⏹ **生成已停止**'
        : '⚠️ **未能生成有效回答**\n模型仅返回了推理过程而无正文内容，请重试。';
      const emptyMarkdown = `**💬 问题：** ${displayPrompt}\n\n${reasonText}\n\n_💡 提示：您可以点击下方按钮重新尝试。_`;
      await streamQueue.flushFinal(emptyMarkdown, {
        inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
      });
      return;
    }
    // Rich messages cap total text at 32768 UTF-8 chars (server-side limit).
    // Cap the thinking/body folds so the final edit always fits even after
    // markdown→blocks conversion overhead. The full answer stays available
    // via the /start full_<id> deep link (fullInlineOutputs).
    const INLINE_THOUGHT_MAX = 8000;
    const INLINE_BODY_MAX = 21000;
    if (finalThought.length > INLINE_THOUGHT_MAX) {
      finalThought = finalThought.slice(0, INLINE_THOUGHT_MAX) + '\n\n…(思考过程过长已截断)';
    }
    const truncated = cleanOutput.length > INLINE_BODY_MAX;
    if (truncated) {
      cleanOutput = cleanOutput.slice(0, INLINE_BODY_MAX) + `\n\n…(回答过长已截断，完整内容可用 /start full_${resultId} 查看)`;
    }
    const rawOutputLen = cleanOutput.length;

    let footerParts: string[] = [];
    footerParts.push(`⏱️ ${((result.durationMs || 1000) / 1000).toFixed(1)}s`);
    
    const inCount = result.usage?.input || estimateTokens(prompt);
    const outCount = result.usage?.output || estimateTokens(cleanOutput);
    const cachedCount = result.usage?.cached || 0;
    const thinkingCount = result.usage?.thinking || 0;
    const estLabel = !result.usage ? ' (estimated)' : '';

    if (inCount) footerParts.push(`📥 In: ${formatTokenCount(inCount)}${estLabel}`);
    if (outCount) footerParts.push(`📤 Out: ${formatTokenCount(outCount)}${estLabel}`);
    const totalTokens = inCount + outCount;
    if (totalTokens > 0) {
      let tokenStr = `🪙 ${formatTokenCount(totalTokens)} tokens`;
      const { totalCost, currency } = calculateCost(modelUsed, inCount, outCount, cachedCount, thinkingCount);
      if (totalCost > 0) {
        const sym = currency === 'CNY' ? '¥' : '$';
        const costStr = totalCost < 0.0001 ? '<0.0001' : totalCost.toFixed(5);
        tokenStr += ` (${sym}${costStr})`;
      }
      footerParts.push(tokenStr);
    }
    const footerText = footerParts.join(' · ');

    // Keep the Markdown payload as a fallback, but finalize through native 10.2
    // blocks below: details for thinking, body blocks for the answer, and the
    // official footer block for usage/cost metadata.
    const summaryTitle = `💡 Click to expand full answer (${rawOutputLen} chars)`;
    const foldedBody = `<details><summary>${summaryTitle}</summary>\n\n${cleanOutput}\n\n</details>`;
    const fullMarkdown = `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${displayModelName(modelUsed)}):**\n\n${finalThought ? `<details><summary>🧠 Thinking Process</summary>\n\n${finalThought}\n\n</details>\n\n` : ''}${foldedBody}${footerText ? `\n\n_${footerText}${isFallback ? ' (auto-downgraded)' : ''}_` : ''}`;
    const replyMarkup = {
      inline_keyboard: [[
        { text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` },
        ...(truncated ? [{ text: '📄 完整文档', callback_data: `inline_full_doc:${resultId}` }] : []),
      ]],
    };

    logger.info(`[InlineResult] Submitting final flush edit: userId=${fromId} rawOutputLen=${rawOutputLen} fullMarkdownLen=${fullMarkdown.length}`);

    const finalBlocks = buildFinalBlocks(
      `**💬 Question:** ${displayPrompt}\n\n**🤖 Answer (${displayModelName(modelUsed)}):**\n\n${cleanOutput}`,
      finalThought,
      {
        bodySummary: summaryTitle,
        footerText: footerText ? `${footerText}${isFallback ? ' (auto-downgraded)' : ''}` : undefined,
      },
    );
    const success = await streamQueue.flushFinal(fullMarkdown, replyMarkup, finalBlocks);
    if (success) {
      logger.info(`[InlineResult] Successfully flushed final inline message: inline_message_id=${inlineMessageId} userId=${fromId}`);
      // Store the full answer so /start full_<id> can surface it (inline cards
      // may be truncated to fit rich-message limits).
      fullInlineOutputs.set(resultId, {
        prompt,
        output: cleanOutput,
        model: modelUsed,
        createdAt: Date.now(),
      });
      // If the server rejected the full payload and the runtime fallback had
      // to truncate (lastEditTruncated), the pre-check above did not attach
      // the document button — add it via a markup-only edit now.
      if (!truncated && streamQueue.lastEditTruncated) {
        await editInlineReplyMarkup(ctx.api, {
          inline_message_id: inlineMessageId,
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` },
              { text: '📄 完整文档', callback_data: `inline_full_doc:${resultId}` },
            ]],
          },
        }).catch((e: Error) => logger.warn(`[InlineResult] Attach full-doc button failed: ${e}`));
      }
    } else {
      logger.error(`[InlineResult] Final inline flush FAILED: inline_message_id=${inlineMessageId} userId=${fromId} rawOutputLen=${rawOutputLen} fullMarkdownLen=${fullMarkdown.length} truncated=${truncated}`);
    }
  } else {
    const wasStopped = ctrl.signal.aborted;
    const isTimeoutErr = result?.isTimeout;
    const displayPrompt = prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt;

    let reasonText: string;
    if (wasStopped) {
      reasonText = '⏹ **生成已停止**';
    } else if (isTimeoutErr) {
      reasonText = '⏱️ **响应超时**\n后端模型装载或网络代理建立连接超时，请稍后重试。';
    } else {
      reasonText = '⚠️ **未能生成有效回答**\n模型通道未返回有效文本（可能是 API 配额受限或网络断开）。';
    }

    // On manual stop, keep whatever was already streamed and fold it into a
    // native `<details>` block so nothing is lost but the card stays compact.
    // Flushed through streamQueue (markdown path) so queued streaming frames
    // can never overwrite this notice afterwards, and the Stop keyboard is
    // replaced by the Regenerate button.
    const partialRaw = getPartialOutput?.() ?? '';
    const partialClean = wasStopped && partialRaw.trim().length > 0 ? stripWholeMessageCodeFence(partialRaw) : '';
    const partialBlock = partialClean
      ? `\n\n<details><summary>💡 Click to expand partial answer (${partialClean.length} chars)</summary>\n\n${partialClean}\n\n</details>`
      : '';

    const failMarkdown = `**💬 问题：** ${displayPrompt}\n\n${reasonText}${partialBlock}\n\n_💡 提示：您可以点击下方按钮重新尝试。_`;
    const replyMarkup = {
      inline_keyboard: [[
        { text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }
      ]],
    };
    await streamQueue.flushFinal(failMarkdown, replyMarkup);
  }
}

/**
 * Relay-uploads local image files through a transient rich-message collage in
 * the user's private chat and returns the largest photo file_id for each.
 * Inline messages can only reference media via a URL or an existing file_id,
 * so this relay is how local artifacts become inline-renderable.
 */
async function relayUploadPhotos(ctx: Context, fromId: number, images: string[]): Promise<string[]> {
  const fileIds: string[] = [];
  if (images.length === 0) return fileIds;
  // Chunk into collages of MAX_COLLAGE_IMAGES so >10 photos still render.
  const chunks: string[][] = [];
  for (let i = 0; i < images.length; i += MAX_COLLAGE_IMAGES) {
    chunks.push(images.slice(i, i + MAX_COLLAGE_IMAGES));
  }
  let relayMessageId: number | null = null;
  try {
    const relayMarkdown = chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=r${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n');
    const relayMedia = chunks.flatMap((chunk, ci) =>
      chunk.map((imgPath, i) => ({ id: `r${ci}_${i}`, media: { type: 'photo' as const, media: new InputFile(imgPath) } })),
    );
    const sentMsg = await ctx.api.sendRichMessage(fromId, {
      markdown: `${relayMarkdown}\n\n*uploading relay...*`,
      media: relayMedia,
    });
    relayMessageId = sentMsg?.message_id ?? null;
    // Collect photo blocks recursively (they may be nested inside a collage block).
    interface RelayPhotoSize {
      file_id: string;
      file_size?: number;
    }
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    const collectPhotos = (blocks: unknown, out: RelayPhotoSize[][]): void => {
      if (!Array.isArray(blocks)) return;
      for (const rawBlock of blocks) {
        if (!isRecord(rawBlock)) continue;
        if (rawBlock['type'] === 'photo' && Array.isArray(rawBlock['photo'])) {
          const sizes = rawBlock['photo'].filter((size): size is RelayPhotoSize =>
            isRecord(size) && typeof size['file_id'] === 'string',
          ).map((size) => ({
            file_id: size['file_id'],
            file_size: typeof size['file_size'] === 'number' ? size['file_size'] : undefined,
          }));
          out.push(sizes);
        }
        collectPhotos(rawBlock['blocks'], out);
      }
    };
    const photoBlocks: RelayPhotoSize[][] = [];
    collectPhotos(sentMsg?.rich_message?.blocks, photoBlocks);
    for (const sizes of photoBlocks) {
      const largest = sizes.slice().sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
      if (largest?.file_id) fileIds.push(largest.file_id);
    }
    logger.info(`[InlineResult] Uploaded ${fileIds.length}/${images.length} image(s) via rich-message relay`);
  } catch (e) {
    logger.error(`[InlineResult] Failed to relay-upload images: ${e}`);
  } finally {
    // Remove the transient relay copy so the images are only shown in the inline message.
    if (relayMessageId != null) {
      await ctx.api.deleteMessage(fromId, relayMessageId).catch(() => {});
    }
  }
  return fileIds;
}

/**
 * Renders result.mediaFiles in-place for remote media backends (Qwen t2i/t2v):
 * they download the generated asset to a local temp file and strip the URL
 * from the text, so the answer body is empty and the artifacts only exist as
 * local paths on result.mediaFiles.
 *
 * Inline edits cannot upload new files (editMessageText's rich_message spec:
 * "Direct upload of new files isn't supported when an inline message is
 * edited"), so every artifact is first relay-uploaded in the user's private
 * chat to obtain a file_id. Photos go through the collage relay; videos are
 * sent via sendVideo. The file_ids are then rendered in one rich_message whose
 * media array mixes InputMediaPhoto/Video — the same transport the local
 * image-artifact path uses, so editMessageMedia (single-media only) isn't needed.
 */
async function finalizeMediaResult(
  ctx: Context,
  resultId: string,
  inlineMessageId: string,
  fromId: number,
  prompt: string,
  result: AgyRunResult,
  modelUsed: string,
): Promise<void> {
  const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
  const media = result.mediaFiles ?? [];
  const photos = media.filter((f) => f.type === 'photo');
  const videos = media.filter((f) => f.type === 'video');
  const regenButton = {
    inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
  };
  const caption = `**💬 Prompt:** ${displayPrompt}\n\n_Model: ${displayModelName(modelUsed)} · ${media.length} media file(s)_`;

  const photoFileIds = await relayUploadPhotos(ctx, fromId, photos.map((f) => f.path)).catch(() => [] as string[]);
  const videoFileIds: string[] = [];
  for (const v of videos) {
    try {
      const sent = await ctx.api.sendVideo(fromId, new InputFile(v.path));
      if (sent?.video?.file_id) videoFileIds.push(sent.video.file_id);
    } catch (e) {
      logger.warn(`[InlineResult] Video relay upload failed (${v.path}): ${e}`);
    }
  }

  if (photoFileIds.length + videoFileIds.length > 0) {
    // Media blocks live on their own line: photos as collages of up to
    // MAX_COLLAGE_IMAGES, each video as a standalone block.
    const photoChunks: string[][] = [];
    for (let i = 0; i < photoFileIds.length; i += MAX_COLLAGE_IMAGES) {
      photoChunks.push(photoFileIds.slice(i, i + MAX_COLLAGE_IMAGES));
    }
    const richMarkdown = [
      ...photoChunks.map((chunk, ci) =>
        `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=p${ci}_${i})`).join('\n')}\n</tg-collage>`),
      ...videoFileIds.map((_, i) => `![](tg://video?id=v${i})`),
      `\n${caption}\n\n_🖼️ Media generated, tap 🔄 to regenerate._`,
    ].join('\n\n');
    const mediaArr = [
      ...photoChunks.flatMap((chunk, ci) =>
        chunk.map((fileId, i) => ({ id: `p${ci}_${i}`, media: { type: 'photo' as const, media: fileId } }))),
      ...videoFileIds.map((fileId, i) => ({ id: `v${i}`, media: { type: 'video' as const, media: fileId } })),
    ];
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: { markdown: richMarkdown, media: mediaArr },
      reply_markup: regenButton,
    }).catch(async (e: Error) => {
      logger.error(`[InlineResult] rich_message media edit failed, falling back to text: ${e}`);
      await editInlineMessage(ctx.api, {
        inline_message_id: inlineMessageId,
        rich_message: { markdown: `**🖼️ Media generated**\n\n${caption}\n\n_⚠️ In-place rendering failed._` },
        reply_markup: regenButton,
      }).catch(() => {});
    });
    return;
  }

  // Nothing relayed (e.g. user never DMed the bot): describe as text.
  const filesText = media.map((f) => path.basename(f.path)).join(', ');
  await editInlineMessage(ctx.api, {
    inline_message_id: inlineMessageId,
    rich_message: { markdown: `**🖼️ Media generated**\n\n${caption}\n\n_⚠️ Could not render via upload (message the bot first to enable DM)_\n\n_Files: ${filesText}_` },
    reply_markup: regenButton,
  }).catch(() => {});
}

async function finalizeImageResult(
  ctx: Context,
  resultId: string,
  inlineMessageId: string,
  fromId: number,
  prompt: string,
  result: AgyRunResult | null,
  modelUsed: string,
): Promise<void> {
  const displayPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;

  if (!result?.conversationId) {
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      text: `<b>🎨 Image generation failed</b>\nThe model returned no session info, please retry.`,
      parse_mode: 'HTML',
    }).catch(() => {});
    return;
  }

  const images = await findNewImageArtifacts(result.conversationId, Date.now() - (result.durationMs || 60_000));
  if (images.length === 0) {
    const output = (result.output || '').trim();
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: {
        markdown: `**🎨 Image generation result**\n\n**💬 Prompt:** ${displayPrompt}\n\n${output || 'The model did not generate image files.'}`,
      },
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
      },
    }).catch(() => {});
    return;
  }

  // Inline messages can only reference media via a URL or an existing
  // file_id (no local upload) — relay through the user's private chat.
  const fileIds = await relayUploadPhotos(ctx, fromId, images);

  const caption = `**💬 Prompt:** ${displayPrompt}\n\n_Model: ${displayModelName(modelUsed)} · ${images.length} image(s) total_`;
  const regenButton = {
    inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `inline_regenerate:${resultId}` }]],
  };

  if (fileIds.length > 0) {
    // Render all images in-place as collages via rich_message: the markdown
    // references each attached photo through tg://photo?id=, with the actual
    // media supplied in the media array. editMessageMedia cannot carry
    // rich_message, so editMessageText is the correct transport here.
    const chunks: string[][] = [];
    for (let i = 0; i < fileIds.length; i += MAX_COLLAGE_IMAGES) {
      chunks.push(fileIds.slice(i, i + MAX_COLLAGE_IMAGES));
    }
    const richMarkdown = `${chunks
      .map((chunk, ci) => `<tg-collage>\n${chunk.map((_, i) => `![generated image](tg://photo?id=med${ci}_${i})`).join('\n')}\n</tg-collage>`)
      .join('\n\n')}\n\n${caption}\n\n_🖼️ Image generated, tap 🔄 to regenerate._`;
    const media = chunks.flatMap((chunk, ci) =>
      chunk.map((fileId, i) => ({ id: `med${ci}_${i}`, media: { type: 'photo' as const, media: fileId } })),
    );
    await editInlineMessage(ctx.api, {
      inline_message_id: inlineMessageId,
      rich_message: {
        markdown: richMarkdown,
        media,
      },
      reply_markup: regenButton,
    }).catch((e: Error) => {
      logger.error(`[InlineResult] rich_message media edit failed, falling back to text: ${e}`);
      const fallbackText = `**🖼️ Image generated**\n\n${caption}\n\n_⚠️ In-place rendering failed._`;
      return editInlineMessage(ctx.api, {
        inline_message_id: inlineMessageId,
        rich_message: { markdown: fallbackText },
        reply_markup: regenButton,
      }).catch(() => {});
    });
    return;
  }

  // No file_id (relay upload failed): describe the images as text.
  const filesText = images.map((p) => path.basename(p)).join(', ');
  const finalText = `**🖼️ Image generated**\n\n${caption}\n\n_⚠️ Could not render via upload (message the bot first to enable DM)_\n\n_Files: ${filesText}_`;
  await editInlineMessage(ctx.api, {
    inline_message_id: inlineMessageId,
    rich_message: { markdown: finalText },
    reply_markup: regenButton,
  }).catch(() => {});
}

export function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
