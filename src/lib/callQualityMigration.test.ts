import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static contract checks for the AI Quality Center SQL: the safety properties the
// design depends on (read-only tables, gated policies, safe definer functions,
// idempotent DDL) are asserted here so a later edit cannot quietly weaken them.

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271102000000_ai_quality_center.sql'), 'utf8');
const client = readFileSync(resolve(process.cwd(), 'src/lib/callQuality.ts'), 'utf8');
const fn = readFileSync(resolve(process.cwd(), 'supabase/functions/call-quality-review/index.ts'), 'utf8');

const TABLES = ['ai_quality_rules', 'ai_quality_reviews', 'ai_quality_findings', 'ai_quality_fixes'];
const GATE = 'public.can_edit_call_scripts()';

describe('ai quality migration — tables and RLS', () => {
  it.each(TABLES)('%s exists idempotently with RLS enabled', (t) => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
    expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
  });

  it('every policy is tenant-scoped AND permission-gated', () => {
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(7);
    for (const p of policies) {
      expect(p).toContain('public.get_account_owner_id()');
      expect(p).toContain(GATE);
    }
  });

  it('reviews, findings and fixes are read-only for browsers (no write policies)', () => {
    for (const t of ['ai_quality_reviews', 'ai_quality_findings', 'ai_quality_fixes']) {
      const writes = (sql.match(new RegExp(`CREATE POLICY[^;]*ON public\\.${t}\\s+FOR (INSERT|UPDATE|DELETE|ALL)`, 'g')) ?? []).length;
      expect(writes).toBe(0);
    }
  });

  it('re-running the migration is safe: every policy is dropped first, every index guarded', () => {
    const creates = (sql.match(/CREATE POLICY "([^"]+)"/g) ?? []).map((m) => m.replace('CREATE POLICY ', ''));
    for (const name of creates) expect(sql).toContain(`DROP POLICY IF EXISTS ${name}`);
    for (const m of sql.match(/CREATE (UNIQUE )?INDEX [^\n]*/g) ?? []) expect(m).toContain('IF NOT EXISTS');
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });

  it('keeps one open fix per root cause and one finding per call+fingerprint', () => {
    expect(sql).toContain('UNIQUE (call_id, fingerprint)');
    expect(sql).toMatch(/uq_ai_quality_fixes_open_key[\s\S]*WHERE status = 'proposed'/);
  });
});

describe('ai quality migration — functions', () => {
  const defs = sql.match(/CREATE OR REPLACE FUNCTION public\.[\s\S]*?\n\$\$;/g) ?? [];

  it('defines the expected RPCs', () => {
    const names = defs.map((d) => /FUNCTION public\.(\w+)/.exec(d)![1]).sort();
    expect(names).toEqual([
      'ai_quality_account_user_ids', 'apply_ai_quality_fix', 'ensure_ai_quality_default_rules', 'get_ai_quality_feed',
      'get_ai_quality_overview', 'reject_ai_quality_fix', 'set_ai_quality_finding_status',
    ]);
  });

  it('every function is SECURITY DEFINER with a pinned search_path', () => {
    for (const d of defs) {
      expect(d).toContain('SECURITY DEFINER');
      expect(d).toContain('SET search_path = public');
    }
  });

  it('every user-facing RPC checks the gate and is revoked from PUBLIC', () => {
    for (const d of defs) {
      const name = /FUNCTION public\.(\w+)/.exec(d)![1];
      if (name === 'ai_quality_account_user_ids') continue;
      expect(d).toContain('can_edit_call_scripts()');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated`));
    }
  });

  it('never trusts an owner id from the caller', () => {
    expect(sql).not.toMatch(/p_(user|owner)_id\s+uuid\s*[,)]\s*\)?\s*RETURNS (jsonb|void|integer|TABLE)/);
    expect((sql.match(/get_account_owner_id\(\)/g) ?? []).length).toBeGreaterThan(10);
  });

  it('script fixes never silently restart an A/B test and respect the 2500-char cap', () => {
    expect(sql).toContain('challenger_version_id IS NULL');
    expect(sql).toContain('char_length(v_new) > 2500');
  });
});

describe('client and edge function stay in sync with the database', () => {
  it('every RPC the client calls exists in the migration', () => {
    const called = [...client.matchAll(/\.rpc\('(\w+)'/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(5);
    for (const name of new Set(called)) expect(sql).toContain(`FUNCTION public.${name}(`);
  });

  it('every table the client or function touches exists in the migration', () => {
    const used = [...(client + fn).matchAll(/from\(['"](ai_quality_\w+)['"]\)/g)].map((m) => m[1]);
    for (const t of new Set(used)) expect(TABLES).toContain(t);
  });

  it('the client invokes the deployed function name', () => {
    expect(client).toContain("invoke('call-quality-review'");
    expect(fn).toContain('can_edit_call_scripts');
  });

  it('only the Edge Function (service role) writes reviews and findings', () => {
    expect(client).not.toMatch(/from\('ai_quality_(reviews|findings|fixes)'\)\s*\.(insert|update|upsert|delete)/);
    expect(fn).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
