/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { DaemonSession, SessionOptions, SendMediaFn, ProjectInfo } from './types.js';
import { ChatScheduler } from './scheduler.js';
import { getConversationId, deleteConversation, getStoredModel, setConversation } from '../agy/conversationStore.js';

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

    const solidified = [
      {
        id: "c0723167-918e-4a7b-bf0a-53c876398dd4",
        name: "通用知识专家",
        path: "/home/user/Documents/通用知识专家",
        description: "通用知识专家 - 2.1 基础版"
      },
      {
        id: "d0723167-918e-4a7b-bf0a-53c876398dd4",
        name: "通用知识专家_MarkdownV2",
        path: "/home/user/Documents/通用知识专家_MarkdownV2",
        description: "通用知识专家 - 2.1 MarkdownV2版"
      },
      {
        id: "b0723167-918e-4a7b-bf0a-53c876398dd4",
        name: "通用知识专家_RichText",
        path: "/home/user/Documents/通用知识专家_RichText",
        description: "通用知识专家 - 10.1 富文本渲染版"
      },
      {
        id: "2a489922-6c17-420a-9612-f751a64facb8",
        name: "基于第一性原理的多视角决策分析专家",
        path: "/home/user/Documents/基于第一性原理的多视角决策分析专家",
        description: "多视角决策分析专家 - 遵循第一性原理"
      },
      {
        id: "24483651-746e-43a4-9790-a43fe337b378",
        name: "Jack Notes",
        path: "/mnt/pool/1000/jack",
        description: "个人笔记库 - PARA 结构"
      }
    ];

    // Filter projects to only retain solidified ones (preserving their loaded fields like lastUsed)
    const filteredProjects: Map<string, ProjectInfo> = new Map();
    for (const s of solidified) {
      const loaded = this.projects.get(s.id) || Array.from(this.projects.values()).find(p => p.path === s.path);
      filteredProjects.set(s.id, {
        ...s,
        lastUsed: loaded?.lastUsed
      });
    }

    // Replace the project map with the clean filtered version
    this.projects = filteredProjects;

    // Prune projects.json immediately to match
    await this.saveProjects();
    logger.info(`Pruned project cache. Retained exactly ${this.projects.size} solidified projects.`);
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

  async scanDirectory(dirPath: string, depth = 3, maxResults = 50): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];
    const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.cache', 'vendor', 'target', 'bin', 'obj']);

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
        'composer.json',
        'package.yaml',
        'mix.exs',
        'rebar.config',
        'Project.toml',
        'shard.yml',
        'pubspec.yaml',
        'environment.yml',
        '.venv',
        'poetry.lock',
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
    // We detect top-level call by checking if depth is at its initial value or via a flag,
    // but here we just check it. Recursion will handle subdirs.
    try {
      const selfProject = await checkProject(dirPath, path.basename(dirPath));
      if (selfProject) {
        projects.push(selfProject);
        // Even if it's a project, we might want to scan subdirectories (e.g. monorepos)
      }
    } catch (e) {
      /* ignore */
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Limit entries to prevent blocking on huge directories
      const maxEntries = 5000;
      const limitedEntries = entries.slice(0, maxEntries);

      for (const entry of limitedEntries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) {
            // Still allow .git as a project indicator but don't recurse into .folders
            if (entry.name !== '.git') continue;
        }
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (projects.length >= maxResults) break;

        const fullPath = path.join(dirPath, entry.name);
        
        // Optimization: checkProject is only called once per directory
        const project = await checkProject(fullPath, entry.name);

        if (project) {
          if (!projects.find((p) => p.path === project.path)) {
            projects.push(project);
          }
        }

        // Recurse if not a project OR if it's a project but we want to find nested ones (depth permitting)
        if (depth > 0 && projects.length < maxResults) {
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
        await deleteConversation(chatId);
      } catch (e) {
        logger.warn(`Error deleting conversation for chat ${chatId}: ${e}`);
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

    let project = options.project;
    if (!project) {
      let found = this.projectManager.getProjects().find(p => p.name === '通用知识专家_RichText');
      if (!found) {
        const hardcodedPath = '/home/user/Documents/通用知识专家_RichText';
        try {
          await fs.access(hardcodedPath);
          found = await this.projectManager.addProject({
            name: '通用知识专家_RichText',
            path: hardcodedPath,
            description: '通用知识专家 - 10.1 富文本渲染版',
          });
          logger.info(`[SessionManager] Discovered and added missing default project from physical path: ${hardcodedPath}`);
        } catch {
          // Ignore if directory does not exist or cannot be accessed
        }
      }
      if (found) {
        project = found;
        logger.info(`[SessionManager] Automatically set default project: 通用知识专家_RichText (${project.path})`);
      }
    }

    const cwd = project?.path || options.cwd || process.cwd();
    
    // Check for write access to the workspace directory
    try {
      const testFile = path.join(cwd, `.write_test_${sessionId}`);
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      logger.debug(`Write access verified for ${cwd}`);
    } catch (e) {
      logger.warn(`Potential write access issue in ${cwd}: ${e}`);
    }

    if (project) {
      await this.projectManager.updateProjectLastUsed(project.id);
    }

    const conversationId = (await getConversationId(chatId)) || undefined;
    const storedModel = await getStoredModel(chatId);
    const modelToUse = storedModel || options.model || 'Gemini 3.1 Pro (High)';
    const sendMedia = this.sendMediaFactory?.(chatId);

    const session: DaemonSession = {
      sessionId,
      chatId,
      conversationId,
      model: modelToUse,
      proxy: options.proxy,
      abortController: new AbortController(),
      busy: false,
      turnCount: 0,
      createdAt: new Date(),
      currentProject: project,
      settings: {
        telegram: {
          parseMode: 'RichText', // 默认修改为 RichText！
        },
      },
      thinkingSteps: [],
      sendMedia,
      autopilot: undefined,
      config: {
        getModel: () => session.model || 'Gemini 3.1 Pro (High)',
        setModel: (modelName: string) => {
          session.model = modelName;
          setConversation(chatId, session.conversationId || '', session.currentProject?.path || process.cwd(), modelName).catch(err => {
            logger.error(`Error setting model in store: ${err}`);
          });
        },
        getTargetDir: () => session.currentProject?.path || process.cwd(),
        getWorkspaceContext: () => ({
          addDirectory: (dir: string) => {
            logger.info(`[Session compatibility] addDirectory called: ${dir}`);
          }
        }),
        storage: {
          getProjectTempDir: () => path.join(os.tmpdir(), 'gemini-cli-telegram'),
        }
      },
      geminiClient: {
        getHistory: () => [],
        setHistory: (history: any[]) => {
          logger.info(`[Session compatibility] setHistory called with ${history.length} items`);
        },
        getChatRecordingService: () => null,
        tryCompressChat: async (sessId: string, force: boolean) => {
          logger.info(`[Session compatibility] tryCompressChat called: ${sessId}, force=${force}`);
        }
      }
    };

    this.sessions.set(chatId, session);
    logger.info(`Session ${sessionId} created for chat ${chatId}`);

    return session;
  }
}
