// Test-only stand-in for Deno's `npm:@supabase/supabase-js@x` specifier (see vite.config.ts alias).
// Tests install a fake client factory on globalThis before importing an edge function.
export const createClient = (...args: unknown[]) =>
  (globalThis as unknown as { __testCreateClient: (...a: unknown[]) => unknown }).__testCreateClient(...args);
