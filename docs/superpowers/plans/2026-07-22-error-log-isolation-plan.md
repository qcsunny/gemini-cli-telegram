# Error Log Isolation (Scheme 3 + Scheme 1) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement simultaneous error logging to `error.log` in `logger.ts` and update `scripts/logrotate.conf` to rotate it.

---

### Task 1: Update logger and logrotate config

**Files:**
- Modify: `src/utils/logger.ts`, `scripts/logrotate.conf`, `src/utils/logger.test.ts`

- [ ] **Step 1: Update logger.ts**
  Import `path`, `os`, and `fs`. Define `ERROR_LOG_PATH` and append formatted error messages synchronously inside `logger.error` using `fs.appendFileSync` wrapped in a try-catch block.

- [ ] **Step 2: Update logrotate.conf**
  Edit `scripts/logrotate.conf` to include both `/home/qcsunny/.gemini-cli-telegram/daemon.log` and `/home/qcsunny/.gemini-cli-telegram/error.log` in the rotation target.

- [ ] **Step 3: Update logger unit tests**
  Update `src/utils/logger.test.ts` to test that triggering `logger.error` actually writes to the error log file. Clean up the temp test file after verification.

- [ ] **Step 4: Verify and Commit**
  Run `npm run build && npm test` and ensure all 194+ tests pass cleanly.
  Commit:
  ```bash
  git add -A
  git commit -m "refactor(logger): isolate error logs to a separate error.log file and update logrotate"
  ```
