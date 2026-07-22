import { describe, it, expect } from 'vitest';

describe('escapeHtml', () => {
  it('should escape HTML special characters', async () => {
    const { escapeHtml } = await import('./ui.js');
    // Note: escapeHtml does NOT escape double quotes, only & < >
    expect(escapeHtml('<b>bold</b> & "quoted"')).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; "quoted"');
  });

  it('should return empty string for empty input', async () => {
    const { escapeHtml } = await import('./ui.js');
    expect(escapeHtml('')).toBe('');
  });

  it('should leave safe strings unchanged', async () => {
    const { escapeHtml } = await import('./ui.js');
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('truncate', () => {
  it('should truncate long text with ellipsis', async () => {
    const { truncate } = await import('./ui.js');
    // truncate slices at maxLength - 1, then appends '…'
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('should not truncate short text', async () => {
    const { truncate } = await import('./ui.js');
    expect(truncate('hello', 10)).toBe('hello');
  });
});

describe('formatWelcome', () => {
  it('should include user name when provided', async () => {
    const { formatWelcome } = await import('./ui.js');
    const result = formatWelcome('Alice');
    expect(result).toContain('Alice');
  });

  it('should work without user name', async () => {
    const { formatWelcome } = await import('./ui.js');
    const result = formatWelcome();
    expect(result).toContain('Welcome');
    expect(result).toContain('Gemini CLI');
  });
});

describe('formatHelp', () => {
  it('should include list of available commands', async () => {
    const { formatHelp } = await import('./ui.js');
    const result = formatHelp();
    expect(result).toContain('/model');
    expect(result).toContain('/save');
    expect(result).toContain('/new');
  });
});

describe('formatSessionStats', () => {
  it('should format session statistics without errors', async () => {
    const { formatSessionStats } = await import('./ui.js');
    const result = formatSessionStats({
      sessionId: 'session-abc-123',
      model: 'Gemini 3.5 Flash',
      turnCount: 42,
      project: { id: 'proj-1', name: 'My Project', path: '/home/project' },
      createdAt: new Date(),
      activeSessions: 3,
    });
    expect(result).toContain('Gemini 3.5 Flash');
    expect(result).toContain('42');
  });
});
