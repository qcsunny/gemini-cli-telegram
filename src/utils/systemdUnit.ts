/**
 * @file systemdUnit.ts
 * @description Detect whether a PID is owned by a systemd service unit.
 *
 * Why this exists: when the daemon runs under systemd, sending it SIGTERM by
 * hand makes the unit exit `status=0/SUCCESS`. A unit with `Restart=on-failure`
 * only restarts on a *non-zero* exit, so the service settles into
 * `inactive (dead)` and the bot goes silently offline. The CLI therefore has to
 * recognise a systemd-owned process and refuse to signal or replace it.
 *
 * No unit name is hardcoded — whatever unit owns the PID is read back from the
 * kernel and echoed in the hint, so this keeps working if the unit is renamed.
 */

import * as fs from 'node:fs';

interface SystemdOwner {
  /** Unit name owning the process, e.g. `gemini-cli-telegram.service`. */
  unit: string;
  /** `'--user '` for a per-user manager unit, `''` for a system unit. Ready to splice into a systemctl command. */
  scope: string;
}

/**
 * Parse the contents of `/proc/<pid>/cgroup`.
 *
 * Handles cgroup v2 (`0::/path`) and v1 (`<id>:<controllers>:/path`). The *leaf*
 * segment must be the `.service` — for a `Type=simple` unit the leaf cgroup is
 * the unit itself. Requiring the leaf avoids the false positive where an
 * interactive process nests under `user@<uid>.service` but really lives in a
 * `session-N.scope` / `app-*.scope` leaf.
 *
 * @returns the owning unit, or `null` when the process is not a service.
 */
export function parseSystemdUnitFromCgroup(raw: string): SystemdOwner | null {
  for (const line of raw.split('\n')) {
    // v1 paths may legitimately contain ':' so rejoin everything after field 2.
    const cgPath = line.split(':').slice(2).join(':').trim();
    if (!cgPath) continue;

    const segments = cgPath.split('/').filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (!leaf || !leaf.endsWith('.service')) continue;
    // `user@<uid>.service` is the per-user manager, never a real workload unit.
    if (leaf.startsWith('user@')) continue;

    const userScope = segments.some(s => s.startsWith('user@') && s.endsWith('.service'));
    return { unit: leaf, scope: userScope ? '--user ' : '' };
  }
  return null;
}

/**
 * Resolve the systemd unit owning `pid`.
 *
 * @returns `null` when the process is not systemd-managed, is already gone, or
 * `/proc` is unavailable (non-Linux) — in which case the caller cannot tell and
 * should fall back to its normal behaviour.
 */
export function systemdOwnerForPid(pid: number): SystemdOwner | null {
  try {
    return parseSystemdUnitFromCgroup(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Human-readable explanation + the correct systemctl command, for a CLI that is
 * about to refuse an operation on a systemd-managed daemon.
 *
 * @param verb the systemctl verb to suggest (`stop` / `restart`).
 */
export function systemdRefusalMessage(pid: number, owner: SystemdOwner, verb: 'stop' | 'restart'): string {
  return [
    `Refusing to act on pid ${pid}: it is managed by systemd unit ${owner.unit}.`,
    `Signalling it directly makes the unit exit 0/SUCCESS, which Restart=on-failure`,
    `does NOT restart — the bot would stay offline.`,
    ``,
    `Use instead:  systemctl ${owner.scope}${verb} ${owner.unit}`,
  ].join('\n');
}
