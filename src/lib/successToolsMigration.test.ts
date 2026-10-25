import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_COPY } from './successTools';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20271110000000_tenant_success_tooling.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('tenant success tooling migration', () => {
  it('is additive: nothing destructive and every new table has RLS', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    for (const t of ['success_feature_catalog', 'nps_responses', 'success_item_state']) {
      expect(code).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
      expect(code).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM authenticated`));
    }
  });

  it('every SECURITY DEFINER function pins search_path', () => {
    const fns = code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(9);
    for (const f of fns) {
      expect(f).toMatch(/SECURITY DEFINER/);
      expect(f).toMatch(/SET search_path = public/);
    }
  });

  it('keeps internal helpers private and client RPCs authenticated-only', () => {
    for (const f of ['_success_is_impersonated(uuid)', '_nps_due(uuid, uuid)', '_success_usage_matrix(uuid)']) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`);
    }
    for (const f of ['nps_should_prompt()', 'submit_nps_response(integer, text, text)', 'set_success_item_state(text, text, integer)', 'clear_success_item_state(text)', 'get_my_success_snapshot()', 'staff_success_overview(integer)']) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated;`);
    }
  });

  it('enforces staff access and audits it', () => {
    const staff = code.slice(code.indexOf('FUNCTION public.staff_success_overview'));
    expect(staff).toMatch(/NOT public\.is_vireek_staff\(auth\.uid\(\)\)/);
    expect(staff).toMatch(/INSERT INTO staff_audit_log/);
  });

  it('scopes tenant reads to the account owner and blocks staff impersonation writes', () => {
    expect(code).toMatch(/v_owner uuid := public\.get_account_owner_id\(\)/);
    expect((code.match(/_success_is_impersonated\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('quotes dynamic identifiers and only reads them from the catalog', () => {
    expect(code).toMatch(/format\('public\.%I', r\.source_table\)/);
    expect(code).toMatch(/FROM public\.%4\$I t/);
    expect(code).toMatch(/EXCEPTION WHEN OTHERS THEN/);
  });

  it('every seeded catalog feature has nudge/playbook copy', () => {
    const keys = [...sql.matchAll(/^\s*\('([a-z_]+)',\s*'[^']+',\s*'(?:core|high_value)'/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const k of keys) expect(FEATURE_COPY[k]).toBeDefined();
  });
});
