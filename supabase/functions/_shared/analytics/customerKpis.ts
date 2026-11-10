// supabase/functions/_shared/analytics/customerKpis.ts
//
// PART A - CUSTOMER-FACING GOVERNED METRICS. Pure and deterministic (no I/O, no Deno/DOM APIs).
// Imported by the `analytics-query` / `analytics-run` edge functions and the dashboard, and locked
// by customerKpis.test.ts. Every definition is mirrored in docs/ANALYTICS_METRICS.md and a test
// fails if a metric is missing from that file.
//
// INPUT: additive daily rollup rows (table analytics_daily_rollups), one per (day, technician).
// Because every column is additive, a ratio is ALWAYS sum(numerator) / sum(denominator) over the
// SAME rows - never an average of daily ratios. "No data" is null, never a fake 0.
// Money = integer USD cents. Rates = integer basis points (10000 = 100%).
//
// DEFINITIONS (v1)
//   first_time_fix_rate  10000 - bp(jobsReworked, jobsCompleted). jobsReworked = completed jobs that
//                        were LATER reworked (some job has rework_of_job_id = this job). Identical to the
//                        technician-leaderboard definition so the two screens can never disagree.
//                        Recent days can still change when a rework is created (see refresh window).
//   callback_rate        bp(reworkJobs, jobsCompleted). reworkJobs = completed jobs with is_rework = true,
//                        attributed to their own completion day.
//   revenue_per_technician
//                        revenue of completed billed jobs that HAVE a technician / distinct technicians with
//                        >= 1 completed job in the range. Unassigned jobs are excluded from both sides.
//   job_profitability    bp(costedRevenue - cost, costedRevenue) over completed billed jobs that have >= 1
//                        job_cost_entries row. Jobs with no cost entries are left OUT (cost unknown, not zero).
//                        Same rule as gross_margin in data-platform/metrics.ts.
//   utilization          bp(scheduledMinutes, capacityMinutes). scheduledMinutes = duration_minutes of
//                        completed jobs with a technician. capacityMinutes = for each technician, the number
//                        of days in range falling on one of their working_days x hoursPerDay x 60.
//                        NOT capped at 100%: >100% means over-scheduled and should be visible.
//                        ASSUMPTION: Vireek stores working DAYS but not hours, so hoursPerDay is a setting
//                        (default 8).
//   quote_conversion     bp(quotesAccepted, quotesSent), attributed to the quote SENT day. Recent days are
//                        immature (customers have not answered yet). Quotes have no technician, so with a
//                        team filter this metric is null.
//   ar_aging             open invoices (status sent|viewed) with balance = invoice_total - payments > 0,
//                        bucketed by days past due_date as of a given day: current (not due / no due date),
//                        1-30, 31-60, 61-90, 90+. Snapshot, not a range metric.

export type MetricId =
  | "first_time_fix_rate" | "callback_rate" | "revenue_per_technician" | "job_profitability"
  | "utilization" | "quote_conversion" | "ar_aging";

export interface CustomerMetricDef {
  id: MetricId;
  label: string;
  unit: "percent" | "currency" | "buckets";
  better: "up" | "down" | "none";
  version: number;
  definition: string;
}

export const CUSTOMER_METRICS: Record<MetricId, CustomerMetricDef> = {
  first_time_fix_rate: { id: "first_time_fix_rate", label: "First-time-fix rate", unit: "percent", better: "up", version: 1, definition: "100% minus the share of completed jobs that were later reworked." },
  callback_rate: { id: "callback_rate", label: "Callback rate", unit: "percent", better: "down", version: 1, definition: "Share of completed jobs that are rework / callback visits." },
  revenue_per_technician: { id: "revenue_per_technician", label: "Revenue per technician", unit: "currency", better: "up", version: 1, definition: "Revenue of completed billed jobs with a technician divided by technicians who completed at least one job." },
  job_profitability: { id: "job_profitability", label: "Job profitability", unit: "percent", better: "up", version: 1, definition: "(Revenue - recorded cost) / revenue, for completed billed jobs that have cost entries." },
  utilization: { id: "utilization", label: "Utilization", unit: "percent", better: "up", version: 1, definition: "Scheduled minutes of completed jobs divided by technician capacity (working days x hours per day)." },
  quote_conversion: { id: "quote_conversion", label: "Quote conversion", unit: "percent", better: "up", version: 1, definition: "Accepted quotes divided by quotes sent, attributed to the day sent." },
  ar_aging: { id: "ar_aging", label: "AR aging", unit: "buckets", better: "none", version: 1, definition: "Open invoice balances grouped by days past due." },
};

export interface RollupRow {
  day: string; // YYYY-MM-DD (UTC)
  technicianId: string | null;
  jobsCompleted: number;
  jobsReworked: number;
  reworkJobs: number;
  billedJobs: number;
  revenueCents: number;
  costedJobs: number;
  costedRevenueCents: number;
  costCents: number;
  scheduledMinutes: number;
  quotesSent: number;
  quotesAccepted: number;
}

export interface TechCapacity { technicianId: string; workingDays: number[] } // 0 = Sunday .. 6 = Saturday

export interface KpiOptions {
  fromDay: string; // inclusive
  toDay: string; // inclusive
  teamIds?: readonly string[] | null; // technician filter; null/undefined = whole account
  hoursPerDay?: number; // default 8
}

export interface KpiValues {
  jobsCompleted: number;
  revenueCents: number;
  firstTimeFixRateBp: number | null;
  callbackRateBp: number | null;
  activeTechnicians: number;
  revenuePerTechnicianCents: number | null;
  grossProfitCents: number | null;
  jobProfitabilityBp: number | null;
  scheduledMinutes: number;
  capacityMinutes: number;
  utilizationBp: number | null;
  quotesSent: number;
  quotesAccepted: number;
  quoteConversionBp: number | null;
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function bp(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a * 10000) / b);
}

function dayMs(d: string): number {
  if (!DAY_RE.test(d)) throw new Error(`Invalid day: ${d}`);
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`Invalid day: ${d}`);
  return t;
}

/** Number of days in [from, to] (inclusive) per weekday index 0..6. */
export function weekdayCounts(fromDay: string, toDay: string): number[] {
  const a = dayMs(fromDay);
  const b = dayMs(toDay);
  if (b < a) throw new Error("Range end is before start.");
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (let t = a; t <= b; t += DAY_MS) out[new Date(t).getUTCDay()]++;
  return out;
}

export function capacityMinutes(techs: readonly TechCapacity[], fromDay: string, toDay: string, hoursPerDay: number): number {
  if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0 || hoursPerDay > 24) throw new Error("hoursPerDay must be in (0, 24].");
  const counts = weekdayCounts(fromDay, toDay);
  let days = 0;
  for (const t of techs) for (const wd of new Set(t.workingDays)) if (wd >= 0 && wd <= 6) days += counts[wd];
  return Math.round(days * hoursPerDay * 60);
}

const nz = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function computeCustomerKpis(rows: readonly RollupRow[], techs: readonly TechCapacity[], o: KpiOptions): KpiValues {
  const from = dayMs(o.fromDay);
  const to = dayMs(o.toDay);
  if (to < from) throw new Error("Range end is before start.");
  const team = o.teamIds && o.teamIds.length > 0 ? new Set(o.teamIds) : null;
  const hours = o.hoursPerDay ?? 8;

  let jobs = 0, reworked = 0, reworkJobs = 0, rev = 0, techRev = 0, costedRev = 0, cost = 0, costedJobs = 0;
  let minutes = 0, qSent = 0, qAcc = 0;
  const activeTechs = new Set<string>();

  for (const r of rows) {
    const t = dayMs(r.day);
    if (t < from || t > to) continue;
    if (team && (r.technicianId === null || !team.has(r.technicianId))) continue;
    jobs += nz(r.jobsCompleted);
    reworked += nz(r.jobsReworked);
    reworkJobs += nz(r.reworkJobs);
    rev += nz(r.revenueCents);
    costedRev += nz(r.costedRevenueCents);
    cost += nz(r.costCents);
    costedJobs += nz(r.costedJobs);
    qSent += nz(r.quotesSent);
    qAcc += nz(r.quotesAccepted);
    if (r.technicianId !== null) {
      techRev += nz(r.revenueCents);
      minutes += nz(r.scheduledMinutes);
      if (nz(r.jobsCompleted) > 0) activeTechs.add(r.technicianId);
    }
  }

  const capTechs = team ? techs.filter((t) => team.has(t.technicianId)) : techs;
  const cap = capacityMinutes(capTechs, o.fromDay, o.toDay, hours);
  const fixBp = bp(reworked, jobs);

  return {
    jobsCompleted: jobs,
    revenueCents: rev,
    firstTimeFixRateBp: fixBp === null ? null : 10000 - fixBp,
    callbackRateBp: bp(reworkJobs, jobs),
    activeTechnicians: activeTechs.size,
    revenuePerTechnicianCents: activeTechs.size > 0 ? Math.round(techRev / activeTechs.size) : null,
    grossProfitCents: costedJobs > 0 ? costedRev - cost : null,
    jobProfitabilityBp: costedJobs > 0 && costedRev > 0 ? Math.round(((costedRev - cost) * 10000) / costedRev) : null,
    scheduledMinutes: minutes,
    capacityMinutes: cap,
    utilizationBp: bp(minutes, cap),
    quotesSent: team ? 0 : qSent,
    quotesAccepted: team ? 0 : qAcc,
    quoteConversionBp: team ? null : bp(qAcc, qSent),
  };
}

// ------------------------------------------------------------------ trend buckets

export type Granularity = "day" | "week" | "month";

/** Start day (YYYY-MM-DD) of the bucket containing `day`. Weeks start on Monday (UTC). */
export function bucketStart(day: string, g: Granularity): string {
  const t = dayMs(day);
  if (g === "day") return day;
  if (g === "month") return `${day.slice(0, 7)}-01`;
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - dow * DAY_MS).toISOString().slice(0, 10);
}

function bucketEnd(start: string, g: Granularity): string {
  const t = dayMs(start);
  if (g === "day") return start;
  if (g === "week") return new Date(t + 6 * DAY_MS).toISOString().slice(0, 10);
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export interface SeriesPoint { start: string; end: string; values: KpiValues }

/** One KPI snapshot per bucket, each clipped to [fromDay, toDay]; capacity is recomputed per bucket. */
export function computeKpiSeries(rows: readonly RollupRow[], techs: readonly TechCapacity[], o: KpiOptions, g: Granularity): SeriesPoint[] {
  const from = dayMs(o.fromDay);
  const to = dayMs(o.toDay);
  if (to < from) throw new Error("Range end is before start.");
  const out: SeriesPoint[] = [];
  let cur = bucketStart(o.fromDay, g);
  while (dayMs(cur) <= to) {
    const end = bucketEnd(cur, g);
    const s = dayMs(cur) < from ? o.fromDay : cur;
    const e = dayMs(end) > to ? o.toDay : end;
    out.push({ start: s, end: e, values: computeCustomerKpis(rows, techs, { ...o, fromDay: s, toDay: e }) });
    cur = new Date(dayMs(end) + DAY_MS).toISOString().slice(0, 10);
  }
  return out;
}

// ------------------------------------------------------------------ AR aging

export type ArBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
export const AR_BUCKETS: readonly ArBucket[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];

export interface ArRow { dueDate: string | null; balanceCents: number }
export interface ArAging {
  asOfDay: string;
  buckets: Record<ArBucket, { count: number; cents: number }>;
  totalCents: number;
  overdueCents: number;
  overdueShareBp: number | null;
}

export function bucketForDaysPastDue(days: number): ArBucket {
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function computeArAging(rows: readonly ArRow[], asOfDay: string): ArAging {
  const asOf = dayMs(asOfDay);
  const buckets = Object.fromEntries(AR_BUCKETS.map((b) => [b, { count: 0, cents: 0 }])) as ArAging["buckets"];
  let total = 0;
  let overdue = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.balanceCents) || r.balanceCents <= 0) continue;
    const days = r.dueDate && DAY_RE.test(r.dueDate) ? Math.floor((asOf - dayMs(r.dueDate)) / DAY_MS) : 0;
    const b = bucketForDaysPastDue(days);
    buckets[b].count++;
    buckets[b].cents += r.balanceCents;
    total += r.balanceCents;
    if (b !== "current") overdue += r.balanceCents;
  }
  return { asOfDay, buckets, totalCents: total, overdueCents: overdue, overdueShareBp: bp(overdue, total) };
}

// ------------------------------------------------------------------ anomaly detection

export interface AnomalyConfig {
  /** Completed history buckets needed before alerting. */
  minHistory: number;
  /** Minimum sample size (e.g. jobs) in the current bucket. */
  minVolume: number;
  zWarning: number;
  zCritical: number;
  /** Minimum absolute change vs. the mean (bp for percent metrics, cents for money). */
  minAbsChange: number;
}

export const DEFAULT_ANOMALY: AnomalyConfig = { minHistory: 4, minVolume: 10, zWarning: 3, zCritical: 4, minAbsChange: 500 };

export interface Anomaly {
  metric: MetricId;
  value: number;
  baselineMean: number;
  z: number | null;
  direction: "up" | "down";
  bad: boolean;
  severity: "warning" | "critical";
}

export function detectAnomaly(
  metric: MetricId, history: readonly (number | null)[], current: number | null, currentVolume: number, cfg: AnomalyConfig = DEFAULT_ANOMALY,
): Anomaly | null {
  if (current === null || !Number.isFinite(current) || currentVolume < cfg.minVolume) return null;
  const h = history.filter((x): x is number => x !== null && Number.isFinite(x));
  if (h.length < cfg.minHistory) return null;
  const mean = h.reduce((s, x) => s + x, 0) / h.length;
  const sd = Math.sqrt(h.reduce((s, x) => s + (x - mean) ** 2, 0) / (h.length - 1));
  const delta = current - mean;
  if (Math.abs(delta) < cfg.minAbsChange) return null;
  const z = sd > 0 ? delta / sd : null;
  if (z !== null && Math.abs(z) < cfg.zWarning) return null;
  const better = CUSTOMER_METRICS[metric].better;
  const direction = delta > 0 ? "up" : "down";
  return {
    metric, value: current, baselineMean: Math.round(mean), z: z === null ? null : Math.round(z * 100) / 100, direction,
    bad: better !== "none" && (better === "up" ? delta < 0 : delta > 0),
    severity: z === null || Math.abs(z) >= cfg.zCritical ? "critical" : "warning",
  };
}

// ------------------------------------------------------------------ CSV export

/** RFC 4180 quoting plus spreadsheet formula-injection protection for string cells. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

const pct = (b: number | null) => (b === null ? "" : (b / 100).toFixed(2));
const usd = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

/** Series -> CSV. Percent columns are in %, money in dollars; headers carry the metric version. */
export function seriesToCsv(series: readonly SeriesPoint[]): string {
  const v = CUSTOMER_METRICS;
  return toCsv(
    ["period_start", "period_end", "jobs_completed", "revenue_usd",
      `first_time_fix_rate_pct_v${v.first_time_fix_rate.version}`, `callback_rate_pct_v${v.callback_rate.version}`,
      `revenue_per_technician_usd_v${v.revenue_per_technician.version}`, `job_profitability_pct_v${v.job_profitability.version}`,
      `utilization_pct_v${v.utilization.version}`, `quote_conversion_pct_v${v.quote_conversion.version}`],
    series.map((p) => [p.start, p.end, p.values.jobsCompleted, usd(p.values.revenueCents), pct(p.values.firstTimeFixRateBp),
      pct(p.values.callbackRateBp), usd(p.values.revenuePerTechnicianCents), pct(p.values.jobProfitabilityBp),
      pct(p.values.utilizationBp), pct(p.values.quoteConversionBp)]),
  );
}

// ------------------------------------------------------------------ PII-free analytics events

type PropRule = "enum" | "int" | "bool" | "slug";
interface EventSpec { props: Record<string, { rule: PropRule; values?: readonly string[] }> }

/** Allowlist. Anything not listed is dropped. No free text, ids of people, emails, phones or names. */
export const ANALYTICS_EVENTS: Record<string, EventSpec> = {
  dashboard_viewed: { props: { range_days: { rule: "int" }, team_filtered: { rule: "bool" } } },
  metric_drilldown: { props: { metric: { rule: "enum", values: Object.keys(CUSTOMER_METRICS) } } },
  csv_exported: { props: { granularity: { rule: "enum", values: ["day", "week", "month"] }, range_days: { rule: "int" } } },
  digest_toggled: { props: { enabled: { rule: "bool" }, cadence: { rule: "enum", values: ["weekly", "monthly"] } } },
  anomaly_alert_opened: { props: { metric: { rule: "enum", values: Object.keys(CUSTOMER_METRICS) }, severity: { rule: "enum", values: ["warning", "critical"] } } },
};

const PII_LIKE = /@|\b\d{7,}\b|https?:\/\//i;

export function sanitizeAnalyticsEvent(name: unknown, props: unknown): { name: string; props: Record<string, string | number | boolean> } | null {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(ANALYTICS_EVENTS, name)) return null;
  const spec = ANALYTICS_EVENTS[name];
  const src = props && typeof props === "object" ? (props as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, rule] of Object.entries(spec.props)) {
    const v = src[k];
    if (v === undefined) continue;
    if (rule.rule === "bool" && typeof v === "boolean") out[k] = v;
    else if (rule.rule === "int" && typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3650) out[k] = v;
    else if (rule.rule === "enum" && typeof v === "string" && rule.values?.includes(v)) out[k] = v;
    else if (rule.rule === "slug" && typeof v === "string" && /^[a-z0-9_.:-]{1,64}$/.test(v) && !PII_LIKE.test(v)) out[k] = v;
  }
  return { name, props: out };
}
