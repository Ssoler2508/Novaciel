import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests must not depend on the developer's storage settings in .env.
    env: {
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_SIGNING_SECRET: 'test-only-signing-secret-0123456789abcdef',
    },
  },
});
