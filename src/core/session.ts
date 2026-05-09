/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Scheduler, ROOT_SCHEDULER_ID } from '@google/gemini-cli-core';
import {
  loadDaemonConfig,
  type DaemonConfigOptions,
} from '../config/config.js';
import { logger } from '../utils/logger.js';
import type { DaemonSession, SessionOptions, SendMediaFn, ProjectInfo } from './types.js';
import { SendMediaTool } from '../tools/send-media.js';
import { ChatScheduler } from './scheduler.js';
import { ScheduleChatTool, AutopilotTool } from '../tools/schedule-control.js';

export type SendMediaFactory = (chatId: number) => SendMediaFn;

/**
 * Project discovery utility
 */
export class ProjectManager {
  private projects: Map<string, ProjectInfo> = new Map();
  private configDir: string;

  constructor() {
    this.configDir = path.join(os.homedir(), '.gemini-cli-telegram');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await this.loadProjects();
  }

  async loadProjects(): Promise<void> {
    try {
      const projectsFile = path.join(this.configDir, 'projects.json');
      const data = await fs.readFile(projectsFile, 'utf-8').catch(() => '[]');
      const projects: ProjectInfo[] = JSON.parse(data);
      for (const project of projects) {
        if (project.lastUsed) {
          project.lastUsed = new Date(project.lastUsed);
        }
        this.projects.set(project.id, project);
      }
      logger.info(`Loaded ${this.projects.size} projects`);
    } catch (e) {
      logger.warn(`Failed to load projects: ${e}`);
    }
  }

  async saveProjects(): Promise<void> {
    try {
      const projectsFile = path.join(this.configDir, 'projects.json');
      const data = JSON.stringify(Array.from(this.projects.values()), null, 2);
      await fs.writeFile(projectsFile, data, 'utf-8');
    } catch (e) {
      logger.error(`Failed to save projects: ${e}`);
    }
  }

  async scanDirectory(dirPath: string, depth = 1, maxResults = 50): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];

    const checkProject = async (fullPath: string, name: string): Promise<ProjectInfo | null> => {
      const indicators = [
        'package.json',
        'Cargo.toml',
        'pyproject.toml',
        'setup.py',
        'go.mod',
        'pom.xml',
        'build.gradle',
        'CMakeLists.txt',
        'Makefile',
        'Dockerfile',
        'docker-compose.yml',
        '.git',
        'README.md',
        'requirements.txt',
        'Gemfile',
      ];

      let isProject = false;
      let description = '';

      for (const indicator of indicators) {
        try {
          await fs.access(path.join(fullPath, indicator));
          isProject = true;

          // Try to get description from package.json or README
          if (indicator === 'package.json') {
            try {
              const pkgData = await fs.readFile(path.join(fullPath, 'package.json'), 'utf-8');
              const pkg = JSON.parse(pkgData);
              description = pkg.description || '';
            } catch {
              /* ignore */
            }
          }
          break;
        } catch {
          /* ignore */
        }
      }

      if (isProject) {
        const existing = Array.from(this.projects.values()).find((p) => p.path === fullPath);
        const id = existing?.id || crypto.randomUUID();

        const project = {
          id,
          name: name || path.basename(fullPath) || fullPath,
          path: fullPath,
          description,
          lastUsed: existing?.lastUsed,
        };

        if (!existing) {
          this.projects.set(id, project);
        }
        return project;
      }
      return null;
    };

    // Check if dirPath itself is a project (only on top-level call)
    // We can detect top-level call by checking if depth is at its initial value, 
    // but better to just check it. To avoid double-counting in recursion,
    // we only do this once.
    try {
      const selfProject = await checkProject(dirPath, path.basename(dirPath));
      if (selfProject) {
        projects.push(selfProject);
        // If it's a project, we might still want to scan its subdirectories?
        // Usually projects don't contain other projects directly in a way we want to browse them,
        // but some monorepos might. For now, let's continue scanning.
      }
    } catch (e) {
      /* ignore */
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Limit entries to prevent blocking on huge directories
      const maxEntries = 200;
      const limitedEntries = entries.slice(0, maxEntries);

      for (const entry of limitedEntries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (projects.length >= maxResults) break;

        const fullPath = path.join(dirPath, entry.name);
        const project = await checkProject(fullPath, entry.name);

        if (project) {
          // Avoid duplicates if dirPath itself was added and it's same as fullPath (unlikely)
          if (!projects.find((p) => p.path === project.path)) {
            projects.push(project);
          }
        }

        // Scan one level deeper if not a project
        if (!project && depth > 0 && projects.length < maxResults) {
          try {
            const subProjects = await this.scanDirectory(fullPath, depth - 1, maxResults - projects.length);
            for (const sp of subProjects) {
                if (!projects.find(p => p.path === sp.path)) {
                    projects.push(sp);
                }
            }
          } catch {
            /* ignore permission errors */
          }
        }
      }
    } catch (e) {
      logger.warn(`Failed to scan directory ${dirPath}: ${e}`);
    }
    
    return projects;
  }

  getProjects(): ProjectInfo[] {
    return Array.from(this.projects.values())
      .sort((a, b) => (b.lastUsed?.getTime() || 0) - (a.lastUsed?.getTime() || 0));
  }

  getProject(id: string): ProjectInfo | undefined {
    return this.projects.get(id);
  }

  async updateProjectLastUsed(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (project) {
      project.lastUsed = new Date();
      await this.saveProjects();
    }
  }

  async addProject(project: Omit<ProjectInfo, 'id'>): Promise<ProjectInfo> {
    const id = crypto.randomUUID();
    const newProject: ProjectInfo = { ...project, id };
    this.projects.set(id, newProject);
    await this.saveProjects();
    return newProject;
  }
}

/**
 * Channel-agnostic session manager.
 * Maps a channel-specific chat identifier (number) to a DaemonSession.
 */
export class SessionManager {
  private sessions: Map<number, DaemonSession> = new Map();
  private sendMediaFactory?: SendMediaFactory;
  private projectManager: ProjectManager;
  private chatScheduler: ChatScheduler;

  constructor(sendMediaFactory?: SendMediaFactory) {
    this.sendMediaFactory = sendMediaFactory;
    this.projectManager = new ProjectManager();
    this.chatScheduler = new ChatScheduler();
    this.projectManager.initialize().catch(e => logger.error(`Failed to initialize project manager: ${e}`));
  }

  getChatScheduler(): ChatScheduler {
    return this.chatScheduler;
  }

  getProjectManager(): ProjectManager {
    return this.projectManager;
  }

  async getOrCreate(
    chatId: number,
    options: SessionOptions,
  ): Promise<DaemonSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      if (existing.abortController.signal.aborted) {
        logger.debug(`Reusing session ${existing.sessionId} but signal was aborted. Resetting.`);
        existing.abortController = new AbortController();
      }
      logger.debug(`Reusing existing session ${existing.sessionId} for chat ${chatId}`);
      return existing;
    }
    logger.debug(`No existing session for chat ${chatId}, creating new one`);
    return this.createSession(chatId, options);
  }

  async reset(
    chatId: number,
    options: SessionOptions,
  ): Promise<DaemonSession> {
    await this.destroy(chatId);
    return this.createSession(chatId, options);
  }

  async destroy(chatId: number): Promise<void> {
    const session = this.sessions.get(chatId);
    if (session) {
      session.abortController.abort('Session destroyed');
      try {
        await session.config.dispose();
      } catch (e) {
        logger.warn(`Error disposing session for chat ${chatId}: ${e}`);
      }
      this.sessions.delete(chatId);
      logger.info(`Session destroyed for chat ${chatId}`);
    }
  }

  async destroyAll(): Promise<void> {
    const chatIds = Array.from(this.sessions.keys());
    for (const chatId of chatIds) {
      await this.destroy(chatId);
    }
    logger.info('All sessions destroyed');
  }

  getSession(chatId: number): DaemonSession | undefined {
    return this.sessions.get(chatId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private async createSession(
    chatId: number,
    options: SessionOptions,
  ): Promise<DaemonSession> {
    const sessionId = crypto.randomUUID();
    logger.info(`Creating session ${sessionId} for chat ${chatId}`);

    const cwd = options.project?.path || options.cwd || process.cwd();
    
    const configOptions: DaemonConfigOptions = {
      cwd,
      model: options.model,
    };

    logger.debug(`Loading daemon config for session ${sessionId}...`);
    const config = await loadDaemonConfig(sessionId, configOptions);
    logger.debug(`Config loaded. Model: ${config.getModel()}`);

    // Check for write access to the workspace directory
    try {
      const testFile = path.join(cwd, `.write_test_${sessionId}`);
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      logger.debug(`Write access verified for ${cwd}`);
    } catch (e) {
      logger.warn(`Potential write access issue in ${cwd}: ${e}`);
      // Don't throw here, just log it. Some features might still work.
    }

    // Allow read access to the user's home directory so the daemon can
    // browse and reference files (write access stays scoped to cwd).
    const workspace = config.getWorkspaceContext();
    workspace.addReadOnlyPath(os.homedir());

    // If project specified, also add it
    if (options.project) {
      workspace.addDirectory(options.project.path);
      await this.projectManager.updateProjectLastUsed(options.project.id);
    }

    const geminiClient = config.getGeminiClient();
    logger.debug('Initializing Gemini client...');
    await geminiClient.initialize();
    logger.debug('Gemini client initialized');

    const scheduler = new Scheduler({
      config: config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    // Register daemon-specific tools
    const sendMedia = this.sendMediaFactory?.(chatId);
    if (sendMedia) {
      const sendMediaTool = new SendMediaTool(
        config.getMessageBus(),
        sendMedia,
      );
      config.getToolRegistry().registerTool(sendMediaTool);
      logger.debug('Registered send_media tool');
    }

    // Register schedule control tool
    const scheduleTool = new ScheduleChatTool(
      config.getMessageBus(),
      this.chatScheduler,
      chatId,
    );
    config.getToolRegistry().registerTool(scheduleTool);
    logger.debug('Registered schedule_chat tool');

    // Register autopilot control tool
    const autopilotTool = new AutopilotTool(
      config.getMessageBus(),
      this,
      chatId,
    );
    config.getToolRegistry().registerTool(autopilotTool);
    logger.debug('Registered autopilot_control tool');

    const session: DaemonSession = {
      sessionId,
      config,
      geminiClient,
      scheduler,
      abortController: new AbortController(),
      busy: false,
      turnCount: 0,
      createdAt: new Date(),
      currentProject: options.project,
      thinkingSteps: [],
      sendMedia,
      autopilot: undefined,
    };

    this.sessions.set(chatId, session);
    logger.info(`Session ${sessionId} created for chat ${chatId}`);

    return session;
  }
}
