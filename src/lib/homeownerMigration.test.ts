import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20271021000000_vireek_home.sql'), 'utf8');

const RPCS = [
  'homeowner_bootstrap()',
  'homeowner_link_by_portal_token(uuid)',
  'homeowner_set_link_sharing(uuid, boolean, boolean, boolean, boolean, boolean)',
  'homeowner_revoke_link(uuid)',
  'homeowner_update_settings(text, text, boolean)',
  'homeowner_get_overview()',
  'homeowner_get_business(uuid)',
  'homeowner_get_document_path(uuid, uuid)',
  'homeowner_submit_service_request(uuid, text, text, text[])',
  'homeowner_ai_consume()',
  'homeowner_export_my_data()',
  'set_document_homeowner_visible(uuid, boolean)',
];

describe('vireek_home migration', () => {
  it('enables RLS on every homeowner table and grants clients read-only access', () => {
    for (const t of ['homeowner_profiles', 'homeowner_business_links', 'homeowner_consent_events', 'homeowner_ai_usage']) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+authenticated/i);
  });

  it('never grants anything to anon', () => {
    expect(sql).not.toMatch(/TO\s+anon/i);
  });

  it('locks every RPC to authenticated only', () => {
    for (const fn of RPCS) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`);
    }
  });

  it('pins search_path on every SECURITY DEFINER function', () => {
    const definers = (sql.match(/SECURITY DEFINER/g) ?? []).length;
    const pinned = (sql.match(/SET search_path = public/g) ?? []).length;
    expect(definers).toBeGreaterThan(10);
    expect(pinned).toBe(definers);
  });

  it('makes pending/revoked links unable to share data', () => {
    expect(sql).toContain('hbl_no_share_unless_active');
    expect(sql).toMatch(/status = 'active'\s+OR NOT \(share_jobs/);
  });

  it('keeps phone-only sign-ups out of business profiles', () => {
    expect(sql).toMatch(/NEW\.email IS NULL AND NEW\.phone IS NOT NULL/);
  });

  it('uses a private photo bucket scoped to the owner folder', () => {
    expect(sql).toMatch(/'homeowner-uploads', 'homeowner-uploads', false/);
    expect(sql).toContain("(storage.foldername(name))[1] = auth.uid()::text");
  });
});
