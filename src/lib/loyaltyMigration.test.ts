import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static contract checks for the loyalty SQL: the safety properties the design depends on (server-written
// ledger, manager-gated config, safe definer functions, idempotent DDL) are asserted here so a later edit
// cannot quietly weaken them, and every RPC/table the client calls is proven to exist.

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271210000000_loyalty_program.sql'), 'utf8');
const api = readFileSync(resolve(process.cwd(), 'src/lib/loyaltyApi.ts'), 'utf8');

const TABLES = ['loyalty_settings', 'loyalty_tiers', 'loyalty_earn_rules', 'loyalty_rewards', 'loyalty_accounts', 'loyalty_redemptions', 'loyalty_ledger'];
const SERVER_WRITTEN = ['loyalty_accounts', 'loyalty_redemptions', 'loyalty_ledger'];
const INTERNAL_FUNCTIONS = ['loyalty_lock_account', 'loyalty_apply_entry', 'loyalty_award_job', 'loyalty_reverse_job', 'loyalty_create_redemption'];

describe('loyalty migration — tables and RLS', () => {
  it.each(TABLES)('%s is created idempotently with RLS enabled and no anon access', (t) => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
    expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON [^;]*public\\.${t}\\b[^;]*FROM anon;`));
  });

  it('every policy is tenant-scoped and every write policy is manager-gated', () => {
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(18);
    for (const p of policies) {
      expect(p).toContain('public.get_account_owner_id()');
      if (!/FOR SELECT/.test(p)) expect(p).toContain('public.identity_is_manager()');
    }
  });

  it.each(SERVER_WRITTEN)('%s has no client write policy and client writes are revoked', (t) => {
    const policies = (sql.match(/CREATE POLICY[\s\S]*?;/g) ?? []).filter((p) => p.includes(`ON public.${t} `));
    expect(policies.length).toBe(1);
    expect(policies[0]).toContain('FOR SELECT');
    expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON [^;]*public\\.${t}\\b[^;]*FROM authenticated;`));
  });

  it('the ledger cannot hold a wrong-signed or zero entry and a job earns once', () => {
    expect(sql).toContain('ll_sign_check');
    expect(sql).toContain("entry_type IN ('earn', 'reinstate', 'refund') AND points > 0");
    expect(sql).toContain("entry_type IN ('reversal', 'redeem') AND points < 0");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_ledger_job_earn");
  });
});

describe('loyalty migration — functions', () => {
  it('every SECURITY DEFINER function pins search_path', () => {
    const blocks = sql.split('CREATE OR REPLACE FUNCTION ').slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(15);
    for (const b of blocks) {
      const header = b.slice(0, b.indexOf('$$'));
      if (/SECURITY DEFINER/.test(header)) expect(header).toContain('SET search_path = public');
    }
  });

  it.each(INTERNAL_FUNCTIONS)('%s is internal: revoked from clients and granted to service_role only', (fn) => {
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
    const grant = sql.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO ([^;]+);`));
    expect(grant?.[1]).toBe('service_role');
  });

  it('staff write RPCs are manager-only and not callable by anon', () => {
    for (const fn of ['loyalty_adjust_points', 'loyalty_redeem_for_customer', 'loyalty_set_redemption_status', 'loyalty_backfill_paid_jobs']) {
      const start = sql.indexOf(`FUNCTION public.${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('$$', start) + 2));
      expect(body).toContain('public.identity_is_manager()');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated;`));
    }
  });

  it('portal RPCs are token-based and granted to anon', () => {
    for (const fn of ['get_portal_loyalty', 'portal_redeem_loyalty']) {
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO anon, authenticated;`));
    }
    expect(sql).toContain('x.portal_token = p_portal_token');
  });

  it('the jobs trigger never blocks an invoice write and covers both insert and update', () => {
    const start = sql.indexOf('FUNCTION public.loyalty_on_job_paid()');
    const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('$$', start) + 2));
    expect(body).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(body).toContain('RETURN NEW;');
    expect(sql).toContain('CREATE TRIGGER trg_loyalty_job_paid_ins');
    expect(sql).toContain('CREATE TRIGGER trg_loyalty_job_paid_upd');
  });

  it('redemptions spend points and take the balance check under the account lock', () => {
    const start = sql.indexOf('FUNCTION public.loyalty_create_redemption(');
    const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('$$', start) + 2));
    expect(body.indexOf('loyalty_lock_account')).toBeGreaterThan(-1);
    expect(body.indexOf('loyalty_lock_account')).toBeLessThan(body.indexOf('Not enough points'));
    expect(body).toContain("'redeem', -rw.points_cost");
  });

  it('contains no destructive statements', () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|schema|type|database)\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
  });
});

describe('client/database parity', () => {
  it('every rpc() the client calls is defined in the migration', () => {
    const names = [...api.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const n of new Set(names)) expect(sql).toContain(`FUNCTION public.${n}(`);
  });

  it('every table or view the client reads or writes is defined in the migration', () => {
    const names = [...api.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of new Set(names)) {
      expect(sql).toMatch(new RegExp(`CREATE (TABLE IF NOT EXISTS|OR REPLACE VIEW) public\\.${n}\\b`));
    }
  });
});
