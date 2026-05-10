/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectManager, SessionManager } from './session.js';
import { loadDaemonConfig } from '../config/config.js';

vi.mock('node:fs/promises');
vi.mock('node:os');
vi.mock('../config/config.js');
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock @google/gemini-cli-core
vi.mock('@google/gemini-cli-core', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
  ROOT_SCHEDULER_ID: 'root',
  BaseDeclarativeTool: class {},
  BaseToolInvocation: class {
    constructor(public params: any, public messageBus: any, public toolName?: string, public displayName?: string) {}
  },
  Kind: {
    Communicate: 'Communicate',
    Action: 'Action',
  },
}));

// Mock loadDaemonConfig
vi.mock('../config/config.js', () => ({
  loadDaemonConfig: vi.fn().mockResolvedValue({
    getModel: vi.fn().mockReturnValue('test-model'),
    getWorkspaceContext: vi.fn().mockReturnValue({
      addReadOnlyPath: vi.fn(),
      addDirectory: vi.fn(),
    }),
    getGeminiClient: vi.fn().mockReturnValue({
      initialize: vi.fn().mockResolvedValue(undefined),
    }),
    getMessageBus: vi.fn(),
    getToolRegistry: vi.fn().mockReturnValue({
      registerTool: vi.fn(),
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('ProjectManager', () => {
  let projectManager: ProjectManager;
  const mockHomedir = '/mock/home';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('[]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    
    projectManager = new ProjectManager();
  });

  describe('initialize', () => {
    it('should create config directory and load projects', async () => {
      await projectManager.initialize();
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.readFile).toHaveBeenCalled();
    });
  });

  describe('scanDirectory', () => {
    it('should identify a directory with package.json as a project', async () => {
      const mockDirPath = '/projects/my-app';
      
      // Mock readdir to return nothing for the root scan (we'll check the dir itself)
      vi.mocked(fs.readdir).mockResolvedValue([]);
      
      // Mock access to return success for package.json
      vi.mocked(fs.access).mockImplementation((p: any) => {
        if (p === path.join(mockDirPath, 'package.json')) return Promise.resolve();
        return Promise.reject(new Error('File not found'));
      });

      // Mock readFile for package.json description
      vi.mocked(fs.readFile).mockImplementation((p: any) => {
        if (p === path.join(mockDirPath, 'package.json')) {
          return Promise.resolve(JSON.stringify({ description: 'Test App' }));
        }
        return Promise.reject(new Error('File not found'));
      });

      const projects = await projectManager.scanDirectory(mockDirPath);
      
      expect(projects.length).toBe(1);
      expect(projects[0]).toMatchObject({
        name: 'my-app',
        path: mockDirPath,
        description: 'Test App',
      });
    });

    it('should recursively scan for projects', async () => {
      const mockRootPath = '/projects';
      
      // Mock readdir to return a sub-directory
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'sub-app', isDirectory: () => true } as any
      ]);

      // Mock access
      vi.mocked(fs.access).mockImplementation((p: any) => {
        if (p === path.join(mockRootPath, 'sub-app', 'package.json')) return Promise.resolve();
        return Promise.reject(new Error('File not found'));
      });

      const projects = await projectManager.scanDirectory(mockRootPath);
      
      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('sub-app');
    });

    it('should identify a directory with .venv as a project', async () => {
      const mockDirPath = '/projects/python-app';
      
      vi.mocked(fs.readdir).mockResolvedValue([]);
      
      vi.mocked(fs.access).mockImplementation((p: any) => {
        if (p === path.join(mockDirPath, '.venv')) return Promise.resolve();
        return Promise.reject(new Error('File not found'));
      });

      const projects = await projectManager.scanDirectory(mockDirPath);
      
      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('python-app');
    });
  });
});

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  const mockHomedir = '/mock/home';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('[]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    
    vi.mocked(loadDaemonConfig).mockResolvedValue({
      getModel: vi.fn().mockReturnValue('test-model'),
      getWorkspaceContext: vi.fn().mockReturnValue({
        addReadOnlyPath: vi.fn(),
        addDirectory: vi.fn(),
      }),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
      }),
      getMessageBus: vi.fn(),
      getToolRegistry: vi.fn().mockReturnValue({
        registerTool: vi.fn(),
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as any);

    sessionManager = new SessionManager();
  });

  describe('getOrCreate', () => {
    it('should create a new session if one doesn\'t exist', async () => {
      const chatId = 12345;
      const options = { cwd: '/test/path', model: 'test-model' };
      
      const session = await sessionManager.getOrCreate(chatId, options);
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBeDefined();
      expect(sessionManager.getSessionCount()).toBe(1);
    });

    it('should reuse an existing session', async () => {
      const chatId = 12345;
      const options = { cwd: '/test/path', model: 'test-model' };
      
      const session1 = await sessionManager.getOrCreate(chatId, options);
      const session2 = await sessionManager.getOrCreate(chatId, options);
      
      expect(session1).toBe(session2);
      expect(sessionManager.getSessionCount()).toBe(1);
    });
  });

  describe('destroy', () => {
    it('should destroy a session and dispose its config', async () => {
      const chatId = 12345;
      const options = { cwd: '/test/path', model: 'test-model' };
      
      const session = await sessionManager.getOrCreate(chatId, options);
      await sessionManager.destroy(chatId);
      
      expect(sessionManager.getSession(chatId)).toBeUndefined();
      expect(session.config.dispose).toHaveBeenCalled();
    });
  });
});
