# Codebase Comments and Library Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supplement key codebase comments in English and refactor database, log, config, and CLI parsing logic with standard npm libraries.

**Architecture:** 
1. Add JSDoc/TS doc comments to all source files recursively.
2. Replace the custom `logger.ts` print logic with a `pino` instance. Define Zod validation schemas in `userConfig.ts` to parse the config.
3. Migrate `node:sqlite` DB queries to `better-sqlite3` and `drizzle-orm` queries with defined schemas.
4. Replace command validation in `cli.ts` with a `commander.Command` implementation.

**Tech Stack:** Node.js, TypeScript, Zod, Commander, Pino, Better-SQLite3, Drizzle-ORM.

## Global Constraints
*   All changes must compile cleanly (`npm run build`).
*   All 152 tests must pass successfully.
*   Existing environment setups and runtime properties must be fully preserved.

---

### Task 1: Add key comments in English to all codebase files

**Files:**
- Modify: All TypeScript source files in `src/` (excluding tests).

**Interfaces:**
- Produces: Comprehensively commented codebase.

- [ ] **Step 1: Document all source files**
  Supplement clean class/function headers, param descriptions, and symbol explanations in English.
  
- [ ] **Step 2: Verify tests**
  Run: `npm run build && npm test`
  Expected: PASS.

- [ ] **Step 3: Commit**
  ```bash
  git add -A
  git commit -m "docs: add English codebase comments to all source files"
  ```

---

### Task 2: Refactor configuration (Zod) and Logger (Pino)

**Files:**
- Modify: `src/utils/logger.ts`, `src/config/userConfig.ts`, and usages in files like `src/channels/telegram/bot.ts`.

- [ ] **Step 1: Implement Pino logger**
  Configure a standard pino instance (using `pino-pretty` in dev/local environments).
  
- [ ] **Step 2: Implement Zod schema validation**
  Define a `zod` schema to validate config file properties (AllowedUsers, token, proxies, etc.) on startup in `userConfig.ts`.
  
- [ ] **Step 3: Verify and Commit**
  Run: `npm run build && npm test`
  Expected: PASS.
  ```bash
  git add -A
  git commit -m "refactor: integrate pino logger and zod configuration validation"
  ```

---

### Task 3: Refactor Database to Better-SQLite3 and Drizzle-ORM

**Files:**
- Modify: `src/agy/conversationStore.ts`, `src/core/session.ts`

- [ ] **Step 1: Define schemas**
  Set up drizzle tables for sessions and histories.
  
- [ ] **Step 2: Migrate SQL queries**
  Replace raw SQLite statements with drizzle SELECT, INSERT, UPDATE queries.
  
- [ ] **Step 3: Verify and Commit**
  Run: `npm run build && npm test`
  Expected: PASS.
  ```bash
  git add -A
  git commit -m "refactor: migrate session storage to better-sqlite3 and drizzle-orm"
  ```

---

### Task 4: Refactor CLI entrypoint (Commander)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Integrate Commander**
  Replace argv slice logic in `cli.ts` with `commander` subcommands.
  
- [ ] **Step 2: Verify and Commit**
  Run: `npm run build && npm test`
  Expected: PASS.
  ```bash
  git add -A
  git commit -m "refactor: rewrite command line interface with commander"
  ```
