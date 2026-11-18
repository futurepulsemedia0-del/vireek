// supabase/functions/_shared/economics/aiRoi.ts
//
// Customer-facing "AI value" numbers computed ONLY from the customer's own rows. Pure and import-free.
// Every metric carries its formula, its data source and a kind:
//   measured  - a count/sum straight from the customer's data
//   booked    - something the AI scheduled; value NOT yet realised
//   estimated - uses an assumption (always spelled out in `formula`)
// When data is insufficient the metric is `{ status: "not_enough_data", value: null }` - never a made-up number.
//
// STRICT "AI-attributed revenue" = job created by the AI voice tool AND job completed AND an invoice for it is paid.

export type MetricKind = "measured" | "booked" | "estimated";
export interface Metric {
  key: string;
  label: string;
  kind: MetricKind;
  status: "ok" | "not_enough_data";
  value: number | null; // counts, hours, or cents (see `unit`)
  unit: "count" | "hours" | "cents";
  formula: string;
  source: string;
  note?: string;
}
export interface FunnelStep { key: "booked" | "completed" | "paid"; label: string; count: number }

export interface AiRoiRaw {
  calls: { total: number; answered: number; missed: number; after_hours_known: number; after_hours_answered: number; handled_seconds: number };
  ai_jobs: { id: string; created_at: string; job_status: string; completed_at: string | null; amount_cents: number | null; paid: boolean }[];
  history: { n: number; sum_cents: number };
  recovery: { events: number; recovered: number; recovered_cents: number };
  jobs_truncated?: boolean;
}
export interface AiRoiConfig { minHistoryJobs: number; hoursSavedFactor: number }
export const DEFAULT_AI_ROI: AiRoiConfig = { minHistoryJobs: 5, hoursSavedFactor: 1 };

export interface AiRoi {
  metrics: Record<string, Metric>;
  funnel: FunnelStep[];
  attributedRevenueCents: number;
  paidWithoutAmount: number;
  truncated: boolean;
}

const nn = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function computeAiRoi(raw: AiRoiRaw, cfg: AiRoiConfig = DEFAULT_AI_ROI): AiRoi {
  const c = raw.calls;
  const jobs = raw.ai_jobs;
  const booked = jobs.length;
  const completed = jobs.filter((j) => j.job_status === "completed");
  const paid = completed.filter((j) => j.paid);
  const paidWithAmount = paid.filter((j) => typeof j.amount_cents === "number" && j.amount_cents > 0);
  const attributed = paidWithAmount.reduce((s, j) => s + (j.amount_cents as number), 0);

  const avgJob = raw.history.n >= cfg.minHistoryJobs && raw.history.sum_cents > 0 ? Math.round(raw.history.sum_cents / raw.history.n) : null;
  const unrealised = booked - paid.length; // AI bookings not (yet) completed AND paid
  const handledMin = Math.ceil(nn(c.handled_seconds) / 60);

  const m: Record<string, Metric> = {};
  const add = (x: Metric) => { m[x.key] = x; };

  add({ key: "calls_answered", label: "Calls answered by AI", kind: "measured", status: "ok", value: nn(c.answered), unit: "count",
    formula: "count(calls) excluding missed, voicemail and spam", source: "calls (your account, selected period)" });

  const ahOk = nn(c.after_hours_known) > 0;
  add({ key: "after_hours_answered", label: "After-hours calls answered", kind: "measured", status: ahOk ? "ok" : "not_enough_data", value: ahOk ? nn(c.after_hours_answered) : null, unit: "count",
    formula: "answered calls whose local time is outside your configured business hours", source: "calls + business_profile.business_hours + business_regional_settings.time_zone",
    note: ahOk ? undefined : "Set your business hours and time zone to measure this." });

  const recOk = nn(raw.recovery.events) > 0;
  add({ key: "missed_recovered", label: "Missed calls recovered", kind: "measured", status: recOk ? "ok" : "not_enough_data", value: recOk ? nn(raw.recovery.recovered) : null, unit: "count",
    formula: "revenue_recovery_events with status = recovered, for missed calls and voicemails", source: "revenue_recovery_events",
    note: recOk ? `${nn(raw.recovery.recovered)} of ${nn(raw.recovery.events)} missed-call events` : "No missed-call events in this period." });

  add({ key: "ai_bookings", label: "Bookings created by AI", kind: "booked", status: "ok", value: booked, unit: "count",
    formula: "count(jobs created in the period with a voice-booking idempotency key)", source: "jobs.voice_idempotency_key",
    note: "Jobs booked before this tracking existed are not counted, so this can only be understated." });

  add({ key: "avg_job_value", label: "Average job value (your history)", kind: "measured", status: avgJob === null ? "not_enough_data" : "ok", value: avgJob, unit: "cents",
    formula: `sum(paid job amounts, last 12 months) / count(paid jobs); needs at least ${cfg.minHistoryJobs} paid jobs`, source: "jobs + invoices (status = paid)",
    note: avgJob === null ? `Only ${raw.history.n} paid job(s) so far.` : `${raw.history.n} paid jobs` });

  add({ key: "ai_attributed_revenue", label: "AI-attributed revenue (paid)", kind: "measured", status: "ok", value: attributed, unit: "cents",
    formula: "sum(job amount) where job was created by AI AND completed AND an invoice for it is paid", source: "jobs + invoices",
    note: raw.history.n === 0 && paid.length === 0 ? "No paid AI-booked jobs yet." : undefined });

  add({ key: "estimated_revenue_influenced", label: "Estimated revenue still in the pipeline", kind: "estimated", status: avgJob === null ? "not_enough_data" : "ok",
    value: avgJob === null ? null : unrealised * avgJob, unit: "cents",
    formula: "(AI bookings - AI bookings completed and paid) x your average job value", source: "jobs + invoices",
    note: "An estimate, not revenue: these jobs are not completed and paid yet." });

  add({ key: "hours_saved", label: "Staff hours saved", kind: "estimated", status: handledMin > 0 ? "ok" : "not_enough_data",
    value: handledMin > 0 ? Math.round((handledMin / 60) * cfg.hoursSavedFactor * 10) / 10 : null, unit: "hours",
    formula: `minutes the AI spent on answered calls / 60 x ${cfg.hoursSavedFactor} (assumes your staff would have spent the same time)`, source: "calls.duration_seconds" });

  return {
    metrics: m,
    funnel: [
      { key: "booked", label: "Booked by AI", count: booked },
      { key: "completed", label: "Completed", count: completed.length },
      { key: "paid", label: "Invoice paid", count: paid.length },
    ],
    attributedRevenueCents: attributed,
    paidWithoutAmount: paid.length - paidWithAmount.length,
    truncated: raw.jobs_truncated === true,
  };
}

/** Defensive parse of the RPC payload (unknown shape -> null; never throws). */
export function parseAiRoiRaw(x: unknown): AiRoiRaw | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  const calls = o.calls as Record<string, unknown> | undefined;
  const hist = o.history as Record<string, unknown> | undefined;
  const rec = o.recovery as Record<string, unknown> | undefined;
  if (!calls || !hist || !rec || !Array.isArray(o.ai_jobs)) return null;
  const jobs = (o.ai_jobs as unknown[]).flatMap((r) => {
    if (typeof r !== "object" || r === null) return [];
    const j = r as Record<string, unknown>;
    if (typeof j.id !== "string") return [];
    return [{
      id: j.id, created_at: String(j.created_at ?? ""), job_status: String(j.job_status ?? ""),
      completed_at: typeof j.completed_at === "string" ? j.completed_at : null,
      amount_cents: typeof j.amount_cents === "number" ? j.amount_cents : null, paid: j.paid === true,
    }];
  });
  return {
    calls: { total: nn(calls.total), answered: nn(calls.answered), missed: nn(calls.missed), after_hours_known: nn(calls.after_hours_known), after_hours_answered: nn(calls.after_hours_answered), handled_seconds: nn(calls.handled_seconds) },
    ai_jobs: jobs, history: { n: nn(hist.n), sum_cents: nn(hist.sum_cents) },
    recovery: { events: nn(rec.events), recovered: nn(rec.recovered), recovered_cents: nn(rec.recovered_cents) },
    jobs_truncated: o.jobs_truncated === true,
  };
}

// ---------------------------------------------------------------- display summary (email / PDF)
export interface AiRoiSection {
  lines: { label: string; display: string; kind: MetricKind; formula: string }[];
  funnel: { label: string; count: number }[];
}
const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Pre-formatted rows so the monthly email shows exactly what the dashboard shows (same module, same wording). */
export function summarizeAiRoi(r: AiRoi): AiRoiSection {
  const display = (m: Metric): string => {
    if (m.status !== "ok" || m.value === null) return "Not enough data yet";
    return m.unit === "cents" ? fmtUsd(m.value) : m.unit === "hours" ? `${m.value} h` : m.value.toLocaleString("en-US");
  };
  return {
    lines: Object.values(r.metrics).map((m) => ({ label: m.label, display: display(m), kind: m.kind, formula: m.formula })),
    funnel: r.funnel.map((f) => ({ label: f.label, count: f.count })),
  };
}
