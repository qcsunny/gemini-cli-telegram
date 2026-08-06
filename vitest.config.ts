import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    clearMocks: true,
    env: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
  },
});
