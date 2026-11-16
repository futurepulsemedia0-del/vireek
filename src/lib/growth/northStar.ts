/**
 * North Star metric tree — pure definitions (no I/O).
 *
 * SQL (supabase/migrations/20290305000000_north_star_metric_tree.sql) returns raw weekly COUNTS per call-week.
 * Every ratio, the "enough data?" decision and the tree shape live here, once. Definitions: docs/analytics/north-star.md.
 *
 * North Star: kept appointments from voice calls (jobs linked to a Vireek-handled call that reached 'completed'),
 * attributed to the week of the call. Tree:  kept = calls x booking rate x (kept / booked jobs).
 * A rate with no denominator is `null` (never 0).
 */
import { MIN_SAMPLE, type MetricValue } from '@/lib/growth/growthMetrics';

/** Number of most recent COMPLETE weeks summed for the headline tree. */
export const NORTH_STAR_WINDOW_WEEKS = 4;
const DAY_MS = 86_400_000;

export interface NorthStarWeek {
  /** ISO date (YYYY-MM-DD), Monday, UTC. */
  weekStart: string;
  callsN: number;
  bookedCallsN: number;
  jobsN: number;
  keptN: number;
  resolvedN: number;
  pendingN: number;
  accountsWithCallsN: number;
  activeAccountsN: number;
  paidCents: number;
}

export interface NorthStarDataQuality {
  callsAllSources90d: number;
  callsQualifying90d: number;
  callsWithAnswerMs90d: number;
  jobsLinked90d: number;
  jobsLinkedWithVoiceKey90d: number;
  callsBookedStatusNoJob90d: number;
}

export interface NorthStarRaw {
  generatedAt: Date | null;
  definitionVersion: number;
  resolvedAfterDays: number;
  /** Newest first. */
  weeks: NorthStarWeek[];
  dataQuality: NorthStarDataQuality;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};
const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Defensive parse: schema drift degrades to zero counts / dropped rows, never NaN on screen. */
export function parseNorthStar(v: unknown): NorthStarRaw {
  const r = rec(v);
  const weeks: NorthStarWeek[] = [];
  for (const x of arr(r.weeks)) {
    const w = rec(x);
    const weekStart = isoDay(w.week_start);
    if (!weekStart) continue;
    weeks.push({
      weekStart,
      callsN: count(w.calls_n),
      bookedCallsN: count(w.booked_calls_n),
      jobsN: count(w.jobs_n),
      keptN: count(w.kept_n),
      resolvedN: count(w.resolved_n),
      pendingN: count(w.pending_n),
      accountsWithCallsN: count(w.accounts_with_calls_n),
      activeAccountsN: count(w.active_accounts_n),
      paidCents: count(w.paid_cents),
    });
  }
  weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
  const dq = rec(r.data_quality);
  const gen = typeof r.generated_at === 'string' && !Number.isNaN(Date.parse(r.generated_at)) ? new Date(r.generated_at) : null;
  return {
    generatedAt: gen,
    definitionVersion: count(r.definition_version) || 1,
    resolvedAfterDays: count(r.resolved_after_days) || 7,
    weeks,
    dataQuality: {
      callsAllSources90d: count(dq.calls_all_sources_90d),
      callsQualifying90d: count(dq.calls_qualifying_90d),
      callsWithAnswerMs90d: count(dq.calls_with_answer_ms_90d),
      jobsLinked90d: count(dq.jobs_linked_90d),
      jobsLinkedWithVoiceKey90d: count(dq.jobs_linked_with_voice_key_90d),
      callsBookedStatusNoJob90d: count(dq.calls_booked_status_no_job_90d),
    },
  };
}

/** num/den as a measured MetricValue. `n` is the denominator. Null when there is no denominator. */
export function ratioMetric(num: number, den: number, reason: string): MetricValue {
  if (!(den > 0)) return { value: null, status: 'insufficient', label: 'measured', n: Math.max(0, den || 0), reason };
  const lowSample = den < MIN_SAMPLE;
  return {
    value: Math.min(Math.max(num / den, 0), 1),
    status: lowSample ? 'low_sample' : 'ok',
    label: 'measured',
    n: den,
    reason: lowSample ? 'sample_below_minimum' : null,
  };
}

/** A call-week is partial until its 7 days have fully elapsed (UTC). */
export function isPartialWeek(weekStart: string, now: Date): boolean {
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  return Number.isNaN(start) ? true : start + 7 * DAY_MS > now.getTime();
}

export interface NorthStarTree {
  /** Week starts included in the window (complete weeks only, newest first). */
  windowWeeks: string[];
  /** L0 — the North Star: kept appointments in the window. */
  keptN: number;
  /** Jobs in the window that are not resolved yet (kept can still rise). */
  pendingN: number;
  /** L1 input — handled, non-spam calls. Demand-driven; not a lever Vireek controls directly. */
  callsN: number;
  /** L1 input — calls with at least one linked job / calls. */
  bookingRate: MetricValue;
  /** L1 input — completed / resolved jobs (cancelled and stale-open count against it). */
  keepRate: MetricValue;
  /** Breadth, latest complete week only (accounts cannot be summed across weeks). */
  breadth: { weekStart: string; activeAccountsN: number; accountsWithCallsN: number; reach: MetricValue } | null;
  /** Companion, not an input: payments recorded on kept jobs' non-void invoices. */
  paidCents: number;
}

export function buildNorthStarTree(weeks: NorthStarWeek[], now: Date): NorthStarTree {
  const complete = weeks.filter((w) => !isPartialWeek(w.weekStart, now)).slice(0, NORTH_STAR_WINDOW_WEEKS);
  const sum = (f: (w: NorthStarWeek) => number): number => complete.reduce((a, w) => a + f(w), 0);
  const latest = complete[0] ?? null;
  return {
    windowWeeks: complete.map((w) => w.weekStart),
    keptN: sum((w) => w.keptN),
    pendingN: sum((w) => w.pendingN),
    callsN: sum((w) => w.callsN),
    bookingRate: ratioMetric(sum((w) => w.bookedCallsN), sum((w) => w.callsN), 'no_calls_in_window'),
    keepRate: ratioMetric(sum((w) => w.keptN), sum((w) => w.resolvedN), 'no_resolved_jobs_in_window'),
    breadth: latest
      ? {
          weekStart: latest.weekStart,
          activeAccountsN: latest.activeAccountsN,
          accountsWithCallsN: latest.accountsWithCallsN,
          reach: ratioMetric(latest.activeAccountsN, latest.accountsWithCallsN, 'no_accounts_with_calls'),
        }
      : null,
    paidCents: sum((w) => w.paidCents),
  };
}
