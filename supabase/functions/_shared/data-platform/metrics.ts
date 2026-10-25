// supabase/functions/_shared/data-platform/metrics.ts
//
// THE SEMANTIC METRICS LAYER. Revenue, close rate, gross margin, response time (and the
// metrics around them) are defined here exactly once. Everything that shows or exports a
// number calls this file:
//
//   dashboards          -> metrics-query edge function / Metrics tab
//   scheduled reports   -> same function, same numbers
//   finance copilot     -> official_metrics fact pack (Ask Vireek)
//   warehouse + BI      -> metrics_daily snapshots (computed here, synced to BigQuery / Snowflake / Postgres)
//   partner embeds      -> analytics-embed edge function
//
// Pure and deterministic: no network, no database, no Deno/DOM APIs. Imported by the edge
// functions AND the React app. A unit test locks these definitions to the Executive Monthly
// Report's KPI math so the two can never drift apart (metrics.test.ts).
//
// Rules that make the numbers trustworthy:
//   - Ratios are computed from numerator / denominator of the SAME rows, never by averaging
//     ratios of sub-periods, so a weekly close rate is not the mean of daily close rates.
//   - "No data" is null, never a fake 0.
//   - A metric is always attributed to the time of the EVENT it measures (completion for revenue,
//     send time for quotes, call time for calls, job creation for response time).

export type MetricId =
  | "revenue"
  | "collected_revenue"
  | "collection_rate"
  | "jobs_completed"
  | "avg_ticket"
  | "gross_profit"
  | "gross_margin"
  | "quotes_sent"
  | "close_rate"
  | "response_time"
  | "missed_calls"
  | "recovery_rate"
  | "recovered_revenue";

export type MetricUnit = "currency" | "count" | "percent" | "minutes";
export type Dimension = "service_type" | "technician" | "customer_type";
export type Granularity = "none" | "day" | "week" | "month";

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  /** Which direction is good news. */
  better: "up" | "down";
  /** Business-friendly one-liner. */
  description: string;
  /** Exact rule, shown in the data dictionary and given to the finance copilot. */
  definition: string;
  /** Bump when the rule changes so history can be explained. */
  version: number;
  /** Dimensions this metric can be broken down by. */
  dimensions: readonly Dimension[];
}

const JOB_DIMS: readonly Dimension[] = ["service_type", "technician", "customer_type"];

export const METRICS: Record<MetricId, MetricDef> = {
  revenue: {
    id: "revenue",
    label: "Revenue",
    unit: "currency",
    better: "up",
    description: "Invoiced value of completed jobs.",
    definition:
      "Sum of invoice_amount of jobs with job_status = completed and invoice_amount > 0, attributed to the completion date (completed_at, else scheduled_datetime, else created_at). Cancelled and no-show jobs are excluded.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  collected_revenue: {
    id: "collected_revenue",
    label: "Collected revenue",
    unit: "currency",
    better: "up",
    description: "Part of revenue that has actually been paid.",
    definition: "Revenue (as defined above) restricted to jobs whose invoice_status = paid.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  collection_rate: {
    id: "collection_rate",
    label: "Collection rate",
    unit: "percent",
    better: "up",
    description: "Share of revenue that has been collected.",
    definition: "collected_revenue / revenue x 100 over the same completed jobs. Empty when revenue is 0.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  jobs_completed: {
    id: "jobs_completed",
    label: "Jobs completed",
    unit: "count",
    better: "up",
    description: "Number of finished jobs.",
    definition: "Count of jobs with job_status = completed (billable or not), attributed to the completion date.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  avg_ticket: {
    id: "avg_ticket",
    label: "Average ticket",
    unit: "currency",
    better: "up",
    description: "Average invoiced value per billed job.",
    definition: "revenue / number of completed jobs with invoice_amount > 0. Empty when no job was billed.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  gross_profit: {
    id: "gross_profit",
    label: "Gross profit",
    unit: "currency",
    better: "up",
    description: "Revenue minus recorded job costs, for jobs whose costs are recorded.",
    definition:
      "For completed billed jobs that have at least one job_cost_entries row: invoice_amount minus the sum of total_cost_cents / 100. Jobs without cost entries are left out (their cost is unknown, not zero).",
    version: 1,
    dimensions: JOB_DIMS,
  },
  gross_margin: {
    id: "gross_margin",
    label: "Gross margin",
    unit: "percent",
    better: "up",
    description: "Profit as a share of revenue, for jobs with recorded costs.",
    definition:
      "gross_profit / revenue x 100, computed only over completed billed jobs that have at least one cost entry. Empty when no such job exists. Coverage (costed jobs / billed jobs) is reported alongside.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  quotes_sent: {
    id: "quotes_sent",
    label: "Quotes sent",
    unit: "count",
    better: "up",
    description: "Quotes sent to customers.",
    definition: "Count of quotes with a sent_at in the period, whatever their current status.",
    version: 1,
    dimensions: [],
  },
  close_rate: {
    id: "close_rate",
    label: "Close rate",
    unit: "percent",
    better: "up",
    description: "Share of decided quotes that were accepted.",
    definition:
      "accepted / (accepted + declined + expired) x 100 over quotes sent in the period. Quotes still waiting for an answer are not counted. Empty when no quote has been decided.",
    version: 1,
    dimensions: [],
  },
  response_time: {
    id: "response_time",
    label: "Response time",
    unit: "minutes",
    better: "down",
    description: "Median time from job creation to the first response.",
    definition:
      "Median minutes between jobs.created_at and jobs.first_response_at (the moment a job first leaves 'scheduled'), for jobs created in the period whose first response happened within 30 days. Same rule as the outcome benchmark network.",
    version: 1,
    dimensions: JOB_DIMS,
  },
  missed_calls: {
    id: "missed_calls",
    label: "Missed calls",
    unit: "count",
    better: "down",
    description: "Calls nobody picked up.",
    definition: "Count of calls with status = missed, attributed to call_datetime.",
    version: 1,
    dimensions: [],
  },
  recovery_rate: {
    id: "recovery_rate",
    label: "Recovery rate",
    unit: "percent",
    better: "up",
    description: "Share of missed calls and voicemails that were won back.",
    definition:
      "recovered / all revenue_recovery_events with source_type in (missed_call, voicemail) x 100, attributed to occurred_at. Empty when there are no events.",
    version: 1,
    dimensions: [],
  },
  recovered_revenue: {
    id: "recovered_revenue",
    label: "Recovered revenue",
    unit: "currency",
    better: "up",
    description: "Revenue won back from missed calls and voicemails.",
    definition: "Sum of recovered_amount_cents / 100 for recovered missed_call and voicemail events, attributed to occurred_at.",
    version: 1,
    dimensions: [],
  },
};

export const METRIC_IDS = Object.keys(METRICS) as MetricId[];
export const DIMENSIONS: readonly Dimension[] = ["service_type", "technician", "customer_type"];
export const DIMENSION_LABELS: Record<Dimension, string> = {
  service_type: "Service type",
  technician: "Technician",
  customer_type: "Customer type",
};

export const isMetricId = (v: unknown): v is MetricId => typeof v === "string" && (METRIC_IDS as string[]).includes(v);
export const isDimension = (v: unknown): v is Dimension => typeof v === "string" && (DIMENSIONS as string[]).includes(v);

// ============================================================
// Input data (only the columns the layer reads)
// ============================================================

export interface MetricJob {
  id: string;
  assigned_technician_id: string | null;
  job_status: string;
  invoice_amount: number | null;
  invoice_status: string | null;
  completed_at: string | null;
  scheduled_datetime: string | null;
  created_at: string;
  first_response_at?: string | null;
  service_type?: string | null;
  customer_type?: string | null;
}
export interface MetricCost { job_id: string; total_cost_cents: number | null }
export interface MetricQuote { status: string; sent_at: string | null }
export interface MetricCall { status: string; call_datetime: string }
export interface MetricRecovery {
  source_type: string;
  status: string;
  occurred_at: string;
  recovered_amount_cents: number | null;
}
export interface MetricTech { id: string; name: string }

export interface MetricData {
  jobs: MetricJob[];
  costs: MetricCost[];
  quotes: MetricQuote[];
  calls: MetricCall[];
  recoveries: MetricRecovery[];
  technicians: MetricTech[];
}

export const emptyMetricData = (): MetricData => ({ jobs: [], costs: [], quotes: [], calls: [], recoveries: [], technicians: [] });

// ============================================================
// Small helpers
// ============================================================

const DAY_MS = 86_400_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function pctChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return round1(((current - prior) / Math.abs(prior)) * 100);
}
export function pointChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return round1(current - prior);
}

export function validTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(t: number, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f.format(new Date(t));
}

const ymdToUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const utcToYmd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Bucket key (the first local day of the bucket) for a local YYYY-MM-DD. */
export function bucketOfDate(ymd: string, g: Granularity): string {
  if (g === "month") return `${ymd.slice(0, 7)}-01`;
  if (g === "week") {
    const t = ymdToUtc(ymd);
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    return utcToYmd(t - dow * DAY_MS);
  }
  return ymd;
}

function nextBucket(key: string, g: Granularity): string {
  const t = ymdToUtc(key);
  if (g === "month") {
    const d = new Date(t);
    return utcToYmd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return utcToYmd(t + (g === "week" ? 7 : 1) * DAY_MS);
}

// ============================================================
// Normalised events
// ============================================================

interface DoneJob {
  t: number;
  revenue: number;
  billable: boolean;
  paid: boolean;
  costed: boolean;
  cost: number;
  dims: Record<Dimension, string>;
}
interface RespJob { t: number; minutes: number; dims: Record<Dimension, string> }
interface QuoteEv { t: number; decided: boolean; accepted: boolean }
interface CountEv { t: number }
interface RecoveryEv { t: number; recovered: boolean; amount: number }

export interface Prepared {
  done: DoneJob[];
  resp: RespJob[];
  quotes: QuoteEv[];
  missed: CountEv[];
  recoveries: RecoveryEv[];
  techNames: Map<string, string>;
}

const RESPONSE_MAX_MS = 30 * DAY_MS;

export function prepare(data: MetricData): Prepared {
  const techNames = new Map(data.technicians.map((t) => [t.id, t.name]));
  const costByJob = new Map<string, number>();
  for (const c of data.costs) costByJob.set(c.job_id, (costByJob.get(c.job_id) ?? 0) + num(c.total_cost_cents) / 100);

  const dimsOf = (j: MetricJob): Record<Dimension, string> => ({
    service_type: j.service_type?.trim() || "Unspecified",
    technician: j.assigned_technician_id ? techNames.get(j.assigned_technician_id) ?? "Former team member" : "Unassigned",
    customer_type: j.customer_type?.trim() || "unspecified",
  });

  const done: DoneJob[] = [];
  const resp: RespJob[] = [];
  for (const j of data.jobs) {
    if (j.job_status === "completed") {
      const t = ms(j.completed_at) ?? ms(j.scheduled_datetime) ?? ms(j.created_at);
      if (t !== null) {
        const amount = num(j.invoice_amount);
        const billable = amount > 0;
        done.push({
          t,
          revenue: billable ? amount : 0,
          billable,
          paid: billable && j.invoice_status === "paid",
          costed: billable && costByJob.has(j.id),
          cost: costByJob.get(j.id) ?? 0,
          dims: dimsOf(j),
        });
      }
    }
    const created = ms(j.created_at);
    const first = ms(j.first_response_at);
    if (created !== null && first !== null && first >= created && first <= created + RESPONSE_MAX_MS) {
      resp.push({ t: created, minutes: (first - created) / 60_000, dims: dimsOf(j) });
    }
  }

  const quotes: QuoteEv[] = [];
  for (const q of data.quotes) {
    const t = ms(q.sent_at);
    if (t === null) continue;
    quotes.push({ t, decided: ["accepted", "declined", "expired"].includes(q.status), accepted: q.status === "accepted" });
  }

  const missed: CountEv[] = [];
  for (const c of data.calls) {
    const t = ms(c.call_datetime);
    if (c.status === "missed" && t !== null) missed.push({ t });
  }

  const recoveries: RecoveryEv[] = [];
  for (const r of data.recoveries) {
    const t = ms(r.occurred_at);
    if (t === null || !["missed_call", "voicemail"].includes(r.source_type)) continue;
    const recovered = r.status === "recovered";
    recoveries.push({ t, recovered, amount: recovered ? num(r.recovered_amount_cents) / 100 : 0 });
  }

  return { done, resp, quotes, missed, recoveries, techNames };
}

// ============================================================
// Evaluation
// ============================================================

export interface Cell {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  /** Rows behind the value (jobs, quotes, calls, events). 0 = no data. */
  n: number;
}

const cell = (value: number | null, n: number, numerator: number | null = null, denominator: number | null = null): Cell => ({
  value,
  numerator,
  denominator,
  n,
});

interface Slice {
  done: DoneJob[];
  resp: RespJob[];
  quotes: QuoteEv[];
  missed: CountEv[];
  recoveries: RecoveryEv[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function evaluateSlice(id: MetricId, s: Slice): Cell {
  switch (id) {
    case "revenue":
    case "collected_revenue": {
      const rows = s.done.filter((j) => j.billable && (id === "revenue" || j.paid));
      return cell(round2(rows.reduce((a, j) => a + j.revenue, 0)), rows.length);
    }
    case "collection_rate": {
      const billed = s.done.filter((j) => j.billable);
      const revenue = billed.reduce((a, j) => a + j.revenue, 0);
      const collected = billed.filter((j) => j.paid).reduce((a, j) => a + j.revenue, 0);
      return revenue > 0 ? cell(round1((collected / revenue) * 100), billed.length, round2(collected), round2(revenue)) : cell(null, billed.length);
    }
    case "jobs_completed":
      return cell(s.done.length, s.done.length);
    case "avg_ticket": {
      const billed = s.done.filter((j) => j.billable);
      const revenue = billed.reduce((a, j) => a + j.revenue, 0);
      return billed.length ? cell(round2(revenue / billed.length), billed.length, round2(revenue), billed.length) : cell(null, 0);
    }
    case "gross_profit":
    case "gross_margin": {
      const costed = s.done.filter((j) => j.costed);
      const revenue = costed.reduce((a, j) => a + j.revenue, 0);
      const cost = costed.reduce((a, j) => a + j.cost, 0);
      if (id === "gross_profit") return cell(costed.length ? round2(revenue - cost) : null, costed.length);
      return revenue > 0 ? cell(round1(((revenue - cost) / revenue) * 100), costed.length, round2(revenue - cost), round2(revenue)) : cell(null, costed.length);
    }
    case "quotes_sent":
      return cell(s.quotes.length, s.quotes.length);
    case "close_rate": {
      const decided = s.quotes.filter((q) => q.decided);
      const accepted = decided.filter((q) => q.accepted).length;
      return decided.length ? cell(round1((accepted / decided.length) * 100), decided.length, accepted, decided.length) : cell(null, 0);
    }
    case "response_time": {
      const m = median(s.resp.map((r) => r.minutes));
      return cell(m === null ? null : round1(m), s.resp.length);
    }
    case "missed_calls":
      return cell(s.missed.length, s.missed.length);
    case "recovery_rate": {
      const rec = s.recoveries.filter((r) => r.recovered).length;
      return s.recoveries.length ? cell(round1((rec / s.recoveries.length) * 100), s.recoveries.length, rec, s.recoveries.length) : cell(null, 0);
    }
    case "recovered_revenue": {
      const rec = s.recoveries.filter((r) => r.recovered);
      return cell(round2(rec.reduce((a, r) => a + r.amount, 0)), rec.length);
    }
  }
}

const inWin = (t: number, a: number, b: number) => t >= a && t < b;

function sliceWindow(p: Prepared, a: number, b: number): Slice {
  return {
    done: p.done.filter((e) => inWin(e.t, a, b)),
    resp: p.resp.filter((e) => inWin(e.t, a, b)),
    quotes: p.quotes.filter((e) => inWin(e.t, a, b)),
    missed: p.missed.filter((e) => inWin(e.t, a, b)),
    recoveries: p.recoveries.filter((e) => inWin(e.t, a, b)),
  };
}

type Filters = Partial<Record<Dimension, readonly string[]>>;

function applyFilters(s: Slice, f: Filters | undefined): Slice {
  if (!f) return s;
  const entries = (Object.entries(f) as [Dimension, readonly string[] | undefined][]).filter(([, v]) => v && v.length);
  if (!entries.length) return s;
  const ok = (dims: Record<Dimension, string>) => entries.every(([d, vals]) => (vals as readonly string[]).includes(dims[d]));
  return { ...s, done: s.done.filter((e) => ok(e.dims)), resp: s.resp.filter((e) => ok(e.dims)) };
}

// ============================================================
// Query API
// ============================================================

export const MAX_RANGE_DAYS = 400;
export const MAX_METRICS_PER_QUERY = 13;
export const MAX_GROUPS = 12;

export interface MetricQuery {
  metrics: MetricId[];
  /** ISO instants, [from, to). */
  from: string;
  to: string;
  tz: string;
  granularity: Granularity;
  groupBy: Dimension | null;
  /** Also compute the immediately preceding period of the same length. */
  compare: boolean;
  /** Restrict job-based metrics to these dimension values (used by embeds). */
  filters?: Filters;
}

export interface Delta { kind: "pct" | "pts"; value: number | null }

export interface MetricResult {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  better: "up" | "down";
  version: number;
  total: Cell;
  prior?: Cell;
  delta?: Delta;
  series?: { bucket: string; cell: Cell }[];
  groups?: { key: string; cell: Cell }[];
  notes: string[];
}

export interface MetricsResponse {
  from: string;
  to: string;
  tz: string;
  granularity: Granularity;
  groupBy: Dimension | null;
  results: MetricResult[];
}

export type ParseResult = { ok: true; query: MetricQuery } | { ok: false; error: string };

/** Validates untrusted input (request body or embed config) into a safe MetricQuery. */
export function parseMetricQuery(raw: unknown, opts: { allowedMetrics?: readonly MetricId[]; maxDays?: number } = {}): ParseResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const metricsIn = Array.isArray(r.metrics) ? r.metrics : [];
  const metrics = [...new Set(metricsIn.filter(isMetricId))];
  if (!metrics.length) return { ok: false, error: "Choose at least one metric." };
  if (metrics.length > MAX_METRICS_PER_QUERY) return { ok: false, error: `Choose at most ${MAX_METRICS_PER_QUERY} metrics.` };
  if (opts.allowedMetrics) {
    const denied = metrics.find((m) => !opts.allowedMetrics!.includes(m));
    if (denied) return { ok: false, error: `Metric "${denied}" is not available here.` };
  }
  const from = ms(typeof r.from === "string" ? r.from : null);
  const to = ms(typeof r.to === "string" ? r.to : null);
  if (from === null || to === null || to <= from) return { ok: false, error: "Choose a valid date range." };
  const maxDays = Math.min(opts.maxDays ?? MAX_RANGE_DAYS, MAX_RANGE_DAYS);
  if ((to - from) / DAY_MS > maxDays) return { ok: false, error: `The date range can be at most ${maxDays} days.` };
  const granularity: Granularity = ["none", "day", "week", "month"].includes(r.granularity as string) ? (r.granularity as Granularity) : "none";
  const groupBy = isDimension(r.groupBy) ? r.groupBy : null;
  if (groupBy) {
    const bad = metrics.find((m) => !METRICS[m].dimensions.includes(groupBy));
    if (bad) return { ok: false, error: `"${METRICS[bad].label}" cannot be broken down by ${DIMENSION_LABELS[groupBy].toLowerCase()}.` };
  }
  const filters: Filters = {};
  if (r.filters && typeof r.filters === "object") {
    for (const [k, v] of Object.entries(r.filters as Record<string, unknown>)) {
      if (!isDimension(k) || !Array.isArray(v)) continue;
      const vals = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120).slice(0, 50);
      if (vals.length) filters[k] = vals;
    }
  }
  if (Object.keys(filters).length) {
    const bad = metrics.find((m) => !METRICS[m].dimensions.length);
    if (bad) return { ok: false, error: `"${METRICS[bad].label}" cannot be combined with a filter.` };
  }
  return {
    ok: true,
    query: {
      metrics,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      tz: validTimeZone(r.tz),
      granularity,
      groupBy,
      compare: r.compare === true,
      filters: Object.keys(filters).length ? filters : undefined,
    },
  };
}

function bucketKeys(startMs: number, endMs: number, tz: string, g: Granularity): string[] {
  const first = bucketOfDate(localDate(startMs, tz), g);
  const last = bucketOfDate(localDate(endMs - 1, tz), g);
  const keys: string[] = [];
  for (let k = first; k <= last && keys.length <= 400; k = nextBucket(k, g)) keys.push(k);
  return keys;
}

function partition(s: Slice, tz: string, g: Granularity): Map<string, Slice> {
  const out = new Map<string, Slice>();
  const get = (t: number): Slice => {
    const key = bucketOfDate(localDate(t, tz), g);
    let b = out.get(key);
    if (!b) out.set(key, (b = { done: [], resp: [], quotes: [], missed: [], recoveries: [] }));
    return b;
  };
  for (const e of s.done) get(e.t).done.push(e);
  for (const e of s.resp) get(e.t).resp.push(e);
  for (const e of s.quotes) get(e.t).quotes.push(e);
  for (const e of s.missed) get(e.t).missed.push(e);
  for (const e of s.recoveries) get(e.t).recoveries.push(e);
  return out;
}

const EMPTY: Slice = { done: [], resp: [], quotes: [], missed: [], recoveries: [] };

function deltaOf(def: MetricDef, cur: Cell, prior: Cell): Delta {
  return def.unit === "percent"
    ? { kind: "pts", value: pointChange(cur.value, prior.value) }
    : { kind: "pct", value: pctChange(cur.value, prior.value) };
}

export function computeMetrics(data: MetricData, query: MetricQuery, prepared: Prepared = prepare(data)): MetricsResponse {
  const a = Date.parse(query.from);
  const b = Date.parse(query.to);
  const cur = applyFilters(sliceWindow(prepared, a, b), query.filters);
  const prev = query.compare ? applyFilters(sliceWindow(prepared, a - (b - a), a), query.filters) : null;
  const buckets = query.granularity !== "none" ? partition(cur, query.tz, query.granularity) : null;
  const keys = buckets ? bucketKeys(a, b, query.tz, query.granularity) : [];

  const billedJobs = cur.done.filter((j) => j.billable).length;
  const costedJobs = cur.done.filter((j) => j.costed).length;

  const results = query.metrics.map((id): MetricResult => {
    const def = METRICS[id];
    const total = evaluateSlice(id, cur);
    const res: MetricResult = {
      id,
      label: def.label,
      unit: def.unit,
      better: def.better,
      version: def.version,
      total,
      notes: [],
    };
    if (prev) {
      res.prior = evaluateSlice(id, prev);
      res.delta = deltaOf(def, total, res.prior);
    }
    if (buckets) res.series = keys.map((k) => ({ bucket: k, cell: evaluateSlice(id, buckets.get(k) ?? EMPTY) }));
    if (query.groupBy) {
      const dim = query.groupBy;
      const byKey = new Map<string, Slice>();
      const add = (k: string): Slice => {
        let s = byKey.get(k);
        if (!s) byKey.set(k, (s = { done: [], resp: [], quotes: [], missed: [], recoveries: [] }));
        return s;
      };
      for (const e of cur.done) add(e.dims[dim]).done.push(e);
      for (const e of cur.resp) add(e.dims[dim]).resp.push(e);
      const rows = [...byKey.entries()].map(([key, s]) => ({ key, cell: evaluateSlice(id, s) }));
      // Money and counts rank by value; ratios and times rank by how much data is behind them.
      const weight = (c: Cell) => (def.unit === "currency" || def.unit === "count" ? c.value ?? -1 : c.n);
      rows.sort((x, y) => weight(y.cell) - weight(x.cell) || x.key.localeCompare(y.key));
      res.groups = rows.slice(0, MAX_GROUPS);
    }
    if (id === "gross_margin" || id === "gross_profit") {
      if (billedJobs === 0) res.notes.push("No completed jobs with recorded costs in this period.");
      else if (costedJobs < billedJobs) res.notes.push(`Based on the ${costedJobs} of ${billedJobs} billed jobs that have recorded costs.`);
    }
    if (id === "close_rate" && total.value === null) res.notes.push("No quote sent in this period has been decided yet.");
    if (id === "response_time" && total.n > 0 && total.n < 5) res.notes.push(`Only ${total.n} job${total.n === 1 ? "" : "s"} with a recorded response, so treat this as indicative.`);
    return res;
  });

  return { from: query.from, to: query.to, tz: query.tz, granularity: query.granularity, groupBy: query.groupBy, results };
}

// ============================================================
// Convenience builders
// ============================================================

export function defaultQuery(overrides: Partial<MetricQuery> & { days?: number; now?: Date } = {}): MetricQuery {
  const now = overrides.now ?? new Date();
  const days = overrides.days ?? 30;
  const to = overrides.to ?? now.toISOString();
  const from = overrides.from ?? new Date(Date.parse(to) - days * DAY_MS).toISOString();
  return {
    metrics: overrides.metrics ?? METRIC_IDS,
    from,
    to,
    tz: validTimeZone(overrides.tz),
    granularity: overrides.granularity ?? "none",
    groupBy: overrides.groupBy ?? null,
    compare: overrides.compare ?? false,
    filters: overrides.filters,
  };
}

export interface DailySnapshot {
  metric_id: MetricId;
  day: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  sample_size: number;
  definition_version: number;
}

/** One row per metric per local day, ready to upsert into metric_snapshots. */
export function dailySnapshots(data: MetricData, opts: { days: number; tz: string; now?: Date }): DailySnapshot[] {
  const now = opts.now ?? new Date();
  const tz = validTimeZone(opts.tz);
  const days = Math.min(Math.max(1, Math.floor(opts.days)), MAX_RANGE_DAYS);
  const to = now.getTime();
  const from = to - days * DAY_MS;
  const res = computeMetrics(data, {
    metrics: METRIC_IDS,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    tz,
    granularity: "day",
    groupBy: null,
    compare: false,
  });
  const out: DailySnapshot[] = [];
  for (const m of res.results) {
    for (const s of m.series ?? []) {
      out.push({
        metric_id: m.id,
        day: s.bucket,
        value: s.cell.value,
        numerator: s.cell.numerator,
        denominator: s.cell.denominator,
        sample_size: s.cell.n,
        definition_version: m.version,
      });
    }
  }
  return out;
}

export function formatMetric(unit: MetricUnit, value: number | null, currency = "USD"): string {
  if (value === null) return "—";
  switch (unit) {
    case "currency":
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }).format(value);
      } catch {
        return value.toFixed(2);
      }
    case "percent":
      return `${value.toFixed(1)}%`;
    case "minutes":
      return value >= 120 ? `${(value / 60).toFixed(1)} h` : `${value.toFixed(value < 10 ? 1 : 0)} min`;
    default:
      return new Intl.NumberFormat("en-US").format(value);
  }
}

/**
 * Compact fact pack for the finance copilot (Ask Vireek): last 30 days vs the 30 before,
 * with the official definition of each metric, so the assistant quotes the same numbers and
 * the same rules as the dashboard.
 */
export function buildOfficialFacts(data: MetricData, opts: { now: Date; tz: string; days?: number }): Record<string, unknown> {
  const days = opts.days ?? 30;
  const q = defaultQuery({
    now: opts.now,
    days,
    tz: opts.tz,
    compare: true,
    metrics: ["revenue", "collected_revenue", "jobs_completed", "avg_ticket", "gross_profit", "gross_margin", "close_rate", "response_time", "missed_calls", "recovery_rate", "recovered_revenue"],
  });
  const res = computeMetrics(data, q);
  const out: Record<string, unknown> = {};
  for (const m of res.results) {
    out[m.id] = {
      label: m.label,
      unit: m.unit,
      last_period: m.total.value,
      previous_period: m.prior?.value ?? null,
      change: m.delta ? { kind: m.delta.kind, value: m.delta.value } : null,
      sample_size: m.total.n,
      definition: METRICS[m.id].definition,
      definition_version: m.version,
      ...(m.notes.length ? { notes: m.notes } : {}),
    };
  }
  return { period_days: days, period_end: q.to, metrics: out };
}
