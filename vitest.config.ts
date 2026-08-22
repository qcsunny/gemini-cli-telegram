import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    target: 'node22',
  },
  cacheDir: './node_modules/.vitest',
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        // Single-thread is fastest for this suite: per-worker Vite transform
        // of the full module graph costs more than the wall-clock savings
        // from parallel file execution (measured: 25s single vs 44s x4 / 56s x2).
        singleThread: true,
      },
    },
    reporters: [['default', { summary: false }]],
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'tools/**', 'scratch/**', '.agents/**'],
    testTimeout: 20000,
    clearMocks: true,
    env: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      GEMINI_TELEGRAM_DB_PATH: ':memory:',
    },
  },
});