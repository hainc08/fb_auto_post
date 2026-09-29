import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests never call real APIs: global fetch is mocked per test.
    unstubGlobals: true,
    restoreMocks: true,
    // Never send real email from tests (the local .env may hold SMTP credentials; dotenv does not override these)
    env: { SMTP_USER: '', SMTP_PASS: '' },
  },
});
