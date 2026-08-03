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
vi.mock('node:fs/promises');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
  };
});
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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

  describe('getProjectsInConfigOrder', () => {
    it('should return projects in load (insertion) order regardless of lastUsed', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        { id: 'p-a', name: 'Alpha', path: '/p/a', lastUsed: '2020-01-01T00:00:00Z' },
        { id: 'p-b', name: 'Beta', path: '/p/b', lastUsed: '2020-03-01T00:00:00Z' },
        { id: 'p-c', name: 'Gamma', path: '/p/c', lastUsed: '2020-02-01T00:00:00Z' },
      ]));

      await projectManager.loadProjects();

      expect(projectManager.getProjects().map(p => p.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
      expect(projectManager.getProjectsInConfigOrder().map(p => p.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
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
    it('should destroy a session', async () => {
      const chatId = 12345;
      const options = { cwd: '/test/path', model: 'test-model' };
      
      const session = await sessionManager.getOrCreate(chatId, options);
      expect(session).toBeDefined();
      await sessionManager.destroy(chatId);
      
      expect(sessionManager.getSession(chatId)).toBeUndefined();
    });
  });
});
