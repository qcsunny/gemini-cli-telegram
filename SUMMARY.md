# Anchored Summary (generated 2026-07-26 19:14)

## Objective
- Fix token accounting, pricing, and add native Telegram footnote support for the bot.

## Important Details
- **Native agy CLI** stores each conversation in `~/.gemini/antigravity-cli/conversations/{convId}.db` with a `steps` table; each step's `metadata` blob is protobuf-encoded usage.
- **Protobuf field semantics** (confirmed via statusline.py and live data): field 2=input (new tokens, independent), 3=output (total output **including** thinking), 5=cached (independent), 10=thinking (subset of output, for display only, no separate charge).
- **statusline.py billing formula**: `cost = input*rate + cached*rate*0.25 + output*rate` — no separate thinking cost.
- **Telegram Bot API 10.2 Rich Messages** support bidirectional footnote navigation via `reference_link` (body→footnote) and `reference` (footnote→body) inline text entities.
- **Local agy** interleaves `<thinking>` tags with content in the same stream — true typewriter streaming is not possible for native agy (proxy backends like web2api/deepseek have separate SSE fields for reasoning vs content, so they can stream).
- **通用知识专家_RichText project** at `/home/qcsunny/Documents/通用知识专家_RichText/.agents/AGENTS.md` — model prompt for rich text formatting and citation syntax.

## Work State
### Completed
- **Accumulate all steps in `readUsageFromDatabase()`**: fixed to sum all steps' usage instead of returning only the last step.
- **Removed separate `thinkingCost` from `calculateCost()`**: matching statusline.py — output (field 3) already includes thinking, no separate charge.
- **Reverted incorrect input caching subtraction**: confirmed input (field 2) and cached (field 5) are independent, not overlapping.
- **Native footnote support**: `preprocessFootnotes()` in `blocks.ts` extracts `[^id]:` definitions, converts `[^id]` body markers to `reference_link` entities (clickable citations), and appends `reference` entity blocks with back-links.
- **Updated project prompt**: added footnote citation instructions (`[^id]` syntax) to AGENTS.md.
- **Deleted** `Telegram_Bot_API_10.2_RichText_Doc.md` from the project directory.
- **Releases**: v1.1.2 → v1.1.6 published on GitHub, service restarted after each.
- **No geminiDirect anymore** — all models go through local agy now.
- **Removed** `getCumulativeUsage()` from `messageStore.ts` and opencode.db reading logic.
- **Fixed `[object Object]` in footnotes** (2026-07-26): `blocks.ts:177-178` changed `String(inner)` → `inner` so `reference`/`reference_link` entities nested inside superscripts aren't flattened to `[object Object]`. Type definition updated at line 45-46 to accept `RichText` instead of `string`.

### Active
- (none)

### Blocked
- (none)

## Next Move
- Commit and push all fixes. Restart service.
- Tag a new release (v1.1.7).
