import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    env: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
  },
});
