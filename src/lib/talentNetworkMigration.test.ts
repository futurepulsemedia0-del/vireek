// @vitest-environment node
// Static guarantees for the Talent Network migration (no database needed).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../supabase/migrations/', import.meta.url);
const file = readdirSync(dir).find((f) => /^\d{14}_talent_network\.sql$/.test(f));
const sql = readFileSync(new URL(file ?? 'missing_talent_network.sql', dir), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

describe('talent_network migration', () => {
  const tables = [...code.matchAll(/CREATE TABLE IF NOT EXISTS (talent_\w+)/g)].map((m) => m[1]);

  it('creates the expected tables', () => {
    expect(tables.sort()).toEqual([
      'talent_application_events', 'talent_applications', 'talent_background_checks', 'talent_credential_attestations',
      'talent_credentials', 'talent_engagements', 'talent_postings', 'talent_profiles', 'talent_provider_events',
      'talent_ratings', 'talent_references',
    ]);
  });

  it('enables RLS on every table and revokes anon/authenticated before granting', () => {
    for (const t of tables) expect(code).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    expect(code).toMatch(/REVOKE ALL ON talent_profiles[\s\S]*?FROM anon, authenticated;/);
  });

  it('never grants anything on tables to anon', () => {
    expect(code).not.toMatch(/GRANT[^;]*ON talent_\w+[^;]*TO[^;]*\banon\b/);
  });

  it('pins search_path on every SECURITY DEFINER function', () => {
    const defs = code.split(/CREATE OR REPLACE FUNCTION/).slice(1).filter((b) => /SECURITY DEFINER/.test(b.split(/\$\$/)[0]));
    expect(defs.length).toBeGreaterThan(30);
    for (const d of defs) expect(d.split(/\$\$/)[0]).toMatch(/SET search_path = public/);
  });

  it('keeps verification and token columns away from client grants', () => {
    const insertGrant = code.match(/GRANT INSERT \(profile_id, kind[^)]*\)/)?.[0] ?? '';
    const updateGrant = code.match(/GRANT UPDATE \(kind, name[^)]*\)/)?.[0] ?? '';
    for (const g of [insertGrant, updateGrant]) {
      expect(g).not.toMatch(/verification_|verified_at|expiry_notified_at/);
    }
    const refSelect = code.match(/GRANT SELECT \(id, profile_id, referee_name[^)]*\)/)?.[0] ?? '';
    expect(refSelect).not.toMatch(/request_token|response_/);
  });

  it('allow-lists public RPCs exactly', () => {
    const block = code.match(/v_public text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1] ?? '';
    const names = [...block.matchAll(/'(talent_\w+)'/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([
      'talent_business_days_between', 'talent_business_rating_tags', 'talent_get_open_posting', 'talent_get_reference_request',
      'talent_list_open_postings', 'talent_reference_strengths', 'talent_submit_reference', 'talent_trades', 'talent_worker_rating_tags',
    ]);
  });

  it('keeps service-only functions out of the client allow-lists', () => {
    const service = ['talent_issue_reference_token', 'talent_background_set_provider', 'talent_background_apply_event', 'talent_system_set_credential_verification', 'talent_sweep_credentials'];
    const auth = code.match(/v_authenticated text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1] ?? '';
    const pub = code.match(/v_public text\[\] := ARRAY\[([\s\S]*?)\];/)?.[1] ?? '';
    for (const s of service) {
      expect(auth).not.toContain(`'${s}'`);
      expect(pub).not.toContain(`'${s}'`);
      expect(code).toMatch(new RegExp(`v_service text\\[\\] := ARRAY\\[[\\s\\S]*'${s}'`));
    }
  });

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('makes the background-check gate non-overridable and gates fair-chance timing', () => {
    expect(code).toContain("'background_check' = ANY (v_keys)");
    expect(code).toContain('only start after a conditional offer');
    expect(code).toContain('talent_business_days_between(v_chk.pre_adverse_sent_at::date, current_date) < 5');
  });
});
