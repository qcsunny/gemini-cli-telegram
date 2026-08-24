# Anchored Summary (generated 2026-08-20)

## Objective
- Keep the repo documentation aligned with current architecture and deployment.
- Current release line: **v1.25.6**.

## Important Details
- **Six model backends**, routed by display-name prefix in `runAgyPrint()` (src/agy/agyCli.ts): `Web2API:` → web2api HTTP proxy (:8083), `DeepSeek:` → deepseek proxy (:5001), `OpenCode:` → opencode CLI (run --format json), `Claude CLI:` → claude -p, `Codex:` → codex exec, others → native agy subprocess.
- **5 capability tiers** (config.json `modelsConfig.tiers` / src/config/models.json): T0 旗舰推理 (5) → T1 高级推理 (4) → T2 通用能力 (6) → T3 轻量与免费 (5) → T4 远程备用 (14). 34 models total across 6 channels.
- **Tier-aware monotonic fallback**: `buildTierAwareChain()` (src/core/modelRegistry.ts) builds a strictly-descending chain; each model retried `retriesPerModel` (default 3); total budget = chain.length × retriesPerModel. `backendHealth.ts` skips cooldown channels (30s→5min exponential, persisted in `runtime_states`).
- **🤖 Auto smart router** (src/core/router.ts, committed as `7e19666`): `Web2API: Gemini 3.5 Flash Lite` pre-classifies A/B/C with a 2.5s timeout, heuristic fallback (`classifyHeuristic`), maps A→T0 first, B→T1 first, C→T4 free Web2API. Entry: `/model auto` / keyboard `🤖 Auto` button.
- **Ephemeral draft streaming** (private chats, `tuning.useRichDraftPrivate`): `sendRichMessageDraft` preview + 20s heartbeat keep-alive + native `thinking` pill (`tuning.richDraftThinkingInPill`), persisted once at finalize via `sendRichMessage`. 4-tier rich fallback: blocks → HTML → markdown → plain.
- **Config priority**: config.json `orderedModels` → config.json `modelsConfig.tiers` → models.json tiers/defaultOrder. `channelOrder` field removed.
- **Deployment is user-space systemd**: `systemctl --user restart gemini-cli-telegram.service`; service runs `dist/cli.js` so every `src/` change requires `npm run build` first. Logs only in project `logs/` (pino direct file; journalctl empty). Never `sudo`; never ad-hoc `node dist/cli.js start --live` / `stop` (409 loops / silent down).
- **Testing**: 18 files / 539 tests, all green. `npm run test:changed` for incremental runs.

## Work State
### Completed
- **v1.24.0**: native ephemeral rich-message draft for private chats (sendRichMessageDraft preview + 20s heartbeat + native thinking animation, persisted via sendRichMessage as a new real message).
- **Robustness hardening (v1.17.x line)**: spawn argv (no shell injection), SIGINT→SIGKILL escalation, atomic config save, DB busy_timeout + schema stamping, PID identity verification, graceful shutdown.
- **Backend expansion**: local Claude CLI (Claude Opus 5) and Codex CLI (GPT-5.6 Sol) backends; duplicate OpenCode model config removed.
- **Value-investing pipeline unified**: `/invest` keyboard entry now shares the value-invest-analysis script path with inline (both spawn `dist/bin/json.js`, inject full report JSON). Dividend-yield uses trailing-12-month `PRETAX_BONUS_RMB`.
- **Ops features**: `/usage` token breakdown, `/backends` health monitor, `/export` markdown, `/compare` alias, sqlite WAL maintenance.

### Active
- **In-flight**: comment audit sweep (10 stale comments fixed across 9 files; extraFiles opencode `--file` wiring committed as `46b688a`).

### Blocked
- (none)

## Next Move
- Run integration tests against live backends; release as **v1.25.7** or next PATCH via Tag + GitHub Release + service restart.