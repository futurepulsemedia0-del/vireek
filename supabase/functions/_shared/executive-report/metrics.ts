// supabase/functions/_shared/executive-report/metrics.ts
// Deterministic KPI math. The AI layer never computes anything — it only
// narrates what this file produced.

import type {
  ExecutiveMetrics, GoalRow, GoalStatus, JobRow, Kpis, ReportData, ReportPeriod,
  ReportSettings, TechnicianRow,
} from "./types.ts";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

interface Range { startMs: number; endMs: number } // [start, end)

const inRange = (iso: string | null | undefined, r: Range): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= r.startMs && t < r.endMs;
};

/** When a completed job counts: completion time, else schedule, else creation. */
function jobDate(j: JobRow): string {
  return j.completed_at ?? j.scheduled_datetime ?? j.created_at;
}

export function pctChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return round1(((current - prior) / Math.abs(prior)) * 100);
}
export function pointChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return round1(current - prior);
}

export function computeKpis(range: Range, data: ReportData): Kpis {
  const completed = data.jobs.filter(
    (j) => j.job_status === "completed" && inRange(jobDate(j), range),
  );
  const billable = completed.filter((j) => num(j.invoice_amount) > 0);
  const revenue = round2(billable.reduce((s, j) => s + num(j.invoice_amount), 0));
  const collected = round2(
    billable.filter((j) => j.invoice_status === "paid").reduce((s, j) => s + num(j.invoice_amount), 0),
  );

  const costByJob = new Map<string, number>();
  for (const c of data.costs) costByJob.set(c.job_id, (costByJob.get(c.job_id) ?? 0) + num(c.amount));
  const costed = billable.filter((j) => costByJob.has(j.id));
  const costedRevenue = round2(costed.reduce((s, j) => s + num(j.invoice_amount), 0));
  const totalCost = round2(costed.reduce((s, j) => s + (costByJob.get(j.id) ?? 0), 0));

  const sent = data.quotes.filter((q) => inRange(q.sent_at, range));
  const decided = sent.filter((q) => ["accepted", "declined", "expired"].includes(q.status));
  const accepted = decided.filter((q) => q.status === "accepted");

  const missedCalls = data.calls.filter((c) => c.status === "missed" && inRange(c.call_datetime, range)).length;
  const events = data.recoveries.filter(
    (r) => ["missed_call", "voicemail"].includes(r.source_type) && inRange(r.occurred_at, range),
  );
  const recovered = events.filter((r) => r.status === "recovered");
  const recoveredValue = round2(recovered.reduce((s, r) => s + num(r.recovered_amount_cents), 0) / 100);

  const reworkJobs = completed.filter((j) => j.is_rework === true).length;

  return {
    revenue,
    collected,
    jobsCompleted: completed.length,
    jobsBooked: data.jobs.filter((j) => inRange(j.created_at, range)).length,
    avgTicket: billable.length ? round2(revenue / billable.length) : null,
    quotesSent: sent.length,
    quotesDecided: decided.length,
    quotesAccepted: accepted.length,
    closeRatePct: decided.length ? round1((accepted.length / decided.length) * 100) : null,
    missedCalls,
    missedCallEvents: events.length,
    recoveredCount: recovered.length,
    recoveredValue,
    recoveryRatePct: events.length ? round1((recovered.length / events.length) * 100) : null,
    costedJobs: costed.length,
    costedRevenue,
    totalCost,
    marginPct: costedRevenue > 0 ? round1(((costedRevenue - totalCost) / costedRevenue) * 100) : null,
    reworkJobs,
    reworkRatePct: completed.length ? round1((reworkJobs / completed.length) * 100) : null,
  };
}

export function topTechnicians(range: Range, data: ReportData, limit = 5): TechnicianRow[] {
  const names = new Map(data.technicians.map((t) => [t.id, (t.member_name?.trim() || t.member_email)]));
  const by = new Map<string, { jobs: number; revenue: number; billable: number; rework: number }>();
  for (const j of data.jobs) {
    if (j.job_status !== "completed" || !j.assigned_technician_id || !inRange(jobDate(j), range)) continue;
    const row = by.get(j.assigned_technician_id) ?? { jobs: 0, revenue: 0, billable: 0, rework: 0 };
    row.jobs += 1;
    if (num(j.invoice_amount) > 0) { row.revenue += num(j.invoice_amount); row.billable += 1; }
    if (j.is_rework === true) row.rework += 1;
    by.set(j.assigned_technician_id, row);
  }
  return [...by.entries()]
    .map(([id, r]): TechnicianRow => ({
      id,
      name: names.get(id) ?? "Former team member",
      jobs: r.jobs,
      revenue: round2(r.revenue),
      avgTicket: r.billable ? round2(r.revenue / r.billable) : null,
      reworkRatePct: r.jobs ? round1((r.rework / r.jobs) * 100) : null,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.jobs - a.jobs || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function goalStatus(actual: number | null, goal: number): { pct: number | null; status: GoalStatus } {
  if (actual === null) return { pct: null, status: "no_data" };
  const pct = goal > 0 ? round1((actual / goal) * 100) : actual >= goal ? 100 : 0;
  return { pct, status: pct >= 100 ? "achieved" : pct >= 90 ? "near" : "behind" };
}

export function buildGoalRows(k: Kpis, s: Pick<ReportSettings, "revenue_goal" | "jobs_goal" | "close_rate_goal_pct" | "margin_goal_pct">): GoalRow[] {
  const rows: GoalRow[] = [];
  const add = (key: GoalRow["key"], label: string, unit: GoalRow["unit"], goal: number | null, actual: number | null) => {
    if (goal === null || goal === undefined || !Number.isFinite(goal)) return;
    const { pct, status } = goalStatus(actual, goal);
    rows.push({ key, label, unit, goal, actual, attainmentPct: pct, status });
  };
  add("revenue", "Revenue", "currency", s.revenue_goal, k.revenue);
  add("jobs", "Jobs completed", "count", s.jobs_goal, k.jobsCompleted);
  add("close_rate", "Close rate", "percent", s.close_rate_goal_pct, k.closeRatePct);
  add("margin", "Gross margin", "percent", s.margin_goal_pct, k.marginPct);
  return rows;
}

export function computeExecutiveMetrics(period: ReportPeriod, data: ReportData, settings: ReportSettings): ExecutiveMetrics {
  const cur: Range = { startMs: Date.parse(period.startUtc), endMs: Date.parse(period.endUtc) };
  const pri: Range = { startMs: Date.parse(period.prior.startUtc), endMs: Date.parse(period.prior.endUtc) };
  const current = computeKpis(cur, data);
  const prior = computeKpis(pri, data);

  const withRevenue = data.jobs.filter(
    (j) => j.job_status === "completed" && inRange(jobDate(j), cur) && num(j.invoice_amount) > 0,
  ).length;
  const costCoveragePct = withRevenue ? round1((current.costedJobs / withRevenue) * 100) : null;
  const notes: string[] = [];
  if (costCoveragePct !== null && costCoveragePct < 100) {
    notes.push(`Margin is based on the ${current.costedJobs} of ${withRevenue} billed jobs with recorded costs (${costCoveragePct}%).`);
  }
  if (current.closeRatePct === null) notes.push("Close rate unavailable: no quotes sent this month reached a decision yet.");

  return {
    period: { start: period.start, end: period.end, label: period.label },
    current,
    prior,
    deltas: {
      revenuePct: pctChange(current.revenue, prior.revenue),
      jobsCompletedPct: pctChange(current.jobsCompleted, prior.jobsCompleted),
      avgTicketPct: pctChange(current.avgTicket, prior.avgTicket),
      closeRatePts: pointChange(current.closeRatePct, prior.closeRatePct),
      recoveredValuePct: pctChange(current.recoveredValue, prior.recoveredValue),
      marginPts: pointChange(current.marginPct, prior.marginPct),
    },
    topTechnicians: topTechnicians(cur, data),
    goals: buildGoalRows(current, settings),
    dataQuality: { costCoveragePct, notes },
  };
}
