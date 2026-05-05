/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '@google/gemini-cli-core';
import type { MessageBus } from '@google/gemini-cli-core';
import type { ChatScheduler, ScheduledTask } from '../core/scheduler.js';
import type { SessionManager } from '../core/session.js';

export const SCHEDULE_CHAT_TOOL_NAME = 'schedule_chat';
export const AUTOPILOT_TOOL_NAME = 'autopilot_control';

// ── Schedule Chat Tool ──

interface ScheduleChatParams {
  action: 'add' | 'list' | 'remove' | 'toggle';
  message?: string;
  time?: string;
  type?: 'once' | 'recurring';
  interval_minutes?: number;
  task_id?: string;
}

const SCHEDULE_CHAT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'remove', 'toggle'],
      description: 'Action to perform: add (create schedule), list (show all), remove (delete by ID), toggle (pause/resume)',
    },
    message: {
      type: 'string',
      description: 'The message to schedule (required for add). Example: "Check server logs" or "Run backup"',
    },
    time: {
      type: 'string',
      description: 'When to run. For once: "now", "in 5m", "in 1h", "tomorrow", "14:30", "morning", "evening". For recurring: "every 60m"',
    },
    type: {
      type: 'string',
      enum: ['once', 'recurring'],
      description: 'Schedule type: once (one-time) or recurring (repeating)',
    },
    interval_minutes: {
      type: 'number',
      description: 'For recurring schedules: interval in minutes (e.g., 60 for hourly)',
    },
    task_id: {
      type: 'string',
      description: 'Task ID prefix for remove/toggle actions',
    },
  },
  required: ['action'],
};

class ScheduleChatInvocation extends BaseToolInvocation<ScheduleChatParams, ToolResult> {
  constructor(
    params: ScheduleChatParams,
    messageBus: MessageBus,
    private readonly scheduler: ChatScheduler,
    private readonly chatId: number,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    return `Schedule chat: ${this.params.action}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { action, message, time, type, interval_minutes, task_id } = this.params;

    try {
      switch (action) {
        case 'add': {
          if (!message || !time || !type) {
            return {
              llmContent: 'Missing required fields. For "add", provide: message, time, and type.',
              returnDisplay: 'Missing required fields: message, time, type',
              error: { message: 'Missing required fields' },
            };
          }

          const task = await this.scheduler.addTask(
            this.chatId,
            message,
            type,
            time,
            type === 'recurring' ? interval_minutes : undefined,
          );

          const nextRun = new Date(task.nextRun);
          return {
            llmContent: `Scheduled task created successfully!\nID: ${task.id}\nMessage: ${message}\nNext run: ${nextRun.toLocaleString()}\nType: ${type}`,
            returnDisplay: `Scheduled: ${message} at ${nextRun.toLocaleString()}`,
          };
        }

        case 'list': {
          const tasks = this.scheduler.getTasksForChat(this.chatId);
          if (tasks.length === 0) {
            return {
              llmContent: 'No scheduled tasks found.',
              returnDisplay: 'No scheduled tasks',
            };
          }

          const lines = tasks.map((t: ScheduledTask) => {
            const status = t.active ? 'active' : 'paused';
            const nextRun = new Date(t.nextRun).toLocaleString();
            return `- [${status}] ${t.id.slice(0, 8)}: "${t.message.substring(0, 50)}" (${t.type}, next: ${nextRun})`;
          });

          return {
            llmContent: `Scheduled tasks:\n${lines.join('\n')}`,
            returnDisplay: `${tasks.length} scheduled task(s)`,
          };
        }

        case 'remove': {
          if (!task_id) {
            return {
              llmContent: 'Missing task_id for remove action.',
              returnDisplay: 'Missing task_id',
              error: { message: 'Missing task_id' },
            };
          }

          const tasks = this.scheduler.getTasksForChat(this.chatId);
          const task = tasks.find((t: ScheduledTask) => t.id.startsWith(task_id));
          if (!task) {
            return {
              llmContent: `Task "${task_id}" not found.`,
              returnDisplay: 'Task not found',
              error: { message: 'Task not found' },
            };
          }

          const removed = await this.scheduler.removeTask(task.id);
          return {
            llmContent: removed ? `Task ${task_id} removed successfully.` : 'Failed to remove task.',
            returnDisplay: removed ? 'Task removed' : 'Failed to remove',
          };
        }

        case 'toggle': {
          if (!task_id) {
            return {
              llmContent: 'Missing task_id for toggle action.',
              returnDisplay: 'Missing task_id',
              error: { message: 'Missing task_id' },
            };
          }

          const tasks = this.scheduler.getTasksForChat(this.chatId);
          const task = tasks.find((t: ScheduledTask) => t.id.startsWith(task_id));
          if (!task) {
            return {
              llmContent: `Task "${task_id}" not found.`,
              returnDisplay: 'Task not found',
              error: { message: 'Task not found' },
            };
          }

          const newState = await this.scheduler.toggleTask(task.id);
          return {
            llmContent: `Task ${task_id} is now ${newState ? 'active' : 'paused'}.`,
            returnDisplay: `Task ${newState ? 'activated' : 'paused'}`,
          };
        }

        default:
          return {
            llmContent: `Unknown action: ${action}`,
            returnDisplay: `Unknown action: ${action}`,
            error: { message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Schedule operation failed: ${msg}`,
        returnDisplay: `Failed: ${msg}`,
        error: { message: msg },
      };
    }
  }
}

export class ScheduleChatTool extends BaseDeclarativeTool<ScheduleChatParams, ToolResult> {
  constructor(
    messageBus: MessageBus,
    private readonly scheduler: ChatScheduler,
    private readonly chatId: number,
  ) {
    super(
      SCHEDULE_CHAT_TOOL_NAME,
      'ScheduleChat',
      'Manage scheduled chat messages and tasks. Use this to:\n' +
        '- Create one-time or recurring scheduled messages\n' +
        '- List existing scheduled tasks\n' +
        '- Remove or pause/resume tasks\n' +
        'Time formats: "now", "in 5m", "in 1h", "tomorrow", "14:30", "morning", "evening". ' +
        'For recurring: specify interval_minutes (e.g., 60 for hourly).',
      Kind.Execute,
      SCHEDULE_CHAT_SCHEMA,
      messageBus,
      false,
      false,
    );
  }

  protected createInvocation(
    params: ScheduleChatParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<ScheduleChatParams, ToolResult> {
    return new ScheduleChatInvocation(
      params,
      messageBus,
      this.scheduler,
      this.chatId,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// ── Autopilot Control Tool ──

interface AutopilotParams {
  action: 'start' | 'stop' | 'status';
  goal?: string;
  max_iterations?: number;
}

const AUTOPILOT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'stop', 'status'],
      description: 'Action: start (begin autopilot with a goal), stop (halt autopilot), status (check current state)',
    },
    goal: {
      type: 'string',
      description: 'The goal to achieve. Required for start. Example: "Refactor auth module to use JWT" or "Write tests for all functions"',
    },
    max_iterations: {
      type: 'number',
      description: 'Maximum self-reply iterations. Default: 10. Range: 1-50.',
    },
  },
  required: ['action'],
};

class AutopilotInvocation extends BaseToolInvocation<AutopilotParams, ToolResult> {
  constructor(
    params: AutopilotParams,
    messageBus: MessageBus,
    private readonly sessionManager: SessionManager,
    private readonly chatId: number,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    return `Autopilot: ${this.params.action}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { action, goal, max_iterations } = this.params;

    try {
      const session = await this.sessionManager.getOrCreate(this.chatId, {
        cwd: process.cwd(),
      });

      switch (action) {
        case 'start': {
          if (!goal) {
            return {
              llmContent: 'Goal is required to start autopilot. Example: "Refactor auth to JWT"',
              returnDisplay: 'Missing goal',
              error: { message: 'Missing goal' },
            };
          }

          const maxIter = Math.min(Math.max(max_iterations || 10, 1), 50);

          session.autopilot = {
            goal,
            maxIterations: maxIter,
            currentIteration: 0,
            active: true,
            stopKeywords: ['AUTOPILOT_COMPLETE', 'AUTOPILOT_STOP'],
          };

          return {
            llmContent: `Autopilot started!\nGoal: ${goal}\nMax iterations: ${maxIter}\n\nThe bot will now auto-reply to itself, working toward this goal. Use action "stop" to halt.`,
            returnDisplay: `Autopilot started: ${goal}`,
          };
        }

        case 'stop': {
          if (session.autopilot?.active) {
            session.autopilot.active = false;
            return {
              llmContent: 'Autopilot stopped.',
              returnDisplay: 'Autopilot stopped',
            };
          }
          return {
            llmContent: 'Autopilot is not currently active.',
            returnDisplay: 'Autopilot not active',
          };
        }

        case 'status': {
          if (!session.autopilot?.active) {
            return {
              llmContent: 'Autopilot is not active.',
              returnDisplay: 'Autopilot: inactive',
            };
          }

          const ap = session.autopilot;
          return {
            llmContent: `Autopilot status:\nGoal: ${ap.goal}\nIteration: ${ap.currentIteration}/${ap.maxIterations}\nActive: ${ap.active}`,
            returnDisplay: `Autopilot: ${ap.currentIteration}/${ap.maxIterations}`,
          };
        }

        default:
          return {
            llmContent: `Unknown action: ${action}`,
            returnDisplay: `Unknown action: ${action}`,
            error: { message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Autopilot operation failed: ${msg}`,
        returnDisplay: `Failed: ${msg}`,
        error: { message: msg },
      };
    }
  }
}

export class AutopilotTool extends BaseDeclarativeTool<AutopilotParams, ToolResult> {
  constructor(
    messageBus: MessageBus,
    private readonly sessionManager: SessionManager,
    private readonly chatId: number,
  ) {
    super(
      AUTOPILOT_TOOL_NAME,
      'AutopilotControl',
      'Control the autopilot (self-reply) mode. When started, the AI will automatically continue ' +
        'replying to itself, working toward a specified goal without user intervention. ' +
        'Use this for long-running tasks like refactoring, writing documentation, or fixing bugs. ' +
        'The AI will stop when the goal is achieved or max iterations reached.',
      Kind.Execute,
      AUTOPILOT_SCHEMA,
      messageBus,
      false,
      false,
    );
  }

  protected createInvocation(
    params: AutopilotParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<AutopilotParams, ToolResult> {
    return new AutopilotInvocation(
      params,
      messageBus,
      this.sessionManager,
      this.chatId,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}
