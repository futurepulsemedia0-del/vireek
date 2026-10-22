import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_ATTEMPTS_FOR_UNREACHABLE, URGENT_SCORE } from './recallMatching';

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20271018000000_recall_safety_matching.sql'), 'utf8');

function fn(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end);
}

describe('recall matching migration', () => {
  it('enables RLS on every new table and exposes SELECT only to clients', () => {
    for (const t of ['recall_match_queue', 'recall_campaigns', 'recall_outreach', 'recall_outreach_events']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON public\\.${t} FROM anon, authenticated`));
    }
    expect(sql).toMatch(/GRANT SELECT ON public\.recall_campaigns, public\.recall_outreach, public\.recall_outreach_events TO authenticated/);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO authenticated/);
  });

  it('scopes every client policy to the account owner and the permission helper', () => {
    const policies = sql.match(/CREATE POLICY[^;]*;/g) ?? [];
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).toContain('public.get_account_owner_id()');
      expect(p).toContain('public.can_manage_recalls()');
    }
  });

  it('every SECURITY DEFINER function pins search_path', () => {
    const defs = sql.match(/SECURITY DEFINER\s*\n(?!SET search_path = public)/g);
    expect(defs).toBeNull();
  });

  it('client writers re-check tenant and permission', () => {
    for (const name of ['recall_scan_my_account', 'recall_log_outreach', 'recall_set_campaign_status']) {
      const body = fn(name);
      expect(body).toContain('public.get_account_owner_id()');
      expect(body).toContain('public.can_manage_recalls()');
      expect(body).toMatch(/RECALL_FORBIDDEN/);
    }
    expect(fn('recall_log_outreach')).toMatch(/user_id = v_owner/);
  });

  it('owner-scoped internals are service_role only', () => {
    for (const sig of ['recall_match_candidates(uuid, text, uuid, uuid)', 'recall_sync_for_owner(uuid, text, uuid, uuid, uuid)', 'process_recall_match_queue(integer)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role`);
    }
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(recall_match_candidates|recall_sync_for_owner|process_recall_match_queue)[^;]*TO authenticated/);
  });

  it('reuses the existing matching + serial helpers instead of re-implementing them', () => {
    const body = fn('recall_match_candidates');
    expect(body).toContain('public.oem_match_equipment(');
    expect(body).toContain('public.oem_decode_serial(');
    expect(body).toContain('public.oem_issue_applicability(');
  });

  it('never blocks an import or an equipment save when queueing fails', () => {
    expect(fn('recall_enqueue_source')).toMatch(/EXCEPTION WHEN OTHERS/);
  });

  it('keeps the TypeScript constants in sync with the database rules', () => {
    expect(sql).toContain(`o.priority_score >= ${URGENT_SCORE}`);
    expect(fn('recall_log_outreach')).toContain(`o.attempts < ${MIN_ATTEMPTS_FOR_UNREACHABLE}`);
    expect(sql).toContain("ARRAY['completed', 'declined', 'unreachable', 'not_affected']");
  });
});
