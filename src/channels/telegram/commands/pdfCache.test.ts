import { describe, it, expect, beforeEach } from 'vitest';
import {
  isDocFileSupported,
  cacheDocument,
  getCachedDocument,
  clearCachedDocument,
  _clearAllDocumentsForTest,
} from './pdfCache.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpDir = path.join(os.tmpdir(), 'pdfCache-test');

beforeEach(async () => {
  _clearAllDocumentsForTest();
  await fs.mkdir(tmpDir, { recursive: true });
});

describe('isDocFileSupported', () => {
  it('should accept text and code extensions', () => {
    for (const name of ['a.txt', 'b.md', 'c.json', 'd.py', 'e.ts', 'f.yaml', 'g.log']) {
      expect(isDocFileSupported(name)).toBe(true);
    }
  });

  it('should accept pdf extension', () => {
    expect(isDocFileSupported('report.pdf')).toBe(true);
    expect(isDocFileSupported('report.PDF')).toBe(true);
  });

  it('should reject binary/media extensions', () => {
    for (const name of ['a.zip', 'b.jpg', 'c.mp4', 'd.exe', 'e.png', 'noext']) {
      expect(isDocFileSupported(name)).toBe(false);
    }
  });
});

describe('cacheDocument', () => {
  it('should copy the file into the per-user cache dir and return its path', async () => {
    const src = path.join(tmpDir, 'src.txt');
    await fs.writeFile(src, 'hello world');

    const result = await cacheDocument(12345, src, 'notes.txt');
    expect(result).not.toBeNull();
    expect(result!).toContain('documents');
    expect(result!).toContain('12345');
    expect(result!).toContain('notes.txt');

    const cached = getCachedDocument(12345);
    expect(cached?.fileName).toBe('notes.txt');
    expect(cached?.filePath).toBe(result);
    expect(await fs.readFile(result!, 'utf-8')).toBe('hello world');
  });

  it('should return null for unsupported file types', async () => {
    const src = path.join(tmpDir, 'a.zip');
    await fs.writeFile(src, 'data');
    const result = await cacheDocument(12345, src, 'archive.zip');
    expect(result).toBeNull();
    expect(getCachedDocument(12345)).toBeUndefined();
  });

  it('should isolate documents per user', async () => {
    const src = path.join(tmpDir, 's.txt');
    await fs.writeFile(src, 'data');
    await cacheDocument(1, src, 'user1.txt');
    await cacheDocument(2, src, 'user2.txt');

    expect(getCachedDocument(1)?.fileName).toBe('user1.txt');
    expect(getCachedDocument(2)?.fileName).toBe('user2.txt');

    clearCachedDocument(1);
    expect(getCachedDocument(1)).toBeUndefined();
    expect(getCachedDocument(2)?.fileName).toBe('user2.txt');
  });
});
