/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface ScheduledTask {
  id: string;
  chatId: number;
  message: string;
  type: 'once' | 'recurring';
  /** ISO string or cron-like expression */
  schedule: string;
  /** For recurring: interval in minutes */
  intervalMinutes?: number;
  /** Next run timestamp */
  nextRun: number;
  /** Whether task is active */
  active: boolean;
  /** Creation timestamp */
  createdAt: number;
  /** Number of times executed */
  runCount: number;
}

export type TaskCallback = (task: ScheduledTask) => Promise<void>;

/**
 * Persistent task scheduler for scheduled chats.
 */
export class ChatScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private configDir: string;
  private tasksFile: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callback?: TaskCallback;
  private readonly CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

  constructor() {
    this.configDir = path.join(os.homedir(), '.gemini-cli-telegram');
    this.tasksFile = path.join(this.configDir, 'scheduled-tasks.json');
  }

  async initialize(callback: TaskCallback): Promise<void> {
    this.callback = callback;
    await fs.mkdir(this.configDir, { recursive: true });
    await this.loadTasks();
    this.startTimer();
    logger.info(`Scheduler initialized with ${this.tasks.size} task(s)`);
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.checkAndRunTasks();
    }, this.CHECK_INTERVAL_MS);
  }

  private async checkAndRunTasks(): Promise<void> {
    const now = Date.now();
    const tasksToRun: ScheduledTask[] = [];

    for (const task of this.tasks.values()) {
      if (task.active && task.nextRun <= now) {
        tasksToRun.push(task);
      }
    }

    for (const task of tasksToRun) {
      logger.info(`Running scheduled task ${task.id} for chat ${task.chatId}`);
      try {
        await this.callback?.(task);
        task.runCount++;

        if (task.type === 'once') {
          task.active = false;
          logger.info(`One-time task ${task.id} completed`);
        } else if (task.type === 'recurring' && task.intervalMinutes) {
          task.nextRun = now + task.intervalMinutes * 60 * 1000;
          logger.info(`Recurring task ${task.id} rescheduled for ${new Date(task.nextRun).toISOString()}`);
        }
      } catch (e) {
        logger.error(`Scheduled task ${task.id} failed: ${e}`);
        // Don't deactivate recurring tasks on failure, just reschedule
        if (task.type === 'recurring' && task.intervalMinutes) {
          task.nextRun = now + task.intervalMinutes * 60 * 1000;
        } else {
          task.active = false;
        }
      }
    }

    if (tasksToRun.length > 0) {
      await this.saveTasks();
    }
  }

  async addTask(
    chatId: number,
    message: string,
    type: 'once' | 'recurring',
    schedule: string,
    intervalMinutes?: number,
  ): Promise<ScheduledTask> {
    const now = Date.now();
    let nextRun: number;

    if (type === 'once') {
      // Parse the schedule as a time string
      nextRun = this.parseScheduleTime(schedule);
    } else {
      nextRun = now + (intervalMinutes || 60) * 60 * 1000;
    }

    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      chatId,
      message,
      type,
      schedule,
      intervalMinutes,
      nextRun,
      active: true,
      createdAt: now,
      runCount: 0,
    };

    this.tasks.set(task.id, task);
    await this.saveTasks();
    logger.info(`Added ${type} task ${task.id} for chat ${chatId}, next run: ${new Date(nextRun).toISOString()}`);
    return task;
  }

  private parseScheduleTime(schedule: string): number {
    const now = new Date();
    const lower = schedule.toLowerCase().trim();

    // Handle relative times
    if (lower === 'now') return Date.now() + 5000; // 5 seconds from now
    if (lower === 'in 1 minute' || lower === 'in 1m') return Date.now() + 60000;
    if (lower === 'in 5 minutes' || lower === 'in 5m') return Date.now() + 5 * 60000;
    if (lower === 'in 10 minutes' || lower === 'in 10m') return Date.now() + 10 * 60000;
    if (lower === 'in 30 minutes' || lower === 'in 30m') return Date.now() + 30 * 60000;
    if (lower === 'in 1 hour' || lower === 'in 1h') return Date.now() + 60 * 60000;
    if (lower === 'in 2 hours' || lower === 'in 2h') return Date.now() + 2 * 60 * 60000;
    if (lower === 'tomorrow') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.getTime();
    }
    if (lower.startsWith('tomorrow at ')) {
      const timeStr = lower.replace('tomorrow at ', '');
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const [hours, minutes] = timeStr.split(':').map(Number);
      tomorrow.setHours(hours || 9, minutes || 0, 0, 0);
      return tomorrow.getTime();
    }
    if (lower === 'tonight') {
      const tonight = new Date(now);
      tonight.setHours(21, 0, 0, 0);
      if (tonight.getTime() <= Date.now()) {
        tonight.setDate(tonight.getDate() + 1);
      }
      return tonight.getTime();
    }
    if (lower === 'morning') {
      const morning = new Date(now);
      morning.setHours(8, 0, 0, 0);
      if (morning.getTime() <= Date.now()) {
        morning.setDate(morning.getDate() + 1);
      }
      return morning.getTime();
    }
    if (lower === 'evening') {
      const evening = new Date(now);
      evening.setHours(19, 0, 0, 0);
      if (evening.getTime() <= Date.now()) {
        evening.setDate(evening.getDate() + 1);
      }
      return evening.getTime();
    }

    // Try parsing as ISO date
    const isoDate = new Date(schedule);
    if (!isNaN(isoDate.getTime())) {
      return isoDate.getTime();
    }

    // Try parsing as HH:MM (today or tomorrow)
    const timeMatch = schedule.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]!, 10);
      const minutes = parseInt(timeMatch[2]!, 10);
      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }

    // Default: 5 minutes from now
    logger.warn(`Could not parse schedule "${schedule}", defaulting to 5 minutes`);
    return Date.now() + 5 * 60000;
  }

  getTasksForChat(chatId: number): ScheduledTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.chatId === chatId)
      .sort((a, b) => a.nextRun - b.nextRun);
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  async removeTask(id: string): Promise<boolean> {
    const existed = this.tasks.delete(id);
    if (existed) {
      await this.saveTasks();
    }
    return existed;
  }

  async toggleTask(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.active = !task.active;
    await this.saveTasks();
    return task.active;
  }

  private async loadTasks(): Promise<void> {
    try {
      const data = await fs.readFile(this.tasksFile, 'utf-8').catch(() => '[]');
      const tasks: ScheduledTask[] = JSON.parse(data);
      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
    } catch (e) {
      logger.warn(`Failed to load scheduled tasks: ${e}`);
    }
  }

  private async saveTasks(): Promise<void> {
    try {
      const data = JSON.stringify(Array.from(this.tasks.values()), null, 2);
      await fs.writeFile(this.tasksFile, data, 'utf-8');
    } catch (e) {
      logger.error(`Failed to save scheduled tasks: ${e}`);
    }
  }
}
