import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20271102000000_synthetic_monitoring_slo.sql'), 'utf8');

describe('synthetic monitoring migration', () => {
  it('enables RLS on every new table and defines no direct policies', () => {
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBe(7);
    for (const t of tables) expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });

  it('only lets probes target synthetic tenants and only cleans those tenants', () => {
    expect(sql).toMatch(/is_synthetic_tenant/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF tenant_user_id/);
    expect(sql).toMatch(/USING public\.profiles p[\s\S]*p\.is_synthetic_tenant/);
  });

  it('locks service-only functions away from anon/authenticated and staff RPCs behind the operator check', () => {
    for (const fn of ['synthetic_claim_due_targets(integer)', 'synthetic_open_incident(text, text, text, text, text, text)', 'synthetic_resolve_incident(text, text)', 'public_status_feed()', 'synthetic_purge_artifacts(integer, integer)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated`);
    }
    expect(sql).toMatch(/IF NOT public\.synthetic_is_operator\(\)/);
  });

  it('is idempotent and tolerates a missing pg_cron', () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE NOTICE 'pg_cron schedule skipped/);
  });
});
