import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Static contract checks on the leaderboard/spiff migration. They can't execute SQL, but they pin
 * the invariants that protect payroll money: idempotent generation, closed write paths, a guarded
 * wrapper around create_pay_run, and balanced accounting through bonus_cents.
 */
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271011000000_technician_leaderboards_spiffs.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

describe('leaderboard + spiff migration contract', () => {
  it('enables RLS on every table it creates', () => {
    const tables = [...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(['leaderboard_optouts', 'leaderboard_settings', 'spiff_payouts', 'spiff_rules']);
    for (const t of tables) expect(code).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
  });

  it('gives clients no direct write path to payouts or opt-outs', () => {
    expect(code).not.toMatch(/ON spiff_payouts FOR (ALL|INSERT|UPDATE|DELETE)/);
    expect(code).not.toMatch(/ON leaderboard_optouts FOR (ALL|INSERT|UPDATE|DELETE)/);
  });

  it('makes payout generation idempotent per rule, technician and period', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_spiff_payout_once ON spiff_payouts\(rule_id, team_member_id, period_start\)/);
    expect(code).toMatch(/ON CONFLICT \(rule_id, team_member_id, period_start\) DO NOTHING/);
  });

  it('declares every SECURITY DEFINER function with a pinned search_path', () => {
    const defs = code.split(/CREATE OR REPLACE FUNCTION/).slice(1).filter((d) => /SECURITY DEFINER/.test(d.split(/\$\$/)[0]));
    expect(defs.length).toBeGreaterThan(8);
    for (const d of defs) expect(d.split(/\$\$/)[0]).toMatch(/SET search_path = public/);
  });

  it('keeps internal helpers away from clients', () => {
    for (const fn of ['_lb_period', '_lb_option_total', '_lb_pick', '_lb_board', '_spiff_generate_period', '_spiff_generate_settled', '_spiff_attach_to_pay_run', '_create_pay_run_base']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    }
  });

  it('gates every manager RPC on can_manage_commissions()', () => {
    for (const fn of ['generate_spiff_payouts', 'review_spiff_payout', 'get_spiff_payouts']) {
      const body = code.split(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`))[1]?.split(/\$\$;/)[0] ?? '';
      expect(body).toMatch(/can_manage_commissions\(\)/);
    }
  });

  it('wraps the live create_pay_run once, instead of redefining it', () => {
    expect(code).toMatch(/to_regprocedure\('public\._create_pay_run_base\(date,date,date\)'\) IS NULL/);
    expect(code).toMatch(/RENAME TO _create_pay_run_base/);
    const wrapper = code.split('CREATE OR REPLACE FUNCTION public.create_pay_run(')[1]?.split(/\$\$;/)[0] ?? '';
    expect(wrapper).toMatch(/_spiff_generate_settled/);
    expect(wrapper.indexOf('_create_pay_run_base(')).toBeGreaterThan(wrapper.indexOf('_spiff_generate_settled'));
    expect(wrapper.indexOf('_spiff_attach_to_pay_run')).toBeGreaterThan(wrapper.indexOf('_create_pay_run_base('));
    expect(sql).toMatch(/lint:allow-destructive/);
  });

  it('adds spiffs to bonus_cents and keeps gross, tax and net totals consistent', () => {
    const attach = code.split('CREATE OR REPLACE FUNCTION public._spiff_attach_to_pay_run(')[1]?.split(/\$\$;/)[0] ?? '';
    expect(attach).toMatch(/bonus_cents = bonus_cents \+ rec\.total/);
    expect(attach).toMatch(/net_pay_cents = net_pay_cents \+ rec\.total - v_tax/);
    expect(attach).toMatch(/total_gross_cents = total_gross_cents \+ v_gross_add/);
    expect(attach).toMatch(/total_tax_cents = total_tax_cents \+ v_tax_add/);
    expect(attach).toMatch(/total_net_cents = total_net_cents \+ v_net_add/);
    expect(attach).toMatch(/sp\.status = 'approved' AND sp\.pay_run_item_id IS NULL/);
  });

  it('releases spiffs when a pay run is voided and marks them paid with the pay run', () => {
    expect(code).toMatch(/AFTER UPDATE OF status ON pay_runs/);
    expect(code).toMatch(/SET pay_run_item_id = NULL, status = 'approved', paid_at = NULL/);
    expect(code).toMatch(/AFTER UPDATE OF paid_at ON pay_run_items/);
  });

  it('only pays settled periods and never to opted-out technicians', () => {
    expect(code).toMatch(/current_date - coalesce\(s\.payout_delay_days, 7\)/);
    expect(code).toMatch(/WHERE NOT b\.opted_out AND b\.jobs_completed >= v_min_jobs/);
  });

  it('does not touch the ledger directly (bonus_cents already posts as wages)', () => {
    expect(code).not.toMatch(/post_journal_entry/);
  });
});
