/**
 * @file geminiDirect.ts
 * @description Direct Gemini API backend via Google AI REST SSE endpoints.
 */

import { logger } from '../../utils/logger.js';
import { getTuningConfig } from '../../config/userConfig.js';
import { geminiDirectHistories } from '../conversationManager.js';
import type { AgyRunOptions, AgyRunResult } from '../types.js';

function mapModelToGeminiId(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('gemini 3.5 flash') || lower.includes('gemini-2.5-flash') || lower.includes('gemini-2.0-flash')) {
    if (lower.includes('thinking')) {
      return 'gemini-2.0-flash-thinking-exp-01-21';
    }
    return 'gemini-2.0-flash';
  }
  if (lower.includes('gemini 3.1 pro') || lower.includes('gemini-2.5-pro') || lower.includes('gemini-2.0-pro')) {
    return 'gemini-2.0-pro-exp-02-05';
  }
  if (model.startsWith('gemini-')) {
    return model;
  }
  return 'gemini-2.0-flash';
}

export async function runGeminiDirect(opts: AgyRunOptions, apiKey: string): Promise<AgyRunResult> {
  const { prompt, conversationId: existingConvId, model = '', onChunk, signal, proxy } = opts;
  const modelId = mapModelToGeminiId(model);
  const convId = existingConvId || `gemini-direct-${globalThis.crypto.randomUUID()}`;

  // Build history in memory
  const history: any[] = geminiDirectHistories.get(convId) ?? [];
  history.push({ role: 'user', parts: [{ text: prompt }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body = JSON.stringify({
    contents: history,
    generationConfig: {
      thinkingConfig: {
        includeThoughts: true
      }
    }
  });

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    signal,
  };

  if (proxy) {
    const { ProxyAgent } = await import('undici');
    const dispatcher = new ProxyAgent(proxy);
    (fetchOptions as any).dispatcher = dispatcher;
  }

  let outputBuf = '';
  let thoughtBuf = '';
  let contentBuf = '';
  let inThoughts = false;
  let thinkingTokens = 0;
  let finalUsage: any = null;
  let thoughtStartTime = 0;
  let thoughtEndTime = 0;

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API returned ${response.status}: ${errText || response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Gemini API response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6).trim();
        if (!dataStr) continue;

        try {
          const parsed = JSON.parse(dataStr);

             // Extract usage metadata if returned
             const usage = parsed?.usageMetadata;
             if (usage) {
               finalUsage = usage;
               if (usage.thinkingTokenCount) {
                 thinkingTokens = usage.thinkingTokenCount;
               }
             }

            const parts = parsed?.candidates?.[0]?.content?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                const isThought = part.thought === true;
                const text = part.text || '';
                if (!text) continue;

                if (isThought) {
                  if (!thoughtStartTime) {
                    thoughtStartTime = Date.now();
                  }
                  if (!inThoughts) {
                    inThoughts = true;
                    const timeAttr = ' time="0.0"'; // updated when thoughts finish or generation finishes
                    const tokensAttr = thinkingTokens ? ` tokens="${thinkingTokens}"` : '';
                    onChunk?.(`<thought-gemini${timeAttr}${tokensAttr}>`);
                  }
                  thoughtBuf += text;
                  outputBuf += text;
                  onChunk?.(text);
                  opts.onEvent?.({ type: 'thought', content: text });
                } else {
                  if (thoughtStartTime && !thoughtEndTime) {
                    thoughtEndTime = Date.now();
                  }
                  if (inThoughts) {
                    inThoughts = false;
                    onChunk?.('</thought-gemini>\n\n');
                  }
                  contentBuf += text;
                  outputBuf += text;
                  onChunk?.(text);
                  opts.onEvent?.({ type: 'text', content: text });
                }
              }
            }
        } catch {
            // ignore incomplete SSE chunk lines
          }
      }
    }

    if (inThoughts) {
      inThoughts = false;
      onChunk?.('</thought-gemini>');
    }
    opts.onEvent?.({ type: 'done' });

    if (thoughtStartTime) {
      if (!thoughtEndTime) {
        thoughtEndTime = Date.now();
      }
      const durationSec = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
      const timeAttr = `time="${durationSec}"`;
      const tokensAttr = thinkingTokens ? ` tokens="${thinkingTokens}"` : '';
      
      outputBuf = `<thought-gemini ${timeAttr}${tokensAttr}>${thoughtBuf}</thought-gemini>\n\n${contentBuf}`;
    } else {
      outputBuf = contentBuf;
    }

    // Save history in memory
    history.push({ role: 'model', parts: [{ text: outputBuf }] });
    const maxMessages = getTuningConfig().maxHistoryMessages;
    const trimmed = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
    geminiDirectHistories.set(convId, trimmed);

    const finalResult: AgyRunResult = {
      conversationId: convId,
      output: outputBuf,
      exitCode: 0,
      stderr: '',
    };

    if (thoughtStartTime) {
      (finalResult as any).thinkingTime = ((thoughtEndTime - thoughtStartTime) / 1000).toFixed(1);
      (finalResult as any).thinkingTokens = thinkingTokens;
    }

    if (finalUsage) {
      const promptTokens = finalUsage.promptTokenCount ?? 0;
      const cachedTokens = finalUsage.cachedContentTokenCount ?? 0;
      finalResult.usage = {
        input: promptTokens - cachedTokens,
        output: finalUsage.candidatesTokenCount ?? 0,
        cached: cachedTokens,
        thinking: finalUsage.thinkingTokenCount ?? 0,
      };
    }

    return finalResult;

  } catch (err: any) {
    logger.error(`[runGeminiDirect] Error: ${err.message || err}`);
    return {
      conversationId: convId,
      output: outputBuf,
      exitCode: 1,
      stderr: err.message || String(err),
    };
  }
}
