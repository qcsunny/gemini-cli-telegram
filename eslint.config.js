// Deliberately minimal: this project has no style linter and does not want one
// (tsc --strict already covers most of what a recommended-set would flag, and a
// noisy config never gets adopted). We opt in only to the *typed* rules that
// catch the failure classes this codebase has actually shipped bugs from:
//
//   no-floating-promises  — `void shutdown()` fire-and-forget swallowed the
//                           shutdown error and skipped process.exit (BUGFIXES 2026-08-12)
//   no-misused-promises   — async callbacks handed to grammy/setTimeout, whose
//                           rejections become unhandled
//   await-thenable        — `await` on a non-promise, i.e. a Promise-returning
//                           call lost its parentheses or a helper silently
//                           stopped being async
//
// Deliberately NOT enabled: `require-await`. Every one of its 7 hits here is a
// sync body behind an intentionally async contract (`StockProvider.searchSymbols`
// is declared `Promise<…>` in stock/types.ts; the watchlist service wraps sync
// better-sqlite3 but its siblings do network I/O). Satisfying it would mean
// either breaking those interfaces or 7 disable comments — both worse than the
// code as it stands.
//
// Add rules only when a real bug motivates them.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tools/**', // separate package with its own tsconfig
      'eslint.config.js',
    ],
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
);
