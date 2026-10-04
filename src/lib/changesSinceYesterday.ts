/**
 * "What changed since yesterday?" — pure logic (no network, no React).
 *
 * Flow metrics (revenue, jobs, calls, complaints) compare the LAST 24 HOURS with
 * the 24 HOURS BEFORE THAT, so the comparison is fair at any time of day.
 * AR compares the outstanding balance now vs. 24h ago.
 * Open capacity compares today's vs. yesterday's scheduled load (calendar days).
 *
 * A metric whose source failed to load is `null` and is simply not shown —
 * we never display a fake "0 change".
 */

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Tune "meaningful" here — nothing else needs to change. */
export const SIGNIFICANCE = {
  percentMin: 5, // % metrics must move at least this much
  revenueMinBaseCents: 10_000, // below a $100 baseline, % is noise -> show $ instead
  revenueFallbackMinCents: 10_000,
  callsMinBase: 5, // below 5 calls baseline, % is noise -> show count instead
  callsFallbackMinDelta: 3,
  jobsMinDelta: 2,
  complaintsMinDelta: 1, // any complaint movement matters
  arMinCents: 25_000, // AR must move >= $250 ...
  arMinRatio: 0.05, // ... and >= 5% of last-24h balance
  capacityMinPoints: 5,
} as const;

const COMPLAINT_MAX_RATING = 2;

export interface RawInvoice {
  status: string;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  line_items: { quantity: number; unit_price_cents: number }[] | null;
  tax_percent: number | null;
}

/** `null` = that source could not be loaded. */
export interface RawData {
  invoices: RawInvoice[] | null;
  calls: { call_datetime: string; sentiment: string | null }[] | null;
  jobsCreated: { created_at: string }[] | null;
  jobsScheduled: { scheduled_datetime: string | null; job_status: string }[] | null;
  reviews: { rating: number | null; completed_at: string | null }[] | null;
  /** Sum of max_jobs_per_day across active, dispatch-enabled technicians. */
  dailyCapacity: number | null;
}

export interface Pair {
  current: number;
  previous: number;
}

export interface ChangeSnapshot {
  revenueCents: Pair | null;
  jobs: Pair | null;
  calls: Pair | null;
  complaints: Pair | null;
  arCents: Pair | null;
  openCapacityPct: Pair | null;
}

export type ChangeKey = 'revenue' | 'jobs' | 'capacity' | 'ar' | 'calls' | 'complaints';

export interface ChangeRow {
  key: ChangeKey;
  label: string;
  display: string;
  direction: 'up' | 'down';
  tone: 'good' | 'bad' | 'neutral';
}

// ---------- helpers ----------

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : NaN);
const within = (t: number, from: number, to: number) => t >= from && t < to; // NaN -> false

function startOfLocalDay(base: number, offsetDays: number): number {
  const d = new Date(base);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
}

export function invoiceTotalCents(inv: Pick<RawInvoice, 'line_items' | 'tax_percent'>): number {
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  const subtotal = items.reduce((sum, li) => {
    const v = Number(li?.quantity) * Number(li?.unit_price_cents);
    return Number.isFinite(v) ? sum + v : sum;
  }, 0);
  const tax = Number.isFinite(Number(inv.tax_percent)) ? Number(inv.tax_percent) : 0;
  return subtotal + Math.round((subtotal * tax) / 100);
}

/** Outstanding (issued, not yet paid) balance as of time `t`. Draft/void are excluded. */
function arAt(invoices: RawInvoice[], t: number): number {
  let total = 0;
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    if (inv.status === 'paid' && !inv.paid_at) continue; // inconsistent row: don't guess
    const issued = ms(inv.sent_at ?? inv.created_at);
    if (!(issued <= t)) continue;
    const paid = ms(inv.paid_at);
    if (Number.isFinite(paid) && paid <= t) continue;
    total += invoiceTotalCents(inv);
  }
  return total;
}

function openCapacityPct(
  scheduled: NonNullable<RawData['jobsScheduled']>,
  dailyCapacity: number,
  from: number,
  to: number,
): number {
  const load = scheduled.filter(
    (j) =>
      j.job_status !== 'cancelled' &&
      j.job_status !== 'no_show' &&
      within(ms(j.scheduled_datetime), from, to),
  ).length;
  return Math.max(0, Math.round((1 - load / dailyCapacity) * 100));
}

// ---------- snapshot ----------

export function computeSnapshot(raw: RawData, now: number): ChangeSnapshot {
  const t1 = now - DAY_MS;
  const t2 = now - 2 * DAY_MS;
  const count = <T>(rows: T[], at: (r: T) => string | null | undefined, from: number, to: number) =>
    rows.filter((r) => within(ms(at(r)), from, to)).length;
  const pair = (current: number, previous: number): Pair => ({ current, previous });

  const { invoices, calls, jobsCreated, jobsScheduled, reviews, dailyCapacity } = raw;

  const revenueCents = invoices
    ? (() => {
        const paid = (from: number, to: number) =>
          invoices
            .filter((i) => i.status === 'paid' && within(ms(i.paid_at), from, to))
            .reduce((s, i) => s + invoiceTotalCents(i), 0);
        return pair(paid(t1, now + 1), paid(t2, t1));
      })()
    : null;

  const complaints =
    calls && reviews
      ? (() => {
          const n = (from: number, to: number) =>
            count(calls.filter((c) => c.sentiment === 'negative'), (c) => c.call_datetime, from, to) +
            count(
              reviews.filter((r) => r.rating !== null && r.rating <= COMPLAINT_MAX_RATING),
              (r) => r.completed_at,
              from,
              to,
            );
          return pair(n(t1, now + 1), n(t2, t1));
        })()
      : null;

  const capacity =
    jobsScheduled && dailyCapacity && dailyCapacity > 0
      ? pair(
          openCapacityPct(jobsScheduled, dailyCapacity, startOfLocalDay(now, 0), startOfLocalDay(now, 1)),
          openCapacityPct(jobsScheduled, dailyCapacity, startOfLocalDay(now, -1), startOfLocalDay(now, 0)),
        )
      : null;

  return {
    revenueCents,
    jobs: jobsCreated
      ? pair(count(jobsCreated, (j) => j.created_at, t1, now + 1), count(jobsCreated, (j) => j.created_at, t2, t1))
      : null,
    calls: calls
      ? pair(count(calls, (c) => c.call_datetime, t1, now + 1), count(calls, (c) => c.call_datetime, t2, t1))
      : null,
    complaints,
    arCents: invoices ? pair(arAt(invoices, now), arAt(invoices, t1)) : null,
    openCapacityPct: capacity,
  };
}

// ---------- formatting ----------

const sign = (n: number) => (n > 0 ? '+' : '−');
const fmtPct = (p: number) => `${sign(p)}${Math.abs(p)}%`;
const fmtCount = (n: number) => `${sign(n)}${Math.abs(n).toLocaleString('en-US')}`;
const fmtPoints = (n: number) => `${sign(n)}${Math.abs(n)} pts`;
const fmtMoney = (cents: number) =>
  `${sign(cents)}${(Math.abs(cents) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })}`;

// ---------- rows (only meaningful changes) ----------

export function buildChangeRows(s: ChangeSnapshot): ChangeRow[] {
  const T = SIGNIFICANCE;
  const rows: ChangeRow[] = [];
  const push = (key: ChangeKey, label: string, display: string, delta: number, goodWhenUp: boolean | null) =>
    rows.push({
      key,
      label,
      display,
      direction: delta > 0 ? 'up' : 'down',
      tone: goodWhenUp === null ? 'neutral' : delta > 0 === goodWhenUp ? 'good' : 'bad',
    });

  if (s.revenueCents) {
    const { current, previous } = s.revenueCents;
    const d = current - previous;
    if (previous >= T.revenueMinBaseCents) {
      const p = Math.round((d / previous) * 100);
      if (Math.abs(p) >= T.percentMin) push('revenue', 'Revenue', fmtPct(p), d, true);
    } else if (Math.abs(d) >= T.revenueFallbackMinCents) {
      push('revenue', 'Revenue', fmtMoney(d), d, true);
    }
  }

  if (s.jobs) {
    const d = s.jobs.current - s.jobs.previous;
    if (Math.abs(d) >= T.jobsMinDelta) push('jobs', 'Jobs', fmtCount(d), d, true);
  }

  if (s.openCapacityPct) {
    const d = s.openCapacityPct.current - s.openCapacityPct.previous;
    if (Math.abs(d) >= T.capacityMinPoints) push('capacity', 'Capacity', fmtPoints(d), d, null);
  }

  if (s.arCents) {
    const d = s.arCents.current - s.arCents.previous;
    const threshold = Math.max(T.arMinCents, Math.abs(s.arCents.previous) * T.arMinRatio);
    if (Math.abs(d) >= threshold) push('ar', 'AR', fmtMoney(d), d, false);
  }

  if (s.calls) {
    const { current, previous } = s.calls;
    const d = current - previous;
    if (previous >= T.callsMinBase) {
      const p = Math.round((d / previous) * 100);
      if (Math.abs(p) >= T.percentMin) push('calls', 'Calls', fmtPct(p), d, true);
    } else if (Math.abs(d) >= T.callsFallbackMinDelta) {
      push('calls', 'Calls', fmtCount(d), d, true);
    }
  }

  if (s.complaints) {
    const d = s.complaints.current - s.complaints.previous;
    if (Math.abs(d) >= T.complaintsMinDelta) push('complaints', 'Customer complaints', fmtCount(d), d, false);
  }

  return rows;
}
