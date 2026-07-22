# Error Log Isolation (Scheme 3 + Scheme 1) Design Specification

This specification details the design for isolating `ERROR` logs to a dedicated file (`error.log`) and ensuring it is rotated properly along with the main `daemon.log`.

## Goal
Improve error visibility and troubleshooting efficiency by separating high-priority error events from normal verbose or streaming logs. The main logs will continue to flow to `daemon.log` (readable with `pino-pretty`), while critical errors are simultaneously persisted to a separate, high-priority `error.log`.

## Design Details

### 1. Error Log File Path
*   The isolated error log file will be saved at:
    `~/.gemini-cli-telegram/error.log` (which maps to `/home/qcsunny/.gemini-cli-telegram/error.log`).

### 2. Implementation in logger.ts
*   Import `path`, `os`, and `fs` modules in [src/utils/logger.ts](file:///home/qcsunny/.gemini-cli-telegram/src/utils/logger.ts).
*   Define `CONFIG_DIR` and `ERROR_LOG_PATH`.
*   Inside `logger.error()`, after logging to `pinoInstance.error()`, append the formatted error message with an ISO timestamp to `error.log` synchronously:
    ```typescript
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] ERROR: ${formatted}\n`, 'utf-8');
    ```
*   Wrap the file operation in a `try-catch` block to ensure that database, network, or permission errors on writing the log file never crash the primary execution flow (fail-silent logger constraint).

### 3. Logrotate Configuration Updates
*   Update [scripts/logrotate.conf](file:///home/qcsunny/.gemini-cli-telegram/scripts/logrotate.conf) to match both `daemon.log` and `error.log` for daily rotation:
    ```
    /home/qcsunny/.gemini-cli-telegram/daemon.log
    /home/qcsunny/.gemini-cli-telegram/error.log {
      daily
      rotate 7
      compress
      delaycompress
      missingok
      notifempty
      copytruncate
    }
    ```

## Verification Plan
1. Add a unit test in `src/utils/logger.test.ts` that triggers `logger.error` and asserts that `error.log` has been written to.
2. Run `npm run build && npm test` to verify zero compile errors and all tests pass.
