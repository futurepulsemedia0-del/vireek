import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Red-team harness config. Deterministic, no network, no LLM calls. The edge-runtime `npm:` specifier used by
// ai-core/aiSecurity.ts is mapped to the installed package so the REAL production scanner is exercised.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      'npm:@supabase/supabase-js@2.57.4': fileURLToPath(new URL('./node_modules/@supabase/supabase-js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['eval/voice-redteam/**/*.redteam.ts', 'eval/agent-actions-redteam/**/*.redteam.ts'],
    testTimeout: 60_000,
  },
});
