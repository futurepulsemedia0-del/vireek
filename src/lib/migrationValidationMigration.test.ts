import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(process.cwd(), 'supabase/migrations/20290307000000_migration_validation.sql'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('migration validation SQL', () => {
  it('is additive and idempotent', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.migration_checklist_progress/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.migration_control_totals/);
    for (const m of code.matchAll(/CREATE POLICY "([^"]+)" ON ([\w.]+)/g)) {
      expect(code, `${m[1]} is preceded by DROP POLICY IF EXISTS`).toContain(`DROP POLICY IF EXISTS "${m[1]}" ON ${m[2]}`);
    }
  });
  it('enables RLS on every new table and scopes every policy to the account owner', () => {
    for (const t of ['migration_checklist_progress', 'migration_control_totals']) expect(code).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(6);
    for (const p of policies) expect(p).toContain('public.get_account_owner_id()');
  });
  it('limits every write policy to people who may run imports', () => {
    const writes = (code.match(/CREATE POLICY[\s\S]*?;/g) ?? []).filter((p) => /FOR (INSERT|UPDATE|DELETE)/.test(p));
    expect(writes.length).toBe(4);
    for (const p of writes) expect(p).toContain('public.can_run_data_imports()');
  });
  it('snapshot function is invoker-rights, permission-gated, source-whitelisted and not callable by anon', () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.migration_validation_snapshot[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain('SECURITY INVOKER');
    expect(fn).toContain('SET search_path = public');
    expect(fn).toContain('can_run_data_imports()');
    expect(fn).toContain("p_source NOT IN ('service_titan', 'jobber', 'housecall_pro', 'csv')");
    expect((fn.match(/user_id = v_owner/g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(code).toContain('REVOKE ALL ON FUNCTION public.migration_validation_snapshot(text) FROM PUBLIC, anon');
  });
});
