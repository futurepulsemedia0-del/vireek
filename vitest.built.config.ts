import { defineConfig } from 'vite';

/// <reference types="vitest/config" />
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.built.test.mjs'],
    exclude: ['**/node_modules/**'],
    testTimeout: 30000,
  },
});
