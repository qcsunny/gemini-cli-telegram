/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GeminiEventType,
  recordToolCallInteractions,
  debugLogger,
  ToolErrorType,
  detectFileType,
  readFileWithEncoding,
  type ToolCallRequestInfo,
} from '@google/gemini-cli-core';
import type { Content, Part } from '@google/gemini-cli-core';
import stripAnsi from 'strip-ansi';

import * as fs from 'fs/promises';
import type { DaemonSession, ChannelReply, MessageFormatter, MultimodalInput } from './types.js';
import { logger } from '../utils/logger.js';
import { ICONS, formatToolExecution, type ToolStatus } from '../channels/telegram/ui.js';

const DEBOUNCE_INTERVAL_MS = 500;

/**
 * Channel-agnostic message processing loop, adapted from nonInteractiveCli.ts.
 * Sends user input to Gemini, streams responses back via ChannelReply,
 * and auto-executes tools in YOLO mode.
 *
 * The formatter handles channel-specific message size limits (e.g. 4096 for
 * Telegram, 2000 for Discord).
 */
export async function processMessage(
  session: DaemonSession,
  input: MultimodalInput,
  reply: ChannelReply,
  formatter: MessageFormatter,
): Promise<void> {
  const { geminiClient, scheduler, config } = session;
  const signal = session.abortController.signal;

  const parts: Part[] = [];

  if (input.text) {
    parts.push({ text: input.text });
  }

  if (input.media && input.media.length > 0) {
    for (const mediaItem of input.media) {
      try {
        // For documents, detect file type to handle text vs binary properly
        // (same logic as CLI's processSingleFileContent in fileUtils.ts)
        if (mediaItem.type === 'document') {
          const fileType = await detectFileType(mediaItem.path);
          const label = mediaItem.fileName || mediaItem.path;

          if (fileType === 'text' || fileType === 'svg') {
            const content = await readFileWithEncoding(mediaItem.path);
            parts.push({ text: `\n--- ${label} ---\n\n${content}\n` });
            logger.debug(`Added document as text: ${label} (${fileType})`);
          } else if (fileType === 'binary') {
            parts.push({ text: `[Binary file: ${label} — cannot display contents]` });
            logger.debug(`Skipped binary document: ${label}`);
          } else {
            // image, pdf, audio, video — send as inlineData
            const fileBuffer = await fs.readFile(mediaItem.path);
            const base64Data = fileBuffer.toString('base64');
            parts.push({
              inlineData: {
                mimeType: mediaItem.mimeType || 'application/octet-stream',
                data: base64Data,
              },
            });
            logger.debug(`Added document as ${fileType} inlineData: ${label}, mime=${mediaItem.mimeType}`);
          }
        } else {
          // photo, voice, audio, video — always inlineData
          const fileBuffer = await fs.readFile(mediaItem.path);
          const base64Data = fileBuffer.toString('base64');
          parts.push({
            inlineData: {
              mimeType: mediaItem.mimeType || 'application/octet-stream',
              data: base64Data,
            },
          });
          logger.debug(`Added media part: type=${mediaItem.type}, mime=${mediaItem.mimeType}`);
        }
      } catch (e) {
        logger.error(`Failed to process media file ${mediaItem.path}: ${e}`);
        await reply.send(`${ICONS.error} Failed to process file: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  let currentMessages: Content[] = [
    { role: 'user', parts: parts },
  ];

  logger.debug(`Processing message: "${input.text ? (input.text.substring(0, 100) + (input.text.length > 100 ? '...' : '')) : (input.media && input.media.length > 0 ? `[${input.media.length} media item(s)]` : 'Empty input')}"`);

  // Simple thinking indicator
  let thinkingMessageId: number | null = null;

  const clearThinking = async () => {
    if (thinkingMessageId) {
      try {
        await reply.delete(thinkingMessageId);
        thinkingMessageId = null;
      } catch {
        // ignore
      }
    }
  };

  let turnCount = 0;
  let toolExecutionStatusMsgId: number | null = null;

  const showToolExecution = async (tools: ToolStatus[]) => {
    try {
      const statusText = formatToolExecution(tools);
      if (!toolExecutionStatusMsgId) {
        toolExecutionStatusMsgId = await reply.send(statusText);
      } else {
        await reply.edit(toolExecutionStatusMsgId, statusText);
      }
    } catch (e) {
      logger.warn(`Failed to update tool execution status: ${e}`);
    }
  };

  const clearToolExecution = async () => {
    if (toolExecutionStatusMsgId) {
      try {
        await reply.delete(toolExecutionStatusMsgId);
        toolExecutionStatusMsgId = null;
      } catch {
        // ignore
      }
    }
  };

  while (true) {
    turnCount++;
    session.turnCount++;
    logger.debug(`Turn ${turnCount} (session total: ${session.turnCount})`);

    if (signal.aborted) {
      const reason = (signal as any).reason;
      logger.debug(`Signal aborted before sending message. Reason: ${reason}`);
      await clearThinking();
      await reply.send(`${ICONS.cancel} Operation cancelled.${reason ? ` (Reason: ${reason})` : ''}`);
      return;
    }

    const toolCallRequests: ToolCallRequestInfo[] = [];

    let statusMessageId: number | null = null;
    const updateStatus = async (status: string, details?: string) => {
      try {
        const text = `${ICONS.processing} ${status}${details ? `\n${ICONS.step} ${details}` : ''}`;
        if (!statusMessageId) {
          statusMessageId = await reply.send(text);
        } else {
          await reply.edit(statusMessageId, text);
        }
      } catch {
        // ignore
      }
    };

    const clearStatus = async () => {
      if (statusMessageId) {
        try {
          await reply.delete(statusMessageId);
          statusMessageId = null;
        } catch {
          // ignore
        }
      }
    };

    logger.debug('Sending message stream to Gemini...');
    const responseStream = geminiClient.sendMessageStream(
      currentMessages[0]?.parts || [],
      signal,
      `daemon-${session.sessionId}`,
      undefined,
      false,
      turnCount === 1 ? input : undefined,
    );

    let responseText = '';
    let currentMessageId: number | null = null;
    let lastEditTime = 0;

    for await (const event of responseStream) {
      if (signal.aborted) {
        const reason = (signal as any).reason;
        logger.debug(`Signal aborted during response stream. Reason: ${reason}`);
        await clearThinking();
        await clearStatus();
        await reply.send(`${ICONS.cancel} Operation cancelled.${reason ? ` (Reason: ${reason})` : ''}`);
        return;
      }

      if (event.type === GeminiEventType.Content) {
        const output = stripAnsi(event.value);
        responseText += output;
        logger.debug(`Content chunk (+${output.length} chars, total: ${responseText.length})`);

        const now = Date.now();
        if (now - lastEditTime >= DEBOUNCE_INTERVAL_MS) {
          try {
            if (!currentMessageId) {
              const displayText = formatter.truncateForEdit(responseText);
              if (displayText.trim()) {
                currentMessageId = await reply.sendPlain(displayText);
              }
            } else {
              await reply.editPlain(
                currentMessageId,
                formatter.truncateForEdit(responseText),
              );
            }
            lastEditTime = now;
          } catch (e) {
            logger.warn(`Failed to update message: ${e}`);
          }
        }
      } else if (event.type === GeminiEventType.ToolCallRequest) {
        logger.debug(`Tool call request: ${event.value.name}`);
        toolCallRequests.push(event.value);
        await updateStatus('Analyzing request...', `Tool #${toolCallRequests.length}: ${event.value.name}`);
      } else if (event.type === GeminiEventType.Error) {
        logger.debug(`Error event: ${event.value.error}`);
        const err = event.value.error;
        const errorMsg =
          err instanceof Error ? err.message : String(err || 'Unknown error');
        await clearStatus();
        await clearThinking();
        await reply.send(`${ICONS.error} Error: ${errorMsg}`);
        return;
      } else if (event.type === GeminiEventType.UserCancelled) {
        logger.debug('User cancelled');
        await clearStatus();
        await clearThinking();
        return;
      } else if (event.type === GeminiEventType.AgentExecutionStopped) {
        logger.debug(`Agent execution stopped: ${event.value.reason}`);
        const stopMessage =
          event.value.systemMessage?.trim() || event.value.reason;
        if (stopMessage) {
          await clearStatus();
          await clearThinking();
          await reply.send(`${ICONS.warning} Stopped: ${stopMessage}`);
        }
        return;
      }
    }

    logger.debug(`Stream ended. Text: ${responseText.length} chars, Tool calls: ${toolCallRequests.length}`);
    if (responseText.trim()) {
      logger.debug(`Agent response:\n${responseText}`);
    }

    if (toolCallRequests.length > 0) {
      logger.debug(`Executing ${toolCallRequests.length} tool(s): ${toolCallRequests.map((t) => t.name).join(', ')}`);

      // Show tool execution status with tool names
      const toolStatuses: ToolStatus[] = toolCallRequests.map((t) => ({
        name: t.name,
        status: 'pending' as const,
      }));
      await showToolExecution(toolStatuses);

      // Update status to running
      for (const tool of toolStatuses) {
        tool.status = 'running';
      }
      await showToolExecution(toolStatuses);

      // Send final accumulated text before tool execution (still streaming, use plain)
      if (responseText.trim() && currentMessageId) {
        try {
          await reply.editPlain(
            currentMessageId,
            formatter.truncateForEdit(responseText),
          );
        } catch {
          // ignore edit failures
        }
      }

      logger.debug('Scheduling tool calls...');
      let completedToolCalls;
      try {
        completedToolCalls = await scheduler.schedule(
          toolCallRequests,
          signal,
        );
      } catch (e) {
        if (signal.aborted) {
          logger.debug('Tool execution aborted by cancel');
          await clearThinking();
          return;
        }
        throw e;
      }

      logger.debug(`Tool execution complete. ${completedToolCalls.length} result(s)`);

      // Update tool statuses to show results
      for (const completedToolCall of completedToolCalls) {
        const toolName = completedToolCall.request.name;
        const toolStatus = toolStatuses.find(t => t.name === toolName);
        if (toolStatus) {
          if (completedToolCall.status === 'error' || completedToolCall.response.error) {
            toolStatus.status = 'error';
            toolStatus.error = completedToolCall.response.error?.message || 'Unknown error';
          } else {
            toolStatus.status = 'success';
          }
        }
      }
      await showToolExecution(toolStatuses);

      const toolResponseParts: Part[] = [];

      for (const completedToolCall of completedToolCalls) {
        const toolResponse = completedToolCall.response;

        if (toolResponse.responseParts) {
          toolResponseParts.push(...toolResponse.responseParts);
        }
      }

      // Record tool calls
      try {
        const currentModel =
          geminiClient.getCurrentSequenceModel() ?? config.getModel();
        geminiClient
          .getChat()
          .recordCompletedToolCalls(currentModel, completedToolCalls);
        await recordToolCallInteractions(config, completedToolCalls);
      } catch (error) {
        debugLogger.error(
          `Error recording completed tool call information: ${error}`,
        );
      }

      // Check if any tool requested to stop execution
      const stopExecutionTool = completedToolCalls.find(
        (tc) => tc.response.errorType === ToolErrorType.STOP_EXECUTION,
      );

      if (stopExecutionTool && stopExecutionTool.response.error) {
        const stopMessage = `Agent execution stopped: ${stopExecutionTool.response.error.message}`;
        await clearToolExecution();
        await clearThinking();
        await reply.send(`${ICONS.error} ${stopMessage}`);
        return;
      }

      // Small delay to show success status before continuing
      await new Promise((r) => setTimeout(r, 500));
      await clearToolExecution();
      await clearStatus();

      currentMessages = [{ role: 'user', parts: toolResponseParts }];
      logger.debug('Looping back with tool responses...');
    } else {
      // No tool calls — send final response
      logger.debug('No tool calls — sending final response');

      // Clear thinking indicator before sending final response
      await clearThinking();

      if (responseText.trim()) {
        const chunks = formatter.chunkText(responseText);
        if (currentMessageId) {
          // Edit the first message with final text
          try {
            const firstChunk = chunks[0];
            if (firstChunk) {
              await reply.edit(currentMessageId, firstChunk);
            }
          } catch {
            // ignore edit failures
          }
          // Send remaining chunks as new messages
          for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk) {
              await reply.send(chunk);
            }
          }
        } else {
          // No message was sent yet, send all chunks
          for (const chunk of chunks) {
            await reply.send(chunk);
          }
        }
      }
      return;
    }
  }
}
