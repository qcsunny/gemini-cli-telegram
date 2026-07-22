import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('messageStore', () => {
  let tmpDbPath: string;

  beforeAll(() => {
    // Point the DB env var to a temp file for these tests
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-store-test-'));
    tmpDbPath = path.join(tmpDir, 'test.sqlite');
    process.env['GEMINI_TELEGRAM_DB_PATH'] = tmpDbPath;
  });

  afterAll(() => {
    delete process.env['GEMINI_TELEGRAM_DB_PATH'];
    if (tmpDbPath) {
      try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-shm'); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(tmpDbPath)); } catch { /* ignore */ }
    }
  });

  it('should save and load messages for a conversation', async () => {
    const { saveMessage, loadMessages } = await import('./messageStore.js');

    saveMessage('conv-1', 'user', 'Hello', 'web2api');
    saveMessage('conv-1', 'assistant', 'Hi there!', 'web2api');

    const msgs = loadMessages('conv-1', 'web2api');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
  });

  it('should not mix messages from different backends', async () => {
    const { saveMessage, loadMessages } = await import('./messageStore.js');

    saveMessage('conv-mix', 'user', 'deepseek msg', 'deepseek');
    const msgs = loadMessages('conv-mix', 'web2api');
    expect(msgs).toHaveLength(0);
  });

  it('should clear messages for a conversation', async () => {
    const { saveMessage, loadMessages, clearMessages } = await import('./messageStore.js');

    saveMessage('conv-clear', 'user', 'Hello', 'web2api');
    clearMessages('conv-clear', 'web2api');
    const msgs = loadMessages('conv-clear', 'web2api');
    expect(msgs).toHaveLength(0);
  });
});
