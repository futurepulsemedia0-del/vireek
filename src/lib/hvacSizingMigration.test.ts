import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20271215000000_hvac_sizing_matchups.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const CLIENT_FUNCTIONS = [
  'hvac_upsert_matchups(jsonb)',
  'hvac_set_matchup_verified(uuid, boolean)',
  'hvac_set_matchup_active(uuid, boolean)',
  'hvac_delete_matchup(uuid)',
  'get_quote_hvac_sizing(uuid)',
  'save_quote_hvac_sizing(uuid, jsonb, jsonb, jsonb, jsonb, text)',
  'select_quote_hvac_matchup(uuid, uuid)',
  'apply_hvac_matchup_to_quote(uuid, integer)',
];

describe('hvac sizing migration', () => {
  it('is additive: nothing destructive, every table has RLS and no client write grants', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    for (const t of ['hvac_ahri_matchups', 'quote_hvac_sizing']) {
      expect(code).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
      expect(code).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM authenticated, anon`));
      expect(code).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON ${t} FOR (INSERT|UPDATE|DELETE|ALL)`, 'i'));
    }
  });

  it('scopes reads to the account owner AND the billing permission', () => {
    const policies = code.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p).toContain('public.get_account_owner_id()');
      expect(p).toContain('public.quote_workspace_caller_can_view()');
    }
  });

  it('every function is SECURITY DEFINER with a pinned search_path and re-checks auth + permission', () => {
    const bodies = code.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g) ?? [];
    expect(bodies).toHaveLength(CLIENT_FUNCTIONS.length);
    for (const b of bodies) {
      expect(b).toMatch(/SECURITY DEFINER/);
      expect(b).toMatch(/SET search_path = public/);
      expect(b).toMatch(/RAISE EXCEPTION 'not_authenticated'/);
      expect(b).toMatch(/RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'/);
    }
  });

  it('revokes from public/anon and grants authenticated only', () => {
    for (const f of CLIENT_FUNCTIONS) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated;`);
    }
  });

  it('every write is filtered by the caller\'s account', () => {
    for (const stmt of code.match(/\b(UPDATE|DELETE FROM)\s+\w+[^;]*;/g) ?? []) {
      expect(stmt).toMatch(/user_id = v_owner/);
    }
  });

  it('only edits quotes through the draft-only, non-tiered, idempotent apply function', () => {
    const apply = code.slice(code.indexOf('FUNCTION public.apply_hvac_matchup_to_quote'));
    expect(apply).toMatch(/'quote_not_editable'/);
    expect(apply).toMatch(/'quote_is_tiered'/);
    expect(apply).toMatch(/'already_present'/);
    expect(apply).toMatch(/FOR UPDATE/);
    expect((code.match(/UPDATE quotes/g) ?? []).length).toBe(1);
  });

  it('resets verification when a certified spec changes and never trusts the client for ownership', () => {
    expect(code).toMatch(/IS DISTINCT FROM/);
    expect(code).toMatch(/ahri_status = CASE WHEN v_changed THEN 'unverified'/);
    expect(code).not.toMatch(/v_new\.user_id/);
  });
});
