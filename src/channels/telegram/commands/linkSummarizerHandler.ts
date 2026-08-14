/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file linkSummarizerHandler.ts
 * @description Smart Link and Article Summarizer handler for Telegram.
 */

import type { Bot, Context } from 'grammy';
import { parseUrlContent, extractFirstUrl } from '../../../tools/urlParser/urlParser.js';
import type { ParsedLinkContent } from '../../../tools/urlParser/types.js';
import { runModelWithFallbackChain } from './inlineHandler.js';
import { buildChannelReply } from '../bot/channelReply.js';
import { ICONS } from '../ui.js';
import { logger } from '../../../utils/logger.js';

/**
 * Generates an AI-powered structured summary tailored to the link's domain.
 */
export async function generateLinkSummary(
  parsed: ParsedLinkContent,
  options?: {
    model?: string;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  }
): Promise<{ markdown: string; modelUsed?: string }> {
  let domainPromptGuide = '';

  switch (parsed.type) {
    case 'arxiv':
      domainPromptGuide = `
【学术论文精读要求】
请针对这篇前沿学术论文出具深度精读报告：
1. 🎯 **研究动机与核心痛点 (Motivation & Problem)**：该论文旨在解决学术界/业界的什么关键问题？既有方案有何瓶颈？
2. 💡 **核心方法论与架构创新 (Core Methodology & Novelty)**：提出了什么新的模型/算法/架构机制？核心工作流程是什么？
3. 📊 **实验结果与关键指标 (Key Findings & Benchmarks)**：在哪些基准测试上取得了提升？相较 SOTA 的关键对比数据？
4. ⚠️ **局限性与未来展望 (Limitations & Future Work)**：作者指出的不足或计算开销？适用场景与落地启示？
`;
      break;

    case 'github':
      domainPromptGuide = `
【开源项目架构分析要求】
请针对此 GitHub 开源仓库出具技术架构与项目速览：
1. 🚀 **项目定位与解决痛点**：该项目的核心价值是什么？适合解决什么业务/技术场景？
2. 🛠️ **核心特性与技术栈**：主语言、依赖的关键框架、主要功能亮点。
3. 📦 **上手成本与架构设计**：部署与运行复杂度、架构模块划分。
4. ⚖️ **与同类项目对比/选型建议**：适合哪些开发者或团队采用？
`;
      break;

    case 'twitter':
      domainPromptGuide = `
【推文深度脉络速读要求】
1. 📌 **核心观点/要点速览 (TL;DR)**
2. 🔍 **论据与背景脉络剖析**
3. 💬 **行业反响与核心启示**
`;
      break;

    case 'weixin':
    case 'zhihu':
    case 'web':
    default:
      domainPromptGuide = `
【深度文章/长文精读要求】
1. 📌 **核心主旨与一句话总结 (TL;DR)**
2. 🔍 **核心论点与论据脉络拆解 (Key Highlights)**：梳理文章最核心的 3~5 个论点与关键案例/数据。
3. 💡 **核心洞察与作者独到见解 (Key Insights)**：文章最具启发性的观点或思维模型。
4. 🎯 **行动指南与实践启示 (Actionable Takeaways)**：对读者有何指导意义或下一步建议？
`;
      break;
  }

  const prompt = `你是一位顶尖的技术研究员与专业文献分析师。请对以下抓取到的内容进行深度、结构化、清晰且精炼的精读与总结。

${domainPromptGuide}

【原文内容】
${parsed.content}

【格式要求】
- 使用清晰的 Markdown 标题与结构，排版专业优美。
- 提炼精髓，杜绝废话，保留关键术语与重要数据指标。
- 语言统一使用中文。`;

  const initialModel = options?.model || 'Gemini 3.7 Flash (High)';
  logger.info(`[LinkSummarizer] Summarizing URL="${parsed.url}" type="${parsed.type}" using model ${initialModel}`);

  const runResult = await runModelWithFallbackChain({
    prompt,
    initialModel,
    signal: options?.signal,
    onChunk: options?.onChunk,
    customTimeoutMs: 60_000,
  });

  const output = runResult.result?.output?.trim();
  if (!output) {
    return {
      markdown: `## 🌐 ${parsed.title}\n\n**原文链接**: ${parsed.url}\n\n_未能成功生成 AI 精读摘要（模型响应超时或内容过长），请点击原文查看。_`,
      modelUsed: runResult.modelUsed,
    };
  }

  return {
    markdown: output,
    modelUsed: runResult.modelUsed,
  };
}

/**
 * Handles link summarization workflow from a Telegram command or direct URL message.
 */
export async function handleLinkSummarizeWorkflow(
  ctx: Context,
  urlStr: string,
  model?: string
): Promise<void> {
  const reply = buildChannelReply(ctx, ctx.chat?.id || ctx.from?.id || 0, 'RichText');
  await reply.sendRichMessage(`${ICONS.working} 正在抓取并解析链接内容：\`${urlStr.slice(0, 50)}...\``);

  try {
    const parsed = await parseUrlContent(urlStr);
    const typeLabel =
      parsed.type === 'arxiv' ? '📄 ArXiv 论文' :
      parsed.type === 'github' ? '💻 GitHub 仓库' :
      parsed.type === 'weixin' ? '📱 微信公众号' :
      parsed.type === 'zhihu' ? '💡 知乎专栏' :
      parsed.type === 'twitter' ? '🐦 X/Twitter' : '🌐 网页文章';

    await reply.editRichMessage(
      `${ICONS.working} 已成功解析 **${typeLabel}**：《${parsed.title}》\n正在全力进行 AI 深度精读提炼...`
    );

    const summaryResult = await generateLinkSummary(parsed, {
      model,
      onChunk: (chunk) => {
        reply.streamRichMessage(chunk).catch(() => {});
      },
    });

    await reply.editRichMessage(summaryResult.markdown);
  } catch (err) {
    logger.error(`[LinkSummarizer] Failed to summarize ${urlStr}: ${err}`);
    await reply.editRichMessage(`❌ 链接解析或精读失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Registers /read and /summary slash commands on the bot.
 */
export function registerLinkSummarizerCommands(bot: Bot): void {
  bot.command(['read', 'summary'], async (ctx) => {
    const rawText = ctx.message?.text?.trim() || '';
    const url = extractFirstUrl(rawText);

    if (!url) {
      await ctx.reply(
        '📖 **智能链接精读使用指南**\n\n' +
        '支持直接发送或配合 `/read` 发送以下主流平台链接：\n' +
        '• 📄 **ArXiv 论文**：`/read https://arxiv.org/abs/2403.xxxxx`\n' +
        '• 💻 **GitHub 仓库**：`/read https://github.com/owner/repo`\n' +
        '• 📱 **微信公众号**：`/read https://mp.weixin.qq.com/s/...`\n' +
        '• 💡 **知乎专栏/问答**：`/read https://zhuanlan.zhihu.com/p/...`\n' +
        '• 🐦 **X/Twitter**：`/read https://x.com/.../status/...`\n' +
        '• 🌐 **通用任意网页**：`/read https://example.com/article`\n\n' +
        '_AI 将自动抓取纯净正文并输出结构化精读报告！_',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await handleLinkSummarizeWorkflow(ctx, url);
  });
}
