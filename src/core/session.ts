/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file session.ts
 * @description Session & Workspace Management module.
 * Provides the ProjectManager class for discovering and caching local software projects/workspaces,
 * and the SessionManager class for tracking active chat sessions (DaemonSession), managing session state,
 * lifecycle reset/destruction, working directory resolution, and scheduler integration.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { DaemonSession, SessionOptions, SendMediaFn, ProjectInfo } from './types.js';
import { ChatScheduler } from './scheduler.js';
import { getConversationId, deleteConversation, getStoredModel, setConversation, getCwd } from '../agy/conversationStore.js';
import { clearWeb2ApiHistory, clearDeepSeekHistory } from '../agy/agyCli.js';
import { loadUserConfig, CONFIG_DIR } from '../config/userConfig.js';

/** Factory function type for building chat-bound media sender functions */
export type SendMediaFactory = (chatId: number) => SendMediaFn;

/**
 * Utility class for discovering, caching, and managing local software projects/workspaces.
 * Scans directories for indicator files (e.g. package.json, Cargo.toml, .git) and persists
 * solidified project configurations locally.
 */
export class ProjectManager {
  private projects: Map<string, ProjectInfo> = new Map();
  private configDir: string;

  constructor() {
    this.configDir = CONFIG_DIR;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await this.loadProjects();

    // Solidified project list is loaded from the local, gitignored config.json
    // so personal directory paths never reach the remote repository.
    const cfg = loadUserConfig();
    const solidified: ProjectInfo[] = (cfg?.projects ?? []) as ProjectInfo[];

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
    let convId = session?.conversationId;
    if (!convId) {
      try {
        convId = (await getConversationId(chatId)) || undefined;
      } catch {
        // Ignore errors fetching conversationId
      }
    }

    if (session) {
      session.abortController.abort('Session destroyed');
      this.sessions.delete(chatId);
      logger.info(`Session destroyed for chat ${chatId}`);
    }

    try {
      await deleteConversation(chatId);
      if (convId) {
        clearWeb2ApiHistory(convId);
        clearDeepSeekHistory(convId);
      }
    } catch (e) {
      logger.warn(`Error deleting conversation for chat ${chatId}: ${e}`);
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
    const savedCwd = await getCwd(chatId);

    if (!project && savedCwd) {
      project = this.projectManager.getProjects().find(p => p.path === savedCwd);
      if (project) {
        logger.info(`[SessionManager] Restored project from saved cwd: ${project.name} (${project.path})`);
      }
    }

    if (!project && !savedCwd) {
      const found = this.projectManager.getProjects().find(p => p.name === '通用知识专家_RichText');
      if (found) {
        project = found;
        logger.info(`[SessionManager] Automatically set default project: 通用知识专家_RichText (${project.path})`);
      }
    }

    const cwd = project?.path || savedCwd || options.cwd || process.cwd();
    
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
    const modelToUse = storedModel || options.model || 'Gemini 3.6 Flash (High)';
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
        getModel: () => session.model || 'Gemini 3.6 Flash (High)',
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
      }
    };

    this.sessions.set(chatId, session);
    logger.info(`Session ${sessionId} created for chat ${chatId}`);

    return session;
  }
}
