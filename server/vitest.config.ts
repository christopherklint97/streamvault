import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Packaging scripts use node:test and are exercised separately in CI.
    include: ['src/**/*.test.ts'],
  },
});
