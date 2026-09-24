import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests never call real APIs: global fetch is mocked per test.
    unstubGlobals: true,
    restoreMocks: true,
  },
});
