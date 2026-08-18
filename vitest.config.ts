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