/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatScheduler, type ScheduledTask } from './scheduler.js';

vi.mock('node:fs/promises');
vi.mock('../config/userConfig.js', () => ({
  getScheduledTasksPath: () => '/mock/home/gemini-cli-telegram/scheduled-tasks.json',
}));
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ChatScheduler', () => {
  let scheduler: ChatScheduler;
  const mockConfigDir = '/mock/home/gemini-cli-telegram';
  const mockTasksFile = path.join(mockConfigDir, 'scheduled-tasks.json');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('[]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    
    // Mock timers
    vi.useFakeTimers();
    
    scheduler = new ChatScheduler();
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  describe('initialize', () => {
    it('should create config directory and load tasks', async () => {
      const mockCallback = vi.fn();
      await scheduler.initialize(mockCallback);

      expect(fs.mkdir).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
      expect(fs.readFile).toHaveBeenCalledWith(mockTasksFile, 'utf-8');
    });

    it('should load existing tasks from file', async () => {
      const existingTask: Partial<ScheduledTask> = {
        id: 'task-1',
        chatId: 123,
        message: 'hello',
        active: true,
        nextRun: Date.now() - 1000,
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([existingTask]));

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      await scheduler.initialize(mockCallback);

      expect(scheduler.getTask('task-1')).toMatchObject(existingTask);
    });
  });

  describe('addTask', () => {
    it('should add a one-time task', async () => {
      const task = await scheduler.addTask(123, 'test message', 'once', 'in 5m');

      expect(task.chatId).toBe(123);
      expect(task.message).toBe('test message');
      expect(task.type).toBe('once');
      expect(task.active).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should add a recurring task', async () => {
      const task = await scheduler.addTask(123, 'test message', 'recurring', 'every 60m', 60);

      expect(task.chatId).toBe(123);
      expect(task.type).toBe('recurring');
      expect(task.intervalMinutes).toBe(60);
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe('parseScheduleTime', () => {
    it('should parse "now" correctly', async () => {
      const now = Date.now();
      vi.setSystemTime(now);
      
      // Accessing private method for testing
      const nextRun = (scheduler as any).parseScheduleTime('now');
      expect(nextRun).toBe(now + 5000);
    });

    it('should parse relative times correctly', async () => {
      const now = Date.now();
      vi.setSystemTime(now);
      
      expect((scheduler as any).parseScheduleTime('in 5m')).toBe(now + 5 * 60000);
      expect((scheduler as any).parseScheduleTime('in 1h')).toBe(now + 60 * 60000);
    });

    it('should parse HH:MM format', async () => {
      const now = new Date(2026, 4, 10, 10, 0, 0); // 10:00 AM
      vi.setSystemTime(now);
      
      const nextRun = (scheduler as any).parseScheduleTime('14:30');
      const expected = new Date(2026, 4, 10, 14, 30, 0).getTime();
      expect(nextRun).toBe(expected);
    });

    it('should parse HH:MM format for tomorrow if time has passed', async () => {
      const now = new Date(2026, 4, 10, 15, 0, 0); // 3:00 PM
      vi.setSystemTime(now);
      
      const nextRun = (scheduler as any).parseScheduleTime('14:30');
      const expected = new Date(2026, 4, 11, 14, 30, 0).getTime();
      expect(nextRun).toBe(expected);
    });
  });

  describe('task execution', () => {
    it('should run tasks when they are due', async () => {
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      // Manually set up instead of calling initialize() to avoid the interval timer
      (scheduler as any).callback = mockCallback;
      await (scheduler as any).loadTasks();

      const now = Date.now();
      vi.setSystemTime(now);

      await scheduler.addTask(123, 'due task', 'once', 'now');
      
      // Make sure it's due
      vi.setSystemTime(now + 6000);

      await (scheduler as any).checkAndRunTasks();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      const task = scheduler.getTasksForChat(123)[0];
      expect(task?.active).toBe(false);
      expect(task?.runCount).toBe(1);
    });

    it('should reschedule recurring tasks after execution', async () => {
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      (scheduler as any).callback = mockCallback;
      await (scheduler as any).loadTasks();

      const now = Date.now();
      vi.setSystemTime(now);

      await scheduler.addTask(123, 'recurring task', 'recurring', 'every 60m', 60);
      
      // Make it due
      const tasks = scheduler.getTasksForChat(123);
      tasks[0]!.nextRun = now - 1000;

      await (scheduler as any).checkAndRunTasks();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      const task = scheduler.getTasksForChat(123)[0];
      expect(task?.active).toBe(true);
      expect(task?.runCount).toBe(1);
      expect(task?.nextRun).toBe(now + 60 * 60000);
    });
  });

  describe('task management', () => {
    it('should remove tasks', async () => {
      const task = await scheduler.addTask(123, 'msg', 'once', 'now');
      const id = task.id;

      const removed = await scheduler.removeTask(id);
      expect(removed).toBe(true);
      expect(scheduler.getTask(id)).toBeUndefined();
    });

    it('should toggle tasks', async () => {
      const task = await scheduler.addTask(123, 'msg', 'once', 'now');
      const id = task.id;

      const active1 = await scheduler.toggleTask(id);
      expect(active1).toBe(false);
      
      const active2 = await scheduler.toggleTask(id);
      expect(active2).toBe(true);
    });
  });
});
