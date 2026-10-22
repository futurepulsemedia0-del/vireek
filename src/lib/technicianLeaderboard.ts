/**
 * Technician leaderboards + spiffs — pure types and helpers (no network, no Supabase).
 *
 * The database (supabase/migrations/20271011000000_technician_leaderboards_spiffs.sql) is
 * AUTHORITATIVE for KPI math, ranking, payout generation and payroll. This module only
 * handles period navigation, formatting, sorting and form validation on the client.
 */

import { dollarsToCents } from '@/lib/commissionEngine';

// ============================================================
// TYPES
// ============================================================

export type LeaderboardPeriod = 'weekly' | 'monthly';
export type RankableKpi = 'first_time_fix_rate' | 'upsell_rate' | 'csat_avg' | 'revenue_cents' | 'jobs_completed';
export type SpiffKpi = RankableKpi | 'overall';
export type SpiffRuleType = 'threshold' | 'rank';
export type PayoutStatus = 'pending' | 'approved' | 'paid' | 'rejected';

export interface PeriodInfo {
  type: LeaderboardPeriod;
  start: string;
  end: string;
  closed: boolean;
  settled: boolean;
}

export interface LeaderboardRow {
  team_member_id: string | null;
  name: string;
  is_me: boolean;
  jobs_completed: number;
  first_time_fix_rate: number | null;
  upsell_rate: number | null;
  upsell_opportunities: number;
  csat_avg: number | null;
  csat_responses: number;
  revenue_cents: number | null;
  overall_score: number | null;
  eligible: boolean;
  ranks: Record<SpiffKpi, number | null>;
}

export interface LeaderboardSettings {
  enabled_kpis: RankableKpi[];
  min_jobs_to_rank: number;
  min_csat_responses: number;
  show_names: boolean;
}

export interface LeaderboardData {
  enabled: boolean;
  period?: PeriodInfo;
  settings?: LeaderboardSettings;
  viewer?: { team_member_id: string | null; is_manager: boolean; opted_out: boolean };
  rows?: LeaderboardRow[];
  opted_out?: { team_member_id: string; name: string }[];
}

export interface LeaderboardSettingsRow {
  user_id: string;
  enabled: boolean;
  enabled_kpis: RankableKpi[];
  kpi_weights: Partial<Record<RankableKpi, number>>;
  min_jobs_to_rank: number;
  min_csat_responses: number;
  payout_delay_days: number;
  auto_approve_payouts: boolean;
  show_names_to_technicians: boolean;
}

export interface SpiffRule {
  id: string;
  name: string;
  kpi: SpiffKpi;
  period: LeaderboardPeriod;
  rule_type: SpiffRuleType;
  threshold: number | null;
  payout_cents: number | null;
  rank_payouts_cents: number[] | null;
  min_jobs: number;
  active: boolean;
  starts_on: string;
  ends_on: string | null;
}

export interface SpiffPayout {
  id: string;
  rule_name: string;
  team_member_id: string;
  technician_name: string;
  period: LeaderboardPeriod;
  period_start: string;
  period_end: string;
  rank: number | null;
  kpi_value: number | null;
  amount_cents: number;
  status: PayoutStatus;
  pay_run_id: string | null;
  has_payroll_profile: boolean;
  review_note: string | null;
  created_at: string;
}

export interface MySpiffs {
  opted_out: boolean;
  payouts: Pick<SpiffPayout, 'id' | 'rule_name' | 'period' | 'period_start' | 'period_end' | 'rank' | 'amount_cents' | 'status'>[];
  rules: Pick<SpiffRule, 'id' | 'name' | 'kpi' | 'period' | 'rule_type' | 'threshold' | 'payout_cents' | 'rank_payouts_cents'>[];
}

// ============================================================
// KPI METADATA
// ============================================================

export const RANKABLE_KPIS: RankableKpi[] = ['first_time_fix_rate', 'upsell_rate', 'csat_avg', 'revenue_cents', 'jobs_completed'];
export const SPIFF_KPIS: SpiffKpi[] = [...RANKABLE_KPIS, 'overall'];

export const KPI_LABEL: Record<SpiffKpi, string> = {
  first_time_fix_rate: 'First-time fix',
  upsell_rate: 'Upsell rate',
  csat_avg: 'Customer rating',
  revenue_cents: 'Revenue',
  jobs_completed: 'Jobs completed',
  overall: 'Overall score',
};

export const MAX_PAYOUT_CENTS = 1_000_000;
export const MAX_RANK_PLACES = 10;

// ============================================================
// FORMATTING
// ============================================================

export function formatUsd(cents: number | null | undefined): string {
  const n = typeof cents === 'number' && Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatKpi(kpi: SpiffKpi, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (kpi) {
    case 'first_time_fix_rate':
    case 'upsell_rate':
      return `${value.toFixed(1)}%`;
    case 'csat_avg':
      return `${value.toFixed(2)} / 5`;
    case 'revenue_cents':
      return formatUsd(value);
    case 'jobs_completed':
      return String(Math.round(value));
    case 'overall':
      return value.toFixed(1);
  }
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// ============================================================
// PERIODS (ISO weeks, Monday start; calendar months; UTC dates — matches the database)
// ============================================================

const DAY_MS = 86_400_000;

export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

export function periodWindow(type: LeaderboardPeriod, anchor: string): { start: string; end: string } {
  const d = parseDateOnly(anchor);
  if (type === 'weekly') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const start = new Date(d.getTime() - dow * DAY_MS);
    return { start: toDateOnly(start), end: toDateOnly(new Date(start.getTime() + 6 * DAY_MS)) };
  }
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: toDateOnly(start), end: toDateOnly(end) };
}

/** Move the anchor one period back (-1) or forward (+1). */
export function shiftAnchor(type: LeaderboardPeriod, anchor: string, delta: -1 | 1): string {
  const { start } = periodWindow(type, anchor);
  const d = parseDateOnly(start);
  if (type === 'weekly') return toDateOnly(new Date(d.getTime() + delta * 7 * DAY_MS));
  return toDateOnly(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)));
}

export function isCurrentPeriod(type: LeaderboardPeriod, anchor: string, today: string): boolean {
  return periodWindow(type, anchor).start === periodWindow(type, today).start;
}

export function periodLabel(type: LeaderboardPeriod, start: string, end: string): string {
  const s = parseDateOnly(start);
  const e = parseDateOnly(end);
  if (type === 'monthly') {
    return s.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const sameMonth = s.getUTCMonth() === e.getUTCMonth();
  const a = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const b = e.toLocaleDateString('en-US', sameMonth ? { day: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${a} – ${b}, ${e.getUTCFullYear()}`;
}

// ============================================================
// SORTING
// ============================================================

/** Sort a board by one KPI (best first). Unranked / null rows always sink; stable by name. */
export function sortBoard(rows: LeaderboardRow[], kpi: SpiffKpi): LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    const ra = a.ranks[kpi];
    const rb = b.ranks[kpi];
    if (ra === null && rb !== null) return 1;
    if (ra !== null && rb === null) return -1;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

export function podium(rows: LeaderboardRow[], kpi: SpiffKpi): LeaderboardRow[] {
  return sortBoard(rows, kpi).filter((r) => r.ranks[kpi] !== null && (r.ranks[kpi] as number) <= 3);
}

// ============================================================
// RULE FORM: validation + description
// ============================================================

export interface RuleDraft {
  name: string;
  kpi: SpiffKpi;
  period: LeaderboardPeriod;
  rule_type: SpiffRuleType;
  /** Threshold in the KPI's natural unit as typed: %, stars, dollars (revenue), or a count. */
  threshold: string;
  /** Flat payout in dollars (threshold rules). */
  payout: string;
  /** Payout per place in dollars, 1st first (rank rules). */
  rankPayouts: string[];
  min_jobs: string;
}

export interface RulePayload {
  name: string;
  kpi: SpiffKpi;
  period: LeaderboardPeriod;
  rule_type: SpiffRuleType;
  threshold: number | null;
  payout_cents: number | null;
  rank_payouts_cents: number[] | null;
  min_jobs: number;
}

export type RuleValidation = { ok: true; payload: RulePayload } | { ok: false; errors: Record<string, string> };

function parseNonNegative(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function emptyRuleDraft(): RuleDraft {
  return { name: '', kpi: 'first_time_fix_rate', period: 'weekly', rule_type: 'threshold', threshold: '', payout: '', rankPayouts: ['', '', ''], min_jobs: '3' };
}

export function validateRuleDraft(d: RuleDraft): RuleValidation {
  const errors: Record<string, string> = {};
  const name = d.name.trim();
  if (name.length < 1 || name.length > 80) errors.name = 'Give the rule a name (up to 80 characters).';

  const minJobs = parseNonNegative(d.min_jobs);
  if (minJobs === null || !Number.isInteger(minJobs) || minJobs > 1000) errors.min_jobs = 'Enter a whole number from 0 to 1000.';

  let threshold: number | null = null;
  let payoutCents: number | null = null;
  let rankPayouts: number[] | null = null;

  if (d.rule_type === 'threshold') {
    const t = parseNonNegative(d.threshold);
    if (t === null) {
      errors.threshold = 'Enter the target to reach.';
    } else if ((d.kpi === 'first_time_fix_rate' || d.kpi === 'upsell_rate') && t > 100) {
      errors.threshold = 'A percentage can’t exceed 100.';
    } else if (d.kpi === 'csat_avg' && (t < 1 || t > 5)) {
      errors.threshold = 'Ratings run from 1 to 5.';
    } else if (d.kpi === 'overall' && t > 100) {
      errors.threshold = 'The overall score runs from 0 to 100.';
    } else if (d.kpi === 'jobs_completed' && !Number.isInteger(t)) {
      errors.threshold = 'Enter a whole number of jobs.';
    } else {
      threshold = d.kpi === 'revenue_cents' ? dollarsToCents(String(t)) : t;
      if (threshold === null) errors.threshold = 'Enter a dollar amount, e.g. 5000 or 5000.50.';
    }
    payoutCents = dollarsToCents(d.payout);
    if (payoutCents === null || payoutCents < 1) errors.payout = 'Enter the bonus amount in dollars.';
    else if (payoutCents > MAX_PAYOUT_CENTS) errors.payout = `A single bonus can’t exceed ${formatUsd(MAX_PAYOUT_CENTS)}.`;
  } else {
    const filled = d.rankPayouts.map((p) => p.trim()).filter((p, i, arr) => p !== '' || arr.slice(i + 1).some((x) => x !== ''));
    const cents = filled.map((p) => (p === '' ? 0 : dollarsToCents(p)));
    if (cents.length === 0 || cents.some((c) => c === null)) {
      errors.rankPayouts = 'Enter a dollar amount for each place (use 0 to skip one).';
    } else if (cents.length > MAX_RANK_PLACES) {
      errors.rankPayouts = `At most ${MAX_RANK_PLACES} places.`;
    } else if ((cents[0] as number) < 1) {
      errors.rankPayouts = 'First place must pay something.';
    } else if (cents.some((c) => (c as number) > MAX_PAYOUT_CENTS)) {
      errors.rankPayouts = `A single bonus can’t exceed ${formatUsd(MAX_PAYOUT_CENTS)}.`;
    } else {
      rankPayouts = cents as number[];
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      name,
      kpi: d.kpi,
      period: d.period,
      rule_type: d.rule_type,
      threshold,
      payout_cents: payoutCents,
      rank_payouts_cents: rankPayouts,
      min_jobs: minJobs as number,
    },
  };
}

export function describeRule(r: Pick<SpiffRule, 'kpi' | 'period' | 'rule_type' | 'threshold' | 'payout_cents' | 'rank_payouts_cents'>): string {
  const per = r.period === 'weekly' ? 'week' : 'month';
  if (r.rule_type === 'threshold') {
    const target = r.kpi === 'revenue_cents' ? formatUsd(r.threshold) : formatKpi(r.kpi, r.threshold).replace(' / 5', '');
    const goal = r.kpi === 'jobs_completed' ? `Complete ${target}+ jobs` : `${KPI_LABEL[r.kpi]} of ${target}${r.kpi === 'csat_avg' ? '+ stars' : '+'}`;
    return `${goal} in a ${per} → ${formatUsd(r.payout_cents)}`;
  }
  const ladder = (r.rank_payouts_cents ?? []).map((c, i) => `${ordinal(i + 1)} ${formatUsd(c)}`).join(' · ');
  return `Top ${KPI_LABEL[r.kpi]} each ${per}: ${ladder}`;
}

/** Display value for a threshold input in the rule form (revenue is stored in cents). */
export function thresholdToInput(kpi: SpiffKpi, threshold: number | null): string {
  if (threshold === null) return '';
  return kpi === 'revenue_cents' ? String(threshold / 100) : String(threshold);
}

// ============================================================
// PAYOUT SUMMARIES
// ============================================================

export interface PayoutTotals {
  pending: number;
  approved: number;
  paid: number;
  rejected: number;
  /** approved but not yet in a pay run */
  awaitingPayroll: number;
  /** approved, unassigned, and the technician has no payroll profile -> can never be paid */
  blocked: number;
}

export function summarizePayouts(payouts: Pick<SpiffPayout, 'status' | 'amount_cents' | 'pay_run_id' | 'has_payroll_profile'>[]): PayoutTotals {
  const t: PayoutTotals = { pending: 0, approved: 0, paid: 0, rejected: 0, awaitingPayroll: 0, blocked: 0 };
  for (const p of payouts) {
    t[p.status] += p.amount_cents;
    if (p.status === 'approved' && !p.pay_run_id) {
      if (p.has_payroll_profile) t.awaitingPayroll += p.amount_cents;
      else t.blocked += p.amount_cents;
    }
  }
  return t;
}

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  pending: 'Needs approval',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

// ============================================================
// SETTINGS FORM
// ============================================================

export const DEFAULT_WEIGHTS: Record<RankableKpi, number> = {
  first_time_fix_rate: 30,
  upsell_rate: 20,
  csat_avg: 30,
  revenue_cents: 20,
  jobs_completed: 0,
};

/** Weights as whole numbers 0–100 for enabled KPIs; returns null when nothing would count. */
export function sanitizeWeights(enabled: RankableKpi[], input: Partial<Record<RankableKpi, number>>): Record<RankableKpi, number> | null {
  const out = { ...DEFAULT_WEIGHTS };
  let sum = 0;
  for (const k of RANKABLE_KPIS) {
    const raw = input[k];
    const w = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0;
    out[k] = w;
    if (enabled.includes(k)) sum += w;
  }
  return sum > 0 ? out : null;
}
