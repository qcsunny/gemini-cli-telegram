import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('messageStore', () => {
  let tmpDbPath: string;
  let saveMessage: typeof import('./messageStore.js').saveMessage;
  let loadMessages: typeof import('./messageStore.js').loadMessages;
  let clearMessages: typeof import('./messageStore.js').clearMessages;

  beforeAll(async () => {
    // Clear any default cached DB connections from other tests
    const { closeDb } = await import('../db/index.js');
    closeDb();

    // Point the DB env var to a temp file for these tests
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-store-test-'));
    tmpDbPath = path.join(tmpDir, 'test.sqlite');
    process.env['GEMINI_TELEGRAM_DB_PATH'] = tmpDbPath;

    const mod = await import('./messageStore.js');
    saveMessage = mod.saveMessage;
    loadMessages = mod.loadMessages;
    clearMessages = mod.clearMessages;
  }, 10000);

  afterAll(async () => {
    // Close the temporary database connection to release the file handle
    const { closeDb } = await import('../db/index.js');
    closeDb();

    delete process.env['GEMINI_TELEGRAM_DB_PATH'];
    if (tmpDbPath) {
      try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-shm'); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(tmpDbPath)); } catch { /* ignore */ }
    }
  });

  it('should save and load messages for a conversation', () => {
    saveMessage('conv-1', 'user', 'Hello', 'web2api');
    saveMessage('conv-1', 'assistant', 'Hi there!', 'web2api');

    const msgs = loadMessages('conv-1', 'web2api');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
  });

  it('should not mix messages from different backends', () => {
    saveMessage('conv-mix', 'user', 'deepseek msg', 'deepseek');
    const msgs = loadMessages('conv-mix', 'web2api');
    expect(msgs).toHaveLength(0);
  });

  it('should clear messages for a conversation', () => {
    saveMessage('conv-clear', 'user', 'Hello', 'web2api');
    clearMessages('conv-clear', 'web2api');
    const msgs = loadMessages('conv-clear', 'web2api');
    expect(msgs).toHaveLength(0);
  });
});
