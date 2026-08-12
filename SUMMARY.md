# Anchored Summary (generated 2026-08-12)

## Objective
- Keep the repo documentation aligned with current architecture and deployment.
- Reflect the latest robustness hardening (v1.17.2+).

## Important Details
- **Native agy CLI** stores each conversation in `~/.gemini/antigravity-cli/conversations/{convId}.db` with a `steps` table; each step's `metadata` blob is protobuf-encoded usage.
- **Protobuf field semantics** (confirmed via statusline.py and live data): field 2=input (new tokens, independent), 3=output (total output **including** thinking), 5=cached (independent), 10=thinking (subset of output, for display only, no separate charge).
- **statusline.py billing formula**: `cost = input*rate + cached*rate*0.25 + output*rate` — no separate thinking cost.
- **Deployment is user-space systemd**: `systemctl --user ... gemini-cli-telegram.service`; `loginctl enable-linger` keeps the daemon alive after SSH logout. Never `sudo`; never launch `node dist/cli.js start --live` ad-hoc (409 Conflict loops, see AGENTS.md).
- **Build-first rule**: the service runs `dist/cli.js`, so every `src/` change requires `npm run build` before `systemctl --user restart`.

## Work State
### Completed
- **Robustness hardening (v1.17.2, commit `f68ee56`)**:
  - Command injection removed: outbound curl fallback now uses `spawn` + argv array instead of shell-string `exec`.
  - Child-process lifecycle: SIGINT→SIGKILL escalation (5s) on abort in agyCli/opencode; `destroyAll()` stops the scheduler and waits; graceful shutdown with 15s force-exit fallback and `closeDb()`.
  - Exchange-rate `_fetching` guard now resets in a `finally` (TTL 24h refresh works again).
  - `setup` no longer drops unrelated config fields; `saveUserConfig` writes atomically (tmp+rename) and invalidates the cache.
  - DB: `busy_timeout=5000`, `PRAGMA user_version` schema stamping, explicit open-failure errors.
  - Messages persisted atomically via `saveMessageTurn()` (transaction), empty assistant rows skipped; `/reset` purges orphaned `messages` rows.
  - `uncaughtException` now triggers graceful shutdown (systemd restarts) instead of running in corrupted state.
  - PID identity verification via `/proc/<pid>/cmdline` prevents killing recycled PIDs on `stop`/`status`.
- **Previous highlights** (from earlier anchored summary): footnote `reference_link`/`reference` support; `readUsageFromDatabase()` sums all steps; no separate thinking cost; `[object Object]` footnote fix in `blocks.ts`.
- **Releases**: v1.1.2 → v1.17.2 published on GitHub; service restarted after each.
- **No geminiDirect anymore** — all models go through local agy / web2api / deepseek / opencode backends.

### Active
- (none)

### Blocked
- (none)

## Next Move
- Commit and push doc updates (README.md, README.en.md, SUMMARY.md).
- Continue SemVer 2.0.0 (1.17.x patch line until 1.17.9, then minor).