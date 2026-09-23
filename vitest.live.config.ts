import { defineConfig } from 'vite';

/// <reference types="vitest/config" />
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
    testTimeout: 20000,
  },
});
