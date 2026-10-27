import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20271215000000_browser_extension.sql'),
  'utf8',
);
const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('browser extension migration', () => {
  it('is additive and idempotent', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.browser_extension_events/);
    expect(code).toMatch(/DROP POLICY IF EXISTS/);
  });

  it('protects the table: RLS on, clients read-only, service role writes', () => {
    expect(code).toMatch(/ALTER TABLE public\.browser_extension_events ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.browser_extension_events FROM authenticated, anon/,
    );
    expect(code).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('enforces idempotency per user, kind and request id', () => {
    expect(code).toMatch(/UNIQUE \(user_id, kind, request_id\)/);
  });

  it('pins search_path on every function and keeps prune private', () => {
    for (const f of code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) ?? [])
      expect(f).toMatch(/SET search_path = public/);
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION public.browser_extension_events_prune(integer) FROM PUBLIC, anon, authenticated;',
    );
    expect(code).toContain(
      'GRANT EXECUTE ON FUNCTION public.browser_extension_events_prune(integer) TO service_role;',
    );
  });
});
