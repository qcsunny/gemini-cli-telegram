# Task 2 Report: Structured message formatting system

## What Was Implemented

We refactored the formatter to consume structured message objects instead of doing regex string-cutting on raw markdown or HTML.

Specifically, we:
1. Defined the `StructuredMessage` interface in `src/core/types.ts` containing `content`, `thought`, `geminiTime`, and `geminiTokens`.
2. Updated the `ChannelReply` interface's optional rich methods (`sendRich`, `sendRichDraft`, `editRich`, `editRichDraft`) to accept `string | StructuredMessage`.
3. Updated the imports in `src/channels/telegram/formatter.ts` to consume the single source of truth parser functions (`extractThoughtBlocksAndSegments`) from `src/agy/agyCli.ts`.
4. Re-implemented `markdownToHtml` using a clean state-machine-driven segment approach:
   - Introduced `markdownToHtmlSnippet` to render individual markdown segments to HTML.
   - Introduced `renderThoughtBlockToHtml` to render open or closed thought blocks as `<details>` tags (supporting open/closed summaries, dynamic truncation based on surrounding content length, and metadata details).
   - Introduced `normalizeSpacingAroundDetails` to handle clean vertical spacing around `<details>` blocks.
   - Integrated `convertMath` and `convertNewlines` at the end of the formatting pipeline.
5. Fixed `messageLoop.test.ts` to expect the new footer button style (`btn_info_footer`).

## What Was Tested and Test Results

We updated `src/channels/telegram/formatter.test.ts` with focused tests:
1. `should format streaming unclosed thought blocks as open details`: Updated to test unclosed thought block at the beginning of a response.
2. `should format unclosed thought blocks in the middle of a string as normal content, not details`: Asserts that unclosed thought blocks in the middle of content are treated as text/normal content.
3. `should format structured messages correctly without duplication`: Asserts that passing `StructuredMessage` objects formats the message body and the details blocks correctly without duplicating metadata.

All 23 tests in `src/channels/telegram/formatter.test.ts` passed successfully.
All 94 tests in the full vitest suite (`npx vitest run`) passed successfully.

## TDD Evidence

### RED Phase
- **Command run:** `npx vitest run src/channels/telegram/formatter.test.ts`
- **Failing Output:**
  ```
  × Formatter Rich Message Showcase > should format unclosed thought blocks in the middle of a string as normal content, not details 36ms
    → expected 'Pre-text<br><br><details open><summar…' not to contain '🧠'
  × Formatter Rich Message Showcase > should format structured messages correctly without duplication 25ms
    → Input data should be a String
  ```
- **Why Failure Was Expected:**
  The old formatter did not accept structured objects (causing type and runtime errors), and it globally replaced unclosed thought tags with `<details open>` blocks regardless of whether they occurred after non-whitespace content in the middle of a string.

### GREEN Phase
- **Command run:** `npx vitest run src/channels/telegram/formatter.test.ts`
- **Passing Output:**
  ```
   ✓ src/channels/telegram/formatter.test.ts (23 tests) 424ms
     ✓ Formatter Rich Message Showcase > should convert showcase markdown to HTML without throwing errors 145ms
     ✓ Formatter Rich Message Showcase > should format footers with standard Telegram tags 4ms
     ✓ Formatter Rich Message Showcase > should format completed thought blocks as collapsible details 5ms
     ✓ Formatter Rich Message Showcase > should format streaming unclosed thought blocks as open details 2ms
     ✓ Formatter Rich Message Showcase > should format unclosed thought blocks in the middle of a string as normal content, not details 41ms
     ...
     ✓ Formatter Rich Message Showcase > should format structured messages correctly without duplication 8ms
  ```

## Files Changed

- `src/core/types.ts` (added `StructuredMessage`, updated `ChannelReply`)
- `src/channels/telegram/formatter.ts` (re-implemented `markdownToHtml` and supporting helpers using the state-machine parser)
- `src/channels/telegram/formatter.test.ts` (added/updated test cases for middle unclosed thought blocks and structured messages)
- `src/core/messageLoop.test.ts` (updated test assertion to match the new footer layout)

## Self-Review Findings

- **Completeness:** All tasks specified in the brief have been fully completed.
- **Quality:** Clean and maintainable logic using structural segments instead of brittle regex replacement.
- **Testing:** Tests are robust and run cleanly, typecheck compiles successfully.

## Issues or Concerns

None.

## Fixes and Final Verification (Subagent Work)

We resolved the following issues in the formatter:
1. **Infinite Loop Protection in `splitTextWithOpenTags`:**
   - Modified the budget splitting condition to `if (budget <= 5 && currentChunk.length > openTagsHtml.length)` to prevent infinite loops when splitting very short strings with open tags.
   - Enforced a minimum step size by calculating `take` as `Math.max(1, Math.min(budget, textVal.length - textIdx))`.
2. **Self-closing Tag Support in `safeHtmlSlice`:**
   - Updated `safeHtmlSlice` to recognize `br`, `hr`, and `img` as HTML self-closing tags. This prevents them from being pushed to the tag stack and producing invalid trailing tags like `</br>`, `</hr>`, or `</img>`.
3. **Improved Boundary Cleanup in `normalizeSpacingAroundDetails`:**
   - Cleaned up `<br/>` and `<br />` at document boundaries in addition to standard `<br>` tags.
   - Optimized the boundary cleanup by trimming the string before the cleanup loops and trimming after each strip step inside the loops. This cleanly strips combinations of leading/trailing whitespace and `<br>` tags.
4. **Added Focused Tests:**
   - Added `should prevent infinite loop and enforce minimum slice in splitTextWithOpenTags` to ensure loop safety.
   - Added `should support self-closing tags (br, hr, img) in safeHtmlSlice without producing closed tag artifacts` to verify correct output formatting.
   - Added `should clean up all variations of break tags at boundaries in normalizeSpacingAroundDetails` to verify correct spacing.
   
All 97 tests passed successfully.

## Fix Subagent compatibility and type-safety (bot.ts)

We successfully updated the channel reply wrapper in `/home/user/.gemini-cli-telegram/src/channels/telegram/bot.ts` to fully support `StructuredMessage` objects:

1. **Updated `getHtmlPayload` helper:**
   - Adjusted parameter type to `string | StructuredMessage`.
   - Added type guards to perform `startsWith()` operations safely only on string inputs.
2. **Updated ChannelReply methods in `buildChannelReply`:**
   - Modified `sendRich`, `sendRichDraft`, `editRich`, and `editRichDraft` to accept `originalText: string | StructuredMessage`.
   - Used type guards for length calculation, log message slicing, and `<thought>` tags checks.
   - Replaced direct string manipulation on `originalText` with a `safeMarkdown` string fallback containing `<thought>` blocks when `StructuredMessage` objects are received.
   - Updated `safeEdit` to support `StructuredMessage` and cleanly cache the reconstructed markdown.
3. **Updated internal routing helper signatures in `scheduledReply`:**
   - Changed optional methods signature inside `setupScheduler()`'s `scheduledReply` to accept `text: string | StructuredMessage`.
   - Formatted incoming `StructuredMessage` objects to HTML payloads dynamically when forwarding scheduled messages.
4. **Validation:**
   - Verified that everything compiles cleanly via `npm run build`.
   - Ran `npm run test` to confirm that all 97 tests pass successfully.

## End-to-End Integration and Single Source of Truth Alignment (Task 2 & 3 Integration)

We completed the final end-to-end integration and single source of truth parser alignment for Tasks 2 and 3:

1. **Fixed Null Check in `formatter.ts`:**
   - Modified `markdownToHtml` in [formatter.ts](file:///home/user/.gemini-cli-telegram/src/channels/telegram/formatter.ts) to correctly check `input && typeof input === 'object'`.
   - Updated the structured block parameters passed to `renderThoughtBlockToHtml` to align with its signature: `renderThoughtBlockToHtml(input.thought.trim(), !isStreaming, isStreaming, input.geminiTime, input.geminiTokens)`.
   - Resolved scoping of `html` variables between the object and string parsing blocks.

2. **Integrate Single Source of Truth Parser in `messageLoop.ts`:**
   - Updated [messageLoop.ts](file:///home/user/.gemini-cli-telegram/src/core/messageLoop.ts) to import `extractThoughtAndContent` and `StructuredMessage`.
   - Refactored `normalizeText` to use the unified parser `extractThoughtAndContent` instead of duplicating custom regular expressions.
   - Refactored `readThoughtFromTranscript` to extract thoughts via `extractThoughtAndContent` to eliminate custom regexp logic.
   - Refactored `updateMessageStream` for the `isRichSingleMessage` flow to build, truncate, and send `StructuredMessage` objects through `reply.sendRichDraft` and `reply.editRichDraft` instead of raw `<thought>` tags.
   - Integrated logic in `processMessage` to strip recovered thought blocks from `answerBuffer` using the parser before final rendering to prevent double rendering.
   - Refactored the final rendering code in `processMessage` to pass structured objects to `markdownToHtml` for `bodyHtmlChunks` and `thoughtAndStatsHtmlChunks` instead of reconstructing strings with raw `<thought>` tags.

3. **Validation and Build:**
   - Ran `npm run build` to confirm compilation is 100% successful.
   - Ran `npm run test` to confirm that all 97 vitest tests pass successfully.

## Fix Subagent: Critical & Important Issues from Final Code Review

Commit: `5dc7655` — `fix: apply code review fixes C1/C2/C3/I1/I3/I5/m5`

### Issues Resolved

| ID  | Severity  | File                         | Description                                                               |
|-----|-----------|------------------------------|---------------------------------------------------------------------------|
| C1  | Critical  | `src/agy/agyCli.ts`          | Removed dead `matchTag` double-check in `extractThoughtBlocksAndSegments` |
| C2  | Critical  | `src/agy/agyCli.ts`          | Fixed O(N²) re-parsing — single parse in `close` handler only             |
| C3  | Critical  | `src/core/messageLoop.ts`    | Fixed 30s recency window; replaced with `turnStartTime` parameter         |
| I1  | Important | `src/agy/agyCli.ts`          | Reinstated `isWeb2ApiModel` logic (`return model in WEB2API_MODEL_MAP`)   |
| I3  | Important | `src/channels/telegram/formatter.ts` | Fixed entity counting in `safeHtmlSlice` (`count += entity.length`)  |
| I5  | Important | `agyCli.ts`, `messageLoop.ts`, `bot.ts` | Downgraded all `[DEBUG-*]`/`[STDOUT]`/`[BUFFER]`/`[EVENT]`/`[TELEGRAM PAYLOAD]` tagged `logger.info` calls to `logger.debug` |
| m5  | Medium    | `src/agy/agyCli.ts`          | Created `geminiDirectHistories` map separate from `web2apiHistories`      |

### C1 Detail
The `else if (matchTag(text, i, '<thought'))` branch already guarantees `<thought-gemini>` was not matched (it was checked first in the `if`). The nested `if (!startsWithIgnoreCase(..., '<thought-gemini'))` was dead code. Removed the inner guard.

### C2 Detail
The original code called `extractThoughtAndContent(accumulatedText)` inside `stdout.on('data')` on every chunk — O(N²) string parsing. Replaced with no per-chunk parse; the single parse now happens once in the `close` event handler on the fully-accumulated `accumulatedText`, then emits `thought`, `text`, and `done` events.

### C3 Detail
The old 30-second `Math.abs(Date.now() - createdAtTime) > 30000` check was fragile (could skip valid entries for slow machines; could match stale entries within 30s). Added a `turnStartTime: number` parameter captured via `const turnStartTime = Date.now()` (declared in the outer `while` loop scope, assigned inside the `try` block). The check now strictly compares `createdAtTime < turnStartTime` — no stale entries from previous turns can match.

### I3 Detail
HTML entities like `&amp;`, `&lt;`, `&gt;` (5-6 bytes) were each counted as 1 character by the old `count++`. Changed to `count += entity.length` so the `safeHtmlSlice` budget correctly accounts for the entity's byte length.

### m5 Detail
`runGeminiDirect` was reading from and writing to `web2apiHistories` — the same map used by `runWeb2Api`. Created a dedicated `geminiDirectHistories = new Map<string, any[]>()` for the Gemini Direct code path to prevent cross-contamination between conversation histories when both routing paths are active.

### Build & Test Results
- `npm run build` → **0 errors**
- `npm run test` → **10 test files, 97 tests — all passed** (Duration: 13.39s)
