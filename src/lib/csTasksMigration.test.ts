import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20290304000000_staff_cs_tasks.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('staff cs tasks migration', () => {
  it('is additive: nothing destructive outside the commented rollback', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it('is idempotent', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.staff_cs_tasks/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_cs_tasks_active/);
    expect(code).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect((code.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length).toBe((code.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length);
  });

  it('seeds the flag OFF', () => {
    expect(code).toMatch(/VALUES \('cs_auto_tasks'[\s\S]*?false, 0, 'ops', 'low'\)/);
  });

  it('locks the table: RLS on, no policies, no client privileges', () => {
    expect(code).toMatch(/ALTER TABLE public\.staff_cs_tasks ENABLE ROW LEVEL SECURITY/);
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).toMatch(/REVOKE ALL ON public\.staff_cs_tasks FROM PUBLIC, anon, authenticated/);
    expect(code).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|ALL)[^;]*ON (TABLE )?public\.staff_cs_tasks/i);
  });

  it('allows only one active task per account and playbook', () => {
    expect(code).toMatch(/\(account_id, playbook\) WHERE status IN \('open', 'in_progress'\)/);
  });

  it('every SECURITY DEFINER function pins search_path and checks staff + flag', () => {
    const fns = code.match(/CREATE OR REPLACE FUNCTION public\.staff_[\s\S]*?\n\$\$;/g) ?? [];
    expect(fns.length).toBe(3);
    for (const f of fns) {
      expect(f).toMatch(/SECURITY DEFINER/);
      expect(f).toMatch(/SET search_path = public/);
      expect(f).toMatch(/NOT public\.is_vireek_staff\(auth\.uid\(\)\)/);
      expect(f).toMatch(/f\.key = 'cs_auto_tasks'/);
      expect(f).toMatch(/'flag_off'/);
    }
  });

  it('keeps the helper private and the RPCs authenticated-only', () => {
    expect(code).toContain('REVOKE ALL ON FUNCTION public._cs_add_business_days(integer) FROM PUBLIC, anon, authenticated;');
    for (const f of ['staff_sync_cs_tasks(jsonb)', 'staff_list_cs_tasks()', 'staff_update_cs_task(uuid, text, boolean)']) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated;`);
    }
  });

  it('only writes audit actions the staff_audit_log CHECK allows', () => {
    const actions = [...code.matchAll(/INSERT INTO public\.staff_audit_log[\s\S]*?VALUES \([^,]+,[^,]+,\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBe(2);
    for (const a of actions) expect(['explorer_list', 'account_view', 'impersonation_start', 'impersonation_end', 'impersonation_denied']).toContain(a);
  });

  it('bounds input: batch size, validated levels, owner-only accounts, closed tasks immutable', () => {
    expect(code).toMatch(/jsonb_array_length\(p_candidates\) > 200/);
    expect(code).toMatch(/v_level NOT IN \('high', 'medium'\)/);
    expect(code).toMatch(/p\.role = 'owner'/);
    expect(code).toMatch(/t\.status IN \('open', 'in_progress'\)\s+RETURNING/);
  });
});
