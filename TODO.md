# TODO

## Immediate Fixes (Project Browsing)
- [ ] **Fix `ProjectManager.scanDirectory` depth limit**: Currently defaults to 1, which fails to find projects in common locations like `~/Documents/Coding/Project`. Increase default to 2 or 3.
- [ ] **Fix `ProjectManager.scanDirectory` entry limit**: Currently capped at 200 entries per directory. Large home directories often exceed this, causing project discovery to fail for directories later in the list. Increase to 1000.
- [ ] **Expand `~` in `/project_browse`**: The command currently doesn't handle paths starting with `~`. Add home directory expansion.
- [ ] **Standardize Scan Depth**: Ensure all paths (slash command, callback, auto-scan) use a consistent, sufficiently deep scan (e.g., depth 2).

## Project Discovery Improvements
- [ ] **Fallback Project Description**: If `package.json` is missing or lacks a description, attempt to extract the first non-header line from `README.md`.
- [ ] **Comprehensive Metadata Scan**: Continue scanning for description-rich files even after a project indicator (like `.git`) is found.
- [ ] **Expand Indicators**: Add more project markers (e.g., `.venv`, `environment.yml`).

## User Experience
- [ ] **Progress Indicators**: Show a "Scanning..." status or progress bar for deep directory scans in Telegram.
- [ ] **Better Error Handling**: Provide clearer feedback when directory access is denied due to permissions.
- [ ] **Configurable Limits**: Allow users to adjust scan depth and entry limits in `config.json`.

## Maintenance
- [ ] **Unit Testing**: Add dedicated tests for `ProjectManager` to verify depth and entry limit logic.
- [ ] **Cleanup**: Remove or archive reproduction scripts (`reproduce_browse.ts`, `test_depth.ts`, `test_entries.ts`) after fixes are verified.
