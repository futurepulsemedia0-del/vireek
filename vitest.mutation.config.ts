// vitest.mutation.config.ts
//
// Vitest config used ONLY by Stryker (see stryker/*.conf.mjs). It is deliberately separate from the
// app config in vite.config.ts: mutation runs execute the suite thousands of times, so this one
// uses the plain Node environment (no jsdom, no React plugin, no blog plugin, no setup file) and
// lists only the tests that cover the three pilot modules. Add a test file here when you add a module
// to a stryker config. Normal `npm test` is unaffected.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    css: false,
    include: [
      // money: src/lib/regionConfig/money.ts
      'src/lib/regionConfig/money.test.ts',
      // compliance rules: supabase/functions/_shared/compliance-rules/{engine,jurisdiction,fmSubmission}.ts
      'supabase/functions/_shared/compliance-rules/engine.test.ts',
      'supabase/functions/_shared/compliance-rules/fmSubmission.test.ts',
      // scoring engine: src/lib/fragilityScore.ts
      'src/lib/fragilityScore.test.ts',
    ],
  },
})
