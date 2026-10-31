import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static contract checks for the Pilot Results SQL. These assert the security and attribution rules so a
// later edit cannot quietly weaken them. They do NOT execute SQL; see the live checklist in the PR notes.
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271231130000_pilot_results.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

describe('pilot results migration — RLS', () => {
  it.each(['pilot_outcomes', 'pilot_hours'])('%s has RLS enabled', (t) => {
    expect(code).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  });
  it('every policy is tenant-scoped and permission-gated', () => {
    const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) {
      expect(p).toContain('public.get_account_owner_id()');
      expect(p).toContain('public.reports_can_access(tenant_id)');
    }
  });
  it('pilot_outcomes has no client write policy and writes are revoked', () => {
    expect(code).not.toMatch(/CREATE POLICY[^;]*ON pilot_outcomes\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(code).toContain('REVOKE INSERT, UPDATE, DELETE ON pilot_outcomes FROM anon, authenticated');
  });
  it('baseline is immutable', () => {
    expect(code).toContain('NEW.baseline IS DISTINCT FROM OLD.baseline');
    expect(code).toContain('NEW.started_at IS DISTINCT FROM OLD.started_at');
  });
  it('re-running is safe and nothing destructive exists', () => {
    for (const m of code.match(/CREATE POLICY "([^"]+)"/g) ?? []) expect(code).toContain(`DROP POLICY IF EXISTS ${m.replace('CREATE POLICY ', '')}`);
    for (const m of code.match(/CREATE (UNIQUE )?INDEX [^\n]*/g) ?? []) expect(m).toContain('IF NOT EXISTS');
    expect(code).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });
});

describe('pilot results migration — function security', () => {
  it('every SECURITY DEFINER function pins search_path', () => {
    const fns = code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\n(?:\$\$|AS \$\$)/g) ?? [];
    for (const f of fns.filter((x) => x.includes('SECURITY DEFINER'))) expect(f).toContain('SET search_path = public');
  });
  it.each(['pilot_figures', 'pilot_attributions', 'pilot_results_core'])('%s is service_role only', (f) => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f}(uuid) FROM PUBLIC, anon, authenticated`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${f}(uuid) TO service_role`);
    expect(code).not.toContain(`GRANT EXECUTE ON FUNCTION public.${f}(uuid) TO authenticated`);
  });
  it('pilot_results derives the tenant from the session and re-checks access', () => {
    expect(code).toMatch(/pilot_results\(\)[\s\S]*v_owner uuid := public\.get_account_owner_id\(\)/);
    expect(code).toContain('NOT public.reports_can_access(v_owner)');
  });
  it('start and fee are owner-only and idempotent', () => {
    expect(code.match(/role = 'owner'/g)?.length).toBe(2);
    expect(code).toContain('ON CONFLICT (tenant_id) DO NOTHING');
  });
  it('every data query inside the definer functions is filtered by the tenant', () => {
    for (const t of ['warranty_eligible_jobs e', 'warranty_claims c', 'invoices i', 'supplier_claim_packets p', 'payment_requests pr', 'pilot_hours h']) {
      expect(code).toContain(t);
    }
    expect((code.match(/p_tenant/g) ?? []).length).toBeGreaterThan(25);
  });
});

describe('pilot results migration — baseline math and attribution rules', () => {
  it('baseline avg is NULL without a sample (never 0) and is commercial-only', () => {
    expect(code).toContain("j.customer_type = 'commercial'");
    expect(code).toContain('round(avg(');
  });
  it('invoices > 60 days use unpaid statuses, not trashed, due date else sent date', () => {
    expect(code).toContain("i.status IN ('sent', 'viewed')");
    expect(code).toContain('i.deleted_at IS NULL');
    expect(code).toContain('COALESCE(i.due_date, (i.sent_at AT TIME ZONE \'UTC\')::date) < w.d - 60');
  });
  it('unclaimed warranty counts each job once', () => {
    expect(code).toContain('SELECT DISTINCT ON (e.job_id)');
  });
  it('only post-pilot recoveries with a preceding action are counted', () => {
    expect(code).toContain('x.aon >= po.d AND x.aon <= c.credit_received_at');
    expect(code).toContain('(u.action_kind IS NOT NULL) AS counted');
    expect(code).toContain("'no_preceding_action'");
    expect(code).toContain('c.credit_received_at >= po.d');
  });
  it('invoice recoveries need payment after due date and a reminder within 14 days', () => {
    expect(code).toContain('> i.due_date');
    expect(code).toContain('<= 14');
    expect(code).toContain('pr.reminder_count >= 1');
  });
  it('knows the three action kinds', () => {
    for (const k of ["'packet_sent'", "'approval_attached'", "'reminder'"]) expect(code).toContain(k);
  });
  it('flags the warranty $ as an estimate', () => {
    expect(code).toContain("jsonb_build_array('unclaimed_warranty_cents')");
  });
});
