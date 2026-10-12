import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// dotenv (above) loads .env without overriding variables already set in the environment.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Tests only run against a dedicated database whose name ends in "_test"; add it to .env (see .env.example).',
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['tests/utils/globalSetup.ts'],
    setupFiles: ['tests/utils/workerGuard.ts'],
    // Database tests share one test database and may truncate tables: run files one at a time.
    fileParallelism: false,
    env: {
      // The code under test (src/config, global pool) must only ever see the test database.
      DATABASE_URL: testDatabaseUrl,
      // Tests must not depend on the developer's storage settings in .env.
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_SIGNING_SECRET: 'test-only-signing-secret-0123456789abcdef',
      // Fixed test-only key (32 bytes of 0x01); never a real one.
      SECRETS_KEYS: '1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      SECRETS_ACTIVE_KEY_VERSION: '1',
    },
  },
});
