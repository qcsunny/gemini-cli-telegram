import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './node_modules/.vitest',
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    testTimeout: 20000,
    clearMocks: true,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
        },
      },
    },
    env: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      GEMINI_TELEGRAM_DB_PATH: ':memory:',
    },
  },
});