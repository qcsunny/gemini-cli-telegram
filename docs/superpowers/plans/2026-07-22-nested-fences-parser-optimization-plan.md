# Nested Code Fences Parser Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize `normalizeNestedCodeFences` in `src/channels/telegram/formatter/core.ts` to support multi-level nested code block fence upgrades, ensuring the outermost block has the highest backtick count.

---

### Task 1: Update nested fences upgrade logic and add tests

**Files:**
- Modify: `src/channels/telegram/formatter/core.ts`, `src/channels/telegram/formatter.test.ts`

- [ ] **Step 1: Implement propagation of maxInnerCount**
  In `src/channels/telegram/formatter/core.ts` under `normalizeNestedCodeFences()`, update the fence tracking logic to update `item.maxInnerCount` for all entries in the stack instead of just the top one.

- [ ] **Step 2: Add unit tests**
  In `src/channels/telegram/formatter.test.ts`, add a test case verifying that a 3-level nested code block (e.g. ```` -> ``` -> ````) upgrades all parent fences correctly.

- [ ] **Step 3: Compile and Test**
  Run: `npm run build && npm test`
  Expected: All 160+ tests pass cleanly.

- [ ] **Step 4: Commit**
  ```bash
  git add -A
  git commit -m "refactor(formatter): optimize nested code fences parsing with stack propagation"
  ```
