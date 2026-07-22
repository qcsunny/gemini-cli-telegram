# Codebase Comments and Library Refactoring Design Specification

This specification details the incremental implementation of key code comments and the integration of Zod, Commander, Pino, Better-SQLite3, and Drizzle-ORM.

## Goal
Improve codebase maintainability, safety, and performance. By adding detailed English comments to all files and replacing experimental or custom code with standard, high-performance library packages, we ensure the project is stable for long-term production.

## Implementation Roadmap (4 Stages)

### Stage 1: Key Code Comments (English)
*   Supplement key English documentation and function/class-level comments to all 23 source files.
*   Retain all existing code behavior and pass all tests.
*   **Git Checkpoint:** `docs: add English codebase comments to all source files`.

### Stage 2: Pino Logger & Zod Configuration Validation
*   **Pino Logging:** Replace the manual logger in `logger.ts` with `pino` and `pino-pretty` (in development mode).
*   **Zod Configuration Schema:** Define a strict Zod configuration schema in `userConfig.ts` to parse and validate `config.json` on startup.
*   **Git Checkpoint:** `refactor: integrate pino logger and zod configuration validation`.

### Stage 3: Better-SQLite3 & Drizzle-ORM
*   **DB Setup:** Replace the experimental Node.js native sqlite with `better-sqlite3`.
*   **Drizzle ORM Integration:** Define schemas for active sessions and conversation histories, and migrate SQLite queries to Drizzle queries.
*   **Git Checkpoint:** `refactor: migrate session storage to better-sqlite3 and drizzle-orm`.

### Stage 4: Commander CLI
*   **Command Parsing:** Refactor `cli.ts` to use `commander` for robust subcommand validation (start, setup, auth, logs, status) and auto-generated help menus.
*   **Git Checkpoint:** `refactor: rewrite command line interface with commander`.

---

## Verification Plan
*   Run `npm run build && npm test` at the end of each stage.
*   Ensure that all 152 unit tests pass cleanly.
