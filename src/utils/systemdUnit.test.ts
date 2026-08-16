/**
 * @file systemdUnit.test.ts
 * @description Tests for systemd unit detection. The cgroup samples are real
 * output captured from /proc on the host running this bot.
 */

import { describe, it, expect } from 'vitest';
import { parseSystemdUnitFromCgroup, systemdRefusalMessage } from './systemdUnit.js';

describe('parseSystemdUnitFromCgroup', () => {
  it('detects a systemd *user* service (real sample: the bot daemon)', () => {
    const raw = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service\n';
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-cli-telegram.service',
      scope: '--user ',
    });
  });

  it('detects a systemd *system* service and omits the --user flag', () => {
    const raw = '0::/system.slice/gemini-telegram.service\n';
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-telegram.service',
      scope: '',
    });
  });

  it('returns null for an interactive shell (real sample: login session scope)', () => {
    const raw = '0::/user.slice/user-1000.slice/session-12621.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('returns null when only the per-user manager is in the path, not a real unit', () => {
    // Regression guard: `user@1000.service` appears mid-path for ANY user process.
    // Matching it would make us refuse to stop manually started daemons.
    const raw = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('returns null when the leaf is a scope nested inside a service', () => {
    const raw = '0::/system.slice/some.service/payload.scope\n';
    expect(parseSystemdUnitFromCgroup(raw)).toBeNull();
  });

  it('parses cgroup v1 multi-line output', () => {
    const raw = [
      '12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '11:memory:/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gemini-cli-telegram.service',
      '',
    ].join('\n');
    expect(parseSystemdUnitFromCgroup(raw)).toEqual({
      unit: 'gemini-cli-telegram.service',
      scope: '--user ',
    });
  });

  it('returns null for empty or malformed input', () => {
    expect(parseSystemdUnitFromCgroup('')).toBeNull();
    expect(parseSystemdUnitFromCgroup('\n\n')).toBeNull();
    expect(parseSystemdUnitFromCgroup('garbage-without-colons')).toBeNull();
  });
});

describe('systemdRefusalMessage', () => {
  it('quotes the actual unit name and scope instead of a hardcoded command', () => {
    const msg = systemdRefusalMessage(1586001, { unit: 'my-bot.service', scope: '--user ' }, 'restart');
    expect(msg).toContain('pid 1586001');
    expect(msg).toContain('my-bot.service');
    expect(msg).toContain('systemctl --user restart my-bot.service');
  });

  it('explains why the bot would stay offline', () => {
    const msg = systemdRefusalMessage(42, { unit: 'x.service', scope: '' }, 'stop');
    expect(msg).toContain('Restart=on-failure');
    expect(msg).toContain('systemctl stop x.service');
  });
});
