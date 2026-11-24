/**
 * Data cooperative — contributor benefit calculation and ledger access.
 *
 * Mirrors the SQL function public.coop_calc_units() (20290312000000_data_cooperative_ledger.sql).
 * The database is the source of truth; this module exists so the UI can PREVIEW a rule and so the
 * formula is unit-tested. Units are abstract credit units, never money. See docs/data/cooperative.md.
 */

import { supabase } from '@/lib/supabase';

export type CoopDomain = 'failure' | 'equipment' | 'pricing' | 'labor' | 'parts' | 'outcomes';

export interface CoopRule {
  domain: CoopDomain;
  active: boolean;
  unit_label: string;
  units_per_1000_records: number | null;
  units_per_cohort: number | null;
  max_units_per_30d: number | null;
}

export interface CoopLedgerEntry {
  id: string;
  domain: CoopDomain | null;
  kind: 'accrual' | 'redemption' | 'adjustment';
  run_date: string | null;
  units: number;
  unit_label: string;
  note: string | null;
  created_at: string;
}

export interface CoopLedger {
  balance: number;
  accrued_30d: number;
  rules: CoopRule[];
  entries: CoopLedgerEntry[];
}

export interface CoopCalcInput {
  records: number;
  cohorts: number;
  unitsPer1000Records: number | null;
  unitsPerCohort: number | null;
  maxUnits30d: number | null;
  trailing30d: number;
}

const finiteOrZero = (n: number | null | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** Same result as SQL coop_calc_units(): clamp to the 30-day cap, never negative, NULL rates earn nothing. */
export function calcCoopUnits(input: CoopCalcInput): number {
  const records = Math.max(finiteOrZero(input.records), 0);
  const cohorts = Math.max(finiteOrZero(input.cohorts), 0);
  const raw = (records / 1000) * finiteOrZero(input.unitsPer1000Records) + cohorts * finiteOrZero(input.unitsPerCohort);
  const headroom =
    input.maxUnits30d === null || input.maxUnits30d === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(input.maxUnits30d - Math.max(finiteOrZero(input.trailing30d), 0), 0);
  return round4(Math.max(Math.min(raw, headroom), 0));
}

/** A rule only earns when it is active AND has at least one rate set (the DB enforces counsel_ref too). */
export function isRuleEarning(rule: Pick<CoopRule, 'active' | 'units_per_1000_records' | 'units_per_cohort'>): boolean {
  return rule.active && (rule.units_per_1000_records !== null || rule.units_per_cohort !== null);
}

/** Balance from entries; used to cross-check the server-provided balance in tests and the UI. */
export function sumLedger(entries: ReadonlyArray<Pick<CoopLedgerEntry, 'units'>>): number {
  return round4(entries.reduce((acc, e) => acc + e.units, 0));
}

export async function fetchCoopLedger(limit = 100): Promise<CoopLedger | null> {
  const { data, error } = await supabase.rpc('coop_get_my_ledger', { p_limit: limit });
  if (error) throw error;
  return (data as CoopLedger | null) ?? null;
}
