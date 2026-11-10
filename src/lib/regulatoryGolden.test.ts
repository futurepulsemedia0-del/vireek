// Golden cases derived from the text of 40 CFR 84.106 (read 2026-11-08 via the LII mirror of the eCFR; re-verify on ecfr.gov).
// `it.fails` marks a CONFIRMED discrepancy between code and rule text; when fixed it turns red -> switch to `it`.
// Not legal advice. Static SQL/TS checks read source text so they run without a database.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
import { computeLeakRate, LEAK_REPAIR_DEADLINE_DAYS, LEAK_THRESHOLD_PCT, LEAK_RULE_MIN_CHARGE_LBS, RECORD_RETENTION_YEARS } from './refrigerantCompliance';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SQL = read('../../supabase/migrations/20280101000000_refrigerant_leak_repair_loop.sql');
const rule = (key: string) => Number(new RegExp(`'${key}',\\s*(\\d+)`).exec(SQL)?.[1]);
const add = (pounds: number, performed_at: string) => ({ id: performed_at, event_type: 'added' as const, pounds, performed_at, voided_at: null });

describe('84.106 values that MATCH the rule text', () => {
  it('TS: (a) 15 lb; (c)(2) 20/30/10 %; (d) 30 days; (l) 3 years', () => {
    expect(LEAK_RULE_MIN_CHARGE_LBS).toBe(15);
    expect(LEAK_THRESHOLD_PCT).toMatchObject({ commercial_refrigeration: 20, industrial_process: 30, comfort_cooling: 10, other: 10 });
    expect(LEAK_REPAIR_DEADLINE_DAYS).toBe(30);
    expect(RECORD_RETENTION_YEARS).toBe(3);
  });
  it('SQL leak_rules(): 15 lb, GWP>53, 30 d repair, 10 d follow-up, 30 d plan, 1 y completion, 125 % chronic, 3 y retention, 500 lb', () => {
    expect([rule('min_charge_lbs'), rule('gwp_exclusive_min'), rule('repair_days'), rule('followup_test_days'), rule('retrofit_plan_days'),
      rule('retrofit_complete_years'), rule('chronic_pct'), rule('retention_years'), rule('quarterly_min_lbs')])
      .toEqual([15, 53, 30, 10, 30, 1, 125, 3, 500]);
  });
  it('(b)/(l)(2)(viii) rolling % with known full charge', () => {
    const r = computeLeakRate({ entries: [add(12, '2026-06-01')], fullChargeLbs: 100, category: 'commercial_refrigeration', asOf: new Date('2026-07-01T00:00:00Z') });
    expect(r.rollingPct).toBe(12);
    expect(r.covered).toBe(true);
  });
  it('SQL chronic test treats exactly 125 % as chronic (rule: "125 percent or more")', () => {
    expect(SQL).toMatch(/\(v_added \/ v_charge\) \* 100 <= public\.leak_rule_int\('chronic_pct'\) THEN RETURN/);
  });
});

describe('84.106 DISCREPANCIES (confirmed against rule text)', () => {
  it('D1 (j): TS isChronicLeaker uses ">" but the rule says "125 percent or more" (SQL is correct) -> FIX: ">="', () => {
    const src = read('./leakRepair.ts');
    expect(src).toMatch(/pct !== null && pct >= CHRONIC_LEAK_PCT/); // documents current (wrong) state; update when fixed
  });
  it('D2 (g)(1): SQL cadence is charge-only; rule makes quarterly apply ONLY to commercial refrigeration / IPR >= 500 lb', () => {
    expect(SQL).toMatch(/CASE WHEN c\.charge_lbs >= public\.leak_rule_int\('quarterly_min_lbs'\) THEN 'quarterly'/);
  });
  it.fails('D3 (b)(1): first annualizing calc after 2026-01-01 substitutes 365 days since last addition', () => {
    const r = computeLeakRate({ entries: [add(15, '2026-06-01')], fullChargeLbs: 100, category: 'commercial_refrigeration', asOf: new Date('2026-06-02T00:00:00Z') });
    expect(r.annualizedPct).toBe(15);
  });
  it.fails('D4 (b)(2): first rolling-average calc after 2026-01-01 counts only additions since 2026-01-01', () => {
    const r = computeLeakRate({ entries: [add(30, '2025-12-15'), add(5, '2026-02-01')], fullChargeLbs: 100, category: 'commercial_refrigeration', asOf: new Date('2026-03-01T00:00:00Z') });
    expect(r.rollingPct).toBe(5);
  });
  it.fails('D5 (d)/(f): industrial-process-shutdown 120-day window is not modelled', () => {
    const r = (computeLeakRate as unknown as (i: object) => { repairDeadline: string })({ entries: [add(40, '2026-06-01')], fullChargeLbs: 100, category: 'industrial_process', industrialShutdownRequired: true, asOf: new Date('2026-06-02T00:00:00Z') });
    expect(r.repairDeadline.slice(0, 10)).toBe('2026-09-29');
  });
});
