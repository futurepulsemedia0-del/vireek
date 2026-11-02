import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import vireekBlog from './scripts/blog/vite-plugin.mjs'

/// <reference types="vitest/config" />
export default defineConfig({
  plugins: [react(), vireekBlog()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/*.live.test.ts', '**/*.built.test.mjs'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts', 'src/main.tsx', 'src/locales/**', 'src/i18n/**'],
      // Ratchet: raise these after reading the summary from `npm run test -- --coverage`.
      thresholds: {
        statements: Number(process.env.COV_STATEMENTS ?? 10),
        branches: Number(process.env.COV_BRANCHES ?? 10),
        functions: Number(process.env.COV_FUNCTIONS ?? 10),
        lines: Number(process.env.COV_LINES ?? 10),
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
      // Test-only: lets Vitest import Deno edge functions that use the npm: specifier.
      'npm:@supabase/supabase-js@2.57.4': '/src/test/stubs/supabaseNpm.ts',
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-motion': ['framer-motion'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
})
