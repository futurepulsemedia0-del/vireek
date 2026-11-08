/**
 * Growth metrics — pure definitions (no I/O). The SQL in
 * supabase/migrations/20281103000000_growth_analytics_core.sql produces raw sums/counts;
 * every ratio, interval and "is there enough data?" decision lives here, once.
 *
 * Rule: a number is either `measured` (computed from recorded data) or `estimated`
 * (needs an assumption). Estimated values are never shown without that label.
 */
import { MIN_CELL_N } from '@/lib/opsExperiments';

export type MetricLabel = 'measured' | 'estimated';
export type DataStatus = 'ok' | 'low_sample' | 'insufficient';

export interface MetricValue {
  value: number | null;
  status: DataStatus;
  label: MetricLabel;
  n: number;
  /** Stable key for i18n: growth.reason.<reason>. Null when status is ok. */
  reason: string | null;
}

export const MIN_SAMPLE = MIN_CELL_N;

const insufficient = (n: number, reason: string, label: MetricLabel = 'measured'): MetricValue => ({
  value: null,
  status: 'insufficient',
  label,
  n,
  reason,
});

/* ---------- MRR bridge & retention ---------- */

export interface BridgeMovement {
  cents: number;
  n: number;
}
export interface BridgeRaw {
  currency: string;
  opening_mrr_cents: number;
  closing_mrr_cents: number;
  movements: Partial<Record<'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation', BridgeMovement>>;
  cohort_n: number;
  cohort_opening_cents: number;
  cohort_closing_cents: number;
  cohort_retained_floor_cents: number;
  cohort_churned_n: number;
}

const mv = (r: BridgeRaw, k: keyof BridgeRaw['movements']): number => r.movements[k]?.cents ?? 0;

/** opening + new + reactivation + expansion - contraction - churn - closing. Must be 0. */
export function bridgeResidualCents(r: BridgeRaw): number {
  return (
    r.opening_mrr_cents + mv(r, 'new') + mv(r, 'reactivation') + mv(r, 'expansion') - mv(r, 'contraction') - mv(r, 'churn') -
    r.closing_mrr_cents
  );
}

function ratio(num: number, den: number, n: number, reason: string, cap?: number): MetricValue {
  if (n === 0 || den <= 0) return insufficient(n, reason);
  const raw = num / den;
  return {
    value: cap === undefined ? raw : Math.min(raw, cap),
    status: n < MIN_SAMPLE ? 'low_sample' : 'ok',
    label: 'measured',
    n,
    reason: n < MIN_SAMPLE ? 'sample_below_minimum' : null,
  };
}

/** NRR = (opening + expansion - contraction - churn) / opening, over the opening cohort only (new MRR excluded). */
export function netRevenueRetention(r: BridgeRaw): MetricValue {
  return ratio(r.cohort_closing_cents, r.cohort_opening_cents, r.cohort_n, 'no_opening_cohort');
}
/** GRR = sum(min(closing, opening)) / opening, capped at 1. */
export function grossRevenueRetention(r: BridgeRaw): MetricValue {
  return ratio(r.cohort_retained_floor_cents, r.cohort_opening_cents, r.cohort_n, 'no_opening_cohort', 1);
}
/** Logo churn = opening paying accounts that reached zero MRR / opening paying accounts. */
export function logoChurn(r: BridgeRaw): MetricValue {
  return ratio(r.cohort_churned_n, r.cohort_n, r.cohort_n, 'no_opening_cohort');
}

/* ---------- Proportions with uncertainty ---------- */

export interface Interval {
  low: number;
  high: number;
}
/** Wilson score interval, z=1.96 (95%). */
export function wilsonInterval(k: number, n: number, z = 1.96): Interval | null {
  if (n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface ProportionResult extends MetricValue {
  k: number;
  interval: Interval | null;
}
function proportion(k: number, n: number, reason: string): ProportionResult {
  if (n === 0) return { ...insufficient(0, reason), k: 0, interval: null };
  return {
    value: k / n,
    status: n < MIN_SAMPLE ? 'low_sample' : 'ok',
    label: 'measured',
    n,
    reason: n < MIN_SAMPLE ? 'sample_below_minimum' : null,
    k,
    interval: wilsonInterval(k, n),
  };
}

/* ---------- Trial conversion ---------- */

export interface TrialRecord {
  trialEnd: Date | null;
  /** First paid (>0) invoice or active-with-MRR timestamp. Null if never converted. */
  convertedAt: Date | null;
  canceledAt?: Date | null;
}
export interface TrialConversionResult {
  matured: ProportionResult;
  inFlight: number;
}
/**
 * Denominator = trials that already converted, plus trials whose end date + `graceDays` has passed (time for the
 * first charge to settle). Trials still running are reported separately — they are NOT "not converted".
 */
export function trialToPaid(trials: TrialRecord[], now: Date, graceDays = 3): TrialConversionResult {
  const graceMs = graceDays * 86_400_000;
  let n = 0;
  let k = 0;
  let inFlight = 0;
  for (const t of trials) {
    if (!t.trialEnd) {
      inFlight++;
      continue;
    }
    const end = t.trialEnd.getTime();
    const converted = t.convertedAt !== null && t.convertedAt.getTime() <= end + graceMs;
    if (converted) {
      n++;
      k++;
    } else if (end + graceMs <= now.getTime()) {
      n++;
    } else {
      inFlight++;
    }
  }
  return { matured: proportion(k, n, 'no_matured_trials'), inFlight };
}

/* ---------- Activation / time-to-first-value ---------- */

export interface ActivationRecord {
  signupAt: Date;
  activatedAt: Date | null;
}
/**
 * Share of signups activated within `days`, counting only signups old enough to have been observed for the full
 * window (right-censored signups are excluded rather than counted as failures).
 */
export function activatedWithin(records: ActivationRecord[], days: number, now: Date): ProportionResult {
  const windowMs = days * 86_400_000;
  let n = 0;
  let k = 0;
  for (const r of records) {
    if (now.getTime() - r.signupAt.getTime() < windowMs) continue;
    n++;
    if (r.activatedAt && r.activatedAt.getTime() - r.signupAt.getTime() <= windowMs) k++;
  }
  return proportion(k, n, 'no_signups_observed_for_window');
}

/** Linear-interpolated percentile of ascending-sorted values (p in 0..1). */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0 || p < 0 || p > 1) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export interface TtfvSummary {
  n: number;
  /** Among ACTIVATED accounts only: biased low because slow/never-activated accounts are absent. Always show with that caveat. */
  medianHoursAmongActivated: number | null;
  p90HoursAmongActivated: number | null;
  status: DataStatus;
}
export function ttfvAmongActivated(records: ActivationRecord[]): TtfvSummary {
  const hours = records
    .filter((r) => r.activatedAt && r.activatedAt.getTime() >= r.signupAt.getTime())
    .map((r) => ((r.activatedAt as Date).getTime() - r.signupAt.getTime()) / 3_600_000)
    .sort((a, b) => a - b);
  const n = hours.length;
  return {
    n,
    medianHoursAmongActivated: percentile(hours, 0.5),
    p90HoursAmongActivated: percentile(hours, 0.9),
    status: n === 0 ? 'insufficient' : n < MIN_SAMPLE ? 'low_sample' : 'ok',
  };
}

/* ---------- Unit economics (ESTIMATED — need assumptions) ---------- */

export interface UnitEconomicsInput {
  arpaCents: number;
  /** 0..1, entered by staff (not measured). */
  grossMargin: number;
  /** Observed monthly logo churn, 0..1. */
  monthlyChurn: number;
  payingCustomers: number;
  monthsOfData: number;
}
export const MIN_MONTHS_FOR_LTV = 6;

/** LTV = ARPA * grossMargin / monthlyChurn. Always labelled estimated. */
export function estimateLtv(i: UnitEconomicsInput): MetricValue {
  if (i.payingCustomers < MIN_SAMPLE) return insufficient(i.payingCustomers, 'sample_below_minimum', 'estimated');
  if (i.monthsOfData < MIN_MONTHS_FOR_LTV) return insufficient(i.payingCustomers, 'history_too_short', 'estimated');
  if (!(i.monthlyChurn > 0)) return insufficient(i.payingCustomers, 'zero_observed_churn', 'estimated');
  if (i.grossMargin <= 0 || i.grossMargin > 1) return insufficient(i.payingCustomers, 'invalid_margin', 'estimated');
  return {
    value: Math.round((i.arpaCents * i.grossMargin) / i.monthlyChurn),
    status: 'ok',
    label: 'estimated',
    n: i.payingCustomers,
    reason: null,
  };
}

/** CAC = recorded spend / new paying customers acquired through the channel in the same period (measured spend input). */
export function cac(spendCents: number, newCustomers: number): MetricValue {
  if (spendCents < 0 || newCustomers <= 0) return insufficient(Math.max(newCustomers, 0), 'no_new_customers');
  return {
    value: Math.round(spendCents / newCustomers),
    status: newCustomers < MIN_SAMPLE ? 'low_sample' : 'ok',
    label: 'measured',
    n: newCustomers,
    reason: newCustomers < MIN_SAMPLE ? 'sample_below_minimum' : null,
  };
}

/** Payback months = CAC / (ARPA * grossMargin). Estimated because margin is an input. */
export function paybackMonths(cacCents: number | null, arpaCents: number, grossMargin: number, n: number): MetricValue {
  if (cacCents === null || arpaCents <= 0 || grossMargin <= 0 || grossMargin > 1) return insufficient(n, 'missing_inputs', 'estimated');
  return {
    value: cacCents / (arpaCents * grossMargin),
    status: n < MIN_SAMPLE ? 'low_sample' : 'ok',
    label: 'estimated',
    n,
    reason: n < MIN_SAMPLE ? 'sample_below_minimum' : null,
  };
}

/** Converts churn observed over `days` into an equivalent monthly rate (30-day month): 1-(1-c)^(30/days). */
export function monthlyChurnFromPeriod(periodChurn: number, days: number): number | null {
  if (!(days > 0) || periodChurn < 0 || periodChurn > 1) return null;
  return 1 - Math.pow(1 - periodChurn, 30 / days);
}

export interface ChannelEconomics {
  cac: MetricValue;
  /** Channel ARPA = new MRR / new customers (measured from first payment, not lifetime). */
  arpaCents: number | null;
  payback: MetricValue;
}
/** Per-channel CAC and payback. Spend is a manual staff input; payback is estimated because margin is an input. */
export function channelEconomics(i: {
  spendCents: number | null;
  newCustomers: number;
  newMrrCents: number;
  grossMargin: number;
}): ChannelEconomics {
  if (i.spendCents === null) {
    return {
      cac: insufficient(i.newCustomers, 'no_spend_recorded'),
      arpaCents: i.newCustomers > 0 ? Math.round(i.newMrrCents / i.newCustomers) : null,
      payback: insufficient(i.newCustomers, 'no_spend_recorded', 'estimated'),
    };
  }
  const c = cac(i.spendCents, i.newCustomers);
  const arpa = i.newCustomers > 0 ? Math.round(i.newMrrCents / i.newCustomers) : null;
  return {
    cac: c,
    arpaCents: arpa,
    payback: paybackMonths(c.value, arpa ?? 0, i.grossMargin, i.newCustomers),
  };
}
