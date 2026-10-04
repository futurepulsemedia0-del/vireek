// supabase/functions/_shared/business-brain/analytics.ts
//
// Ask Vireek — deterministic analytics engine.
//
// RULE: every number the owner sees comes from this file. The LLM never
// computes, estimates or recalls figures; it only explains the objects
// returned here. Each function is pure (RawData in, plain object out),
// tolerant of missing data (returns nulls / notes instead of throwing),
// and states its basis ("measured" vs "estimated") so the answer can be
// honest about certainty.

import type {
  Candidate,
  Coverage,
  CostRow,
  JobRow,
  Leak,
  Period,
  QuestionPlan,
  RawData,
  ServiceLine,
} from "./types.ts";
import {
  addDays,
  ageDays,
  dayKey,
  daysBetween,
  lineItemsTotalDollars,
  mean,
  median,
  monthEnd,
  mondayOf,
  pct,
  prettyDay,
  prevMonthStart,
  round,
  safeText,
  sum,
  tradeOf,
  usd,
  weekdayOf,
} from "./util.ts";

// =====================================================================
// Context
// =====================================================================

export interface EnrichedJob {
  job: JobRow;
  /** Completion day for completed jobs, otherwise scheduled day (business time zone). */
  day: string;
  revenue: number;
  /** null = cost UNKNOWN (no cost entries) — never treated as zero. */
  cost: number | null;
  profit: number | null;
  trade: string;
}

export interface Ctx {
  raw: RawData;
  today: string;
  ej: EnrichedJob[];
  completed: EnrichedJob[];
  techNames: Map<string, string>;
  coverage: Coverage;
}

const DEFAULT_MAX_JOBS_PER_DAY = 6;
const WORKDAY_HOURS = 8;

function isCosted(c: CostRow | undefined): c is CostRow {
  if (!c) return false;
  const entries = c.cost_entry_count;
  if (typeof entries === "number") return entries > 0;
  return (c.total_cost_cents ?? 0) > 0;
}

export function buildContext(raw: RawData): Ctx {
  const today = dayKey(raw.now, raw.timeZone);
  const costById = new Map<string, CostRow>();
  for (const c of raw.costs ?? []) costById.set(c.job_id, c);

  const ej: EnrichedJob[] = raw.jobs.map((job) => {
    const completed = job.job_status === "completed";
    const when = completed
      ? (job.completed_at ?? job.scheduled_datetime ?? job.created_at)
      : (job.scheduled_datetime ?? job.created_at);
    const c = costById.get(job.id);
    const revenue =
      c && (c.revenue_cents ?? 0) > 0 ? (c.revenue_cents as number) / 100 : Number(job.invoice_amount ?? 0);
    const cost = isCosted(c) ? (c.total_cost_cents ?? 0) / 100 : null;
    return {
      job,
      day: dayKey(when, raw.timeZone),
      revenue: Number.isFinite(revenue) ? revenue : 0,
      cost,
      profit: cost === null ? null : revenue - cost,
      trade: tradeOf(job.service_type),
    };
  });

  const completed = ej.filter((e) => e.job.job_status === "completed");
  const costedCompleted = completed.filter((e) => e.cost !== null);
  const techNames = new Map<string, string>();
  for (const t of raw.techs) techNames.set(t.id, safeText(t.member_name ?? "Technician", 40));

  const since60 = addDays(today, -60);
  const recentCompleted = completed.filter((e) => e.day >= since60);
  const recentCosted = recentCompleted.filter((e) => e.cost !== null);
  const oldest = ej.reduce((min, e) => (e.day && e.day < min ? e.day : min), today);

  const coverage: Coverage = {
    jobs_in_window: raw.jobs.length,
    completed_jobs: completed.length,
    costed_jobs_pct: recentCompleted.length ? pct(recentCosted.length, recentCompleted.length, 0) : null,
    has_cost_data: raw.costs !== null && costedCompleted.length >= 5,
    technicians: raw.techs.filter((t) => t.dispatch_enabled !== false).length,
    history_days: Math.max(0, daysBetween(oldest, today)),
  };

  return { raw, today, ej, completed, techNames, coverage };
}

function techName(ctx: Ctx, id: string | null): string {
  return id ? (ctx.techNames.get(id) ?? "Technician") : "Unassigned";
}

function activeTechs(ctx: Ctx) {
  return ctx.raw.techs.filter((t) => t.dispatch_enabled !== false);
}

function maxJobsPerDay(t: { max_jobs_per_day: number | null }): number {
  return t.max_jobs_per_day && t.max_jobs_per_day > 0 ? t.max_jobs_per_day : DEFAULT_MAX_JOBS_PER_DAY;
}

/** Weekdays (0=Sun) the business actually works, from its own job history. */
function workWeekdays(ctx: Ctx): Set<number> {
  const since = addDays(ctx.today, -60);
  const counts = new Array<number>(7).fill(0);
  let total = 0;
  for (const e of ctx.ej) {
    if (e.job.job_status === "cancelled" || e.day < since || e.day > addDays(ctx.today, 14)) continue;
    counts[weekdayOf(e.day)]++;
    total++;
  }
  if (total < 10) return new Set([1, 2, 3, 4, 5]);
  const days = new Set<number>();
  counts.forEach((c, wd) => {
    if (c / total >= 0.08) days.add(wd);
  });
  return days.size ? days : new Set([1, 2, 3, 4, 5]);
}

function workdaysIn(ctx: Ctx, startKey: string, n: number): number {
  const wd = workWeekdays(ctx);
  let c = 0;
  for (let i = 0; i < n; i++) if (wd.has(weekdayOf(addDays(startKey, i)))) c++;
  return c;
}

function avgTicket(ctx: Ctx, trade: string | null, days = 60): number | null {
  const since = addDays(ctx.today, -days);
  const pool = ctx.completed.filter((e) => e.day >= since && e.revenue > 0);
  const scoped = trade ? pool.filter((e) => e.trade === trade) : pool;
  const rows = scoped.length >= 3 ? scoped : pool;
  return mean(rows.map((e) => e.revenue));
}

function avgProfit(ctx: Ctx, trade: string | null, days = 90): number | null {
  const since = addDays(ctx.today, -days);
  const pool = ctx.completed.filter((e) => e.day >= since && e.profit !== null);
  const scoped = trade ? pool.filter((e) => e.trade === trade) : pool;
  const rows = scoped.length >= 3 ? scoped : pool;
  return mean(rows.map((e) => e.profit as number));
}

function jobDurationMinutes(j: JobRow): number {
  return j.duration_minutes && j.duration_minutes > 0 ? j.duration_minutes : 60;
}

// =====================================================================
// Service-line economics
// =====================================================================

export function serviceLines(ctx: Ctx, days = 60, limit = 6): ServiceLine[] {
  const since = addDays(ctx.today, -days);
  const groups = new Map<string, EnrichedJob[]>();
  for (const e of ctx.completed) {
    if (e.day < since) continue;
    const key = safeText((e.job.service_type ?? "Unspecified").toLowerCase(), 40) || "unspecified";
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const lines: ServiceLine[] = [];
  for (const [service, rows] of groups) {
    const costed = rows.filter((r) => r.profit !== null);
    const costedRev = sum(costed.map((r) => r.revenue));
    const profit = costed.length ? sum(costed.map((r) => r.profit as number)) : null;
    lines.push({
      service,
      jobs: rows.length,
      revenue: round(sum(rows.map((r) => r.revenue))),
      profit: profit === null ? null : round(profit),
      margin_pct: profit !== null && costedRev > 0 ? round((profit / costedRev) * 100, 1) : null,
      avg_ticket: round(mean(rows.map((r) => r.revenue)) ?? 0),
      rework_rate_pct: round((rows.filter((r) => r.job.is_rework).length / rows.length) * 100, 1),
    });
  }
  return lines.sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

// =====================================================================
// 1) Why did profit change?  (exact volume / price-mix / cost decomposition)
// =====================================================================

interface Agg {
  n: number;
  rev: number;
  cost: number;
}

function aggregate(ctx: Ctx, start: string, end: string, useCost: boolean): Agg {
  const a: Agg = { n: 0, rev: 0, cost: 0 };
  for (const e of ctx.completed) {
    if (e.day < start || e.day > end) continue;
    if (useCost) {
      if (e.cost === null) continue;
      a.n++;
      a.rev += e.revenue;
      a.cost += e.cost;
    } else {
      a.n++;
      a.rev += e.revenue;
    }
  }
  return a;
}

function periodRange(today: string, period: Period) {
  switch (period) {
    case "today":
      return { start: today, end: today, single: true, label: "today", compareLabel: "your usual same weekday" };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y, single: true, label: "yesterday", compareLabel: "your usual same weekday" };
    }
    case "this_week": {
      const start = mondayOf(today);
      return {
        start,
        end: today,
        single: false,
        cmpStart: addDays(start, -7),
        cmpEnd: addDays(today, -7),
        label: "this week so far",
        compareLabel: "the same days last week",
      };
    }
    case "last_week": {
      const start = addDays(mondayOf(today), -7);
      const end = addDays(start, 6);
      return {
        start,
        end,
        single: false,
        cmpStart: addDays(start, -7),
        cmpEnd: addDays(end, -7),
        label: "last week",
        compareLabel: "the week before",
      };
    }
    case "this_month": {
      const start = `${today.slice(0, 8)}01`;
      const pStart = prevMonthStart(today);
      const elapsed = daysBetween(start, today);
      const pEnd = monthEnd(pStart);
      const cmpEnd = addDays(pStart, elapsed) > pEnd ? pEnd : addDays(pStart, elapsed);
      return {
        start,
        end: today,
        single: false,
        cmpStart: pStart,
        cmpEnd,
        label: "this month so far",
        compareLabel: "the same stretch of last month",
      };
    }
  }
}

function decompose(t: Agg, b: Agg) {
  const r1 = t.n ? t.rev / t.n : 0;
  const c1 = t.n ? t.cost / t.n : 0;
  const r0 = b.n ? b.rev / b.n : 0;
  const c0 = b.n ? b.cost / b.n : 0;
  // profit = n * (r - c)  =>  exact, additive decomposition:
  const volume = (t.n - b.n) * (r0 - c0);
  const price = t.n * (r1 - r0);
  const cost = -t.n * (c1 - c0);
  return { volume, price, cost };
}

export function profitDrivers(ctx: Ctx, period: Period) {
  const range = periodRange(ctx.today, period);
  const useCost = ctx.coverage.has_cost_data;
  const basis = useCost ? "profit" : "revenue";
  const t = aggregate(ctx, range.start, range.end, useCost);

  // ---- baseline ----------------------------------------------------
  let base: Agg | null = null;
  let baselineNote: string | null = null;
  if (range.single) {
    const dates = [7, 14, 21, 28].map((n) => addDays(range.start, -n));
    const per = dates.map((d) => aggregate(ctx, d, d, useCost));
    const active = per.filter((p) => p.n > 0).length;
    if (active >= 2) {
      base = { n: mean(per.map((p) => p.n)) ?? 0, rev: mean(per.map((p) => p.rev)) ?? 0, cost: mean(per.map((p) => p.cost)) ?? 0 };
    } else {
      const days: Agg[] = [];
      for (let i = 1; i <= 14; i++) {
        const d = addDays(range.start, -i);
        const a = aggregate(ctx, d, d, useCost);
        if (a.n > 0) days.push(a);
      }
      if (days.length) {
        base = { n: mean(days.map((p) => p.n)) ?? 0, rev: mean(days.map((p) => p.rev)) ?? 0, cost: mean(days.map((p) => p.cost)) ?? 0 };
        baselineNote = "This weekday has little history, so the comparison uses your average active day from the previous two weeks.";
      }
    }
  } else if ("cmpStart" in range && range.cmpStart && range.cmpEnd) {
    base = aggregate(ctx, range.cmpStart, range.cmpEnd, useCost);
    if (base.n === 0) base = null;
  }

  // ---- flags & contributors (target range) -------------------------
  const inRange = (e: EnrichedJob) => e.day >= range.start && e.day <= range.end;
  const doneInRange = ctx.completed.filter(inRange);
  const cancelled = ctx.ej.filter((e) => e.job.job_status === "cancelled" && inRange(e));
  const costedDone = doneInRange.filter((e) => e.profit !== null);
  const worst = [...(useCost ? costedDone : doneInRange)]
    .sort((a, b) => (useCost ? (a.profit as number) - (b.profit as number) : a.revenue - b.revenue))
    .slice(0, 3)
    .map((e) => ({
      customer: safeText(e.job.customer_name, 40),
      service: safeText(e.job.service_type ?? "Unspecified", 40),
      technician: techName(ctx, e.job.assigned_technician_id),
      revenue: round(e.revenue),
      cost: e.cost === null ? null : round(e.cost),
      profit: e.profit === null ? null : round(e.profit),
      margin_pct: e.profit !== null && e.revenue > 0 ? round((e.profit / e.revenue) * 100, 1) : null,
      rework: !!e.job.is_rework,
    }));

  const byTech = new Map<string, { jobs: number; revenue: number; profit: number; costed: number }>();
  for (const e of doneInRange) {
    const name = techName(ctx, e.job.assigned_technician_id);
    const g = byTech.get(name) ?? { jobs: 0, revenue: 0, profit: 0, costed: 0 };
    g.jobs++;
    g.revenue += e.revenue;
    if (e.profit !== null) {
      g.profit += e.profit;
      g.costed++;
    }
    byTech.set(name, g);
  }

  const profit = (a: Agg) => a.rev - a.cost;
  const target = {
    jobs: t.n,
    revenue: round(t.rev),
    cost: useCost ? round(t.cost) : null,
    profit: useCost ? round(profit(t)) : null,
    margin_pct: useCost && t.rev > 0 ? round((profit(t) / t.rev) * 100, 1) : null,
  };

  let comparison = null as null | {
    jobs: number;
    revenue: number;
    cost: number | null;
    profit: number | null;
    margin_pct: number | null;
  };
  let change = null as null | { amount_usd: number; pct: number | null };
  let drivers = null as null | { volume_effect: number; price_mix_effect: number; cost_effect: number; primary_driver: string };

  if (base) {
    comparison = {
      jobs: round(base.n, 1),
      revenue: round(base.rev),
      cost: useCost ? round(base.cost) : null,
      profit: useCost ? round(profit(base)) : null,
      margin_pct: useCost && base.rev > 0 ? round((profit(base) / base.rev) * 100, 1) : null,
    };
    const metricT = useCost ? profit(t) : t.rev;
    const metricB = useCost ? profit(base) : base.rev;
    change = { amount_usd: round(metricT - metricB), pct: metricB !== 0 ? round(((metricT - metricB) / Math.abs(metricB)) * 100, 1) : null };
    const d = decompose(t, base);
    const entries: [string, number][] = [
      ["job_volume", d.volume],
      ["price_and_job_mix", d.price],
    ];
    if (useCost) entries.push(["job_cost", d.cost]);
    const primary = [...entries].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0][0];
    drivers = {
      volume_effect: round(d.volume),
      price_mix_effect: round(d.price),
      cost_effect: useCost ? round(d.cost) : 0,
      primary_driver: primary,
    };
  }

  return {
    period: range.label,
    compared_with: range.compareLabel,
    basis,
    target,
    comparison,
    change,
    drivers,
    flags: {
      rework_jobs: doneInRange.filter((e) => e.job.is_rework).length,
      cancelled_jobs: cancelled.length,
      cancelled_value: round(sum(cancelled.map((e) => Number(e.job.invoice_amount ?? 0)))),
      completed_without_cost_data: doneInRange.length - costedDone.length,
      loss_making_jobs: costedDone.filter((e) => (e.profit as number) < 0).length,
    },
    worst_jobs: worst,
    by_technician: [...byTech.entries()]
      .map(([technician, g]) => ({
        technician,
        jobs: g.jobs,
        revenue: round(g.revenue),
        profit: g.costed ? round(g.profit) : null,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5),
    notes: [
      ...(baselineNote ? [baselineNote] : []),
      ...(!useCost ? ["Job cost data is missing or too sparse, so this is a REVENUE comparison, not profit."] : []),
      ...(useCost && t.n === 0 && doneInRange.length > 0
        ? [`${doneInRange.length} job(s) completed in this period have no cost entries yet, so profit is UNDERSTATED rather than truly lower.`]
        : []),
      ...(!base ? ["No comparable history was found for this period."] : []),
    ],
  };
}

// =====================================================================
// 2) Where am I losing money?
// =====================================================================

export function moneyLeaks(ctx: Ctx) {
  const { raw, today } = ctx;
  const since30 = addDays(today, -30);
  const since90 = addDays(today, -90);
  const done30 = ctx.completed.filter((e) => e.day >= since30);
  const costed30 = done30.filter((e) => e.profit !== null);
  const ticket = avgTicket(ctx, null, 60);
  const leaks: Leak[] = [];
  const ex = (e: EnrichedJob, extra?: string) =>
    `${safeText(e.job.customer_name, 28)} — ${safeText(e.job.service_type ?? "job", 28)}${extra ? ` (${extra})` : ""}`;

  if (ctx.coverage.has_cost_data) {
    const losers = costed30.filter((e) => (e.profit as number) < 0).sort((a, b) => (a.profit as number) - (b.profit as number));
    if (losers.length) {
      leaks.push({
        kind: "loss_making_jobs",
        label: "Jobs that lost money (cost exceeded price)",
        amount: round(sum(losers.map((e) => -(e.profit as number)))),
        basis: "measured",
        count: losers.length,
        examples: losers.slice(0, 3).map((e) => ex(e, usd(e.profit as number))),
      });
    }
    const thin = costed30.filter((e) => (e.profit as number) >= 0 && e.revenue > 0 && (e.profit as number) / e.revenue < 0.15);
    const shortfall = sum(thin.map((e) => Math.max(0, 0.2 * e.revenue - (e.profit as number))));
    if (thin.length && shortfall > 0) {
      leaks.push({
        kind: "thin_margin_jobs",
        label: "Jobs under 15% margin (shortfall vs a 20% margin reference)",
        amount: round(shortfall),
        basis: "estimated",
        count: thin.length,
        examples: thin.slice(0, 3).map((e) => ex(e, `${round(((e.profit as number) / e.revenue) * 100, 1)}%`)),
      });
    }
  }

  const rework = done30.filter((e) => e.job.is_rework);
  if (rework.length) {
    const costed = rework.filter((e) => e.cost !== null);
    leaks.push({
      kind: "rework",
      label: "Rework visits (a second trip for the same problem)",
      amount: round(sum(costed.map((e) => e.cost as number))),
      basis: "measured",
      count: rework.length,
      examples: rework.slice(0, 3).map((e) => ex(e)),
    });
  }

  const unbilled = ctx.completed.filter(
    (e) => e.day >= since90 && e.job.invoice_status === "not_sent" && Number(e.job.invoice_amount ?? 0) > 0,
  );
  if (unbilled.length) {
    leaks.push({
      kind: "unbilled_completed_jobs",
      label: "Completed jobs never invoiced",
      amount: round(sum(unbilled.map((e) => Number(e.job.invoice_amount)))),
      basis: "measured",
      count: unbilled.length,
      examples: unbilled.slice(0, 3).map((e) => ex(e, usd(Number(e.job.invoice_amount)))),
    });
  }

  const overdueInv = raw.invoices.filter((i) => ["sent", "viewed"].includes(i.status) && i.due_date && i.due_date < today);
  if (overdueInv.length) {
    leaks.push({
      kind: "overdue_invoices",
      label: "Overdue invoices (cash not collected)",
      amount: round(sum(overdueInv.map((i) => lineItemsTotalDollars(i.line_items, i.tax_percent)))),
      basis: "measured",
      count: overdueInv.length,
      examples: overdueInv.slice(0, 3).map((i) => `${safeText(i.customer_name, 28)} (due ${prettyDay(i.due_date as string)})`),
    });
  } else if (!raw.invoices.length) {
    const sentOld = ctx.completed.filter(
      (e) => e.job.invoice_status === "sent" && daysBetween(e.day, today) >= 14 && Number(e.job.invoice_amount ?? 0) > 0,
    );
    if (sentOld.length) {
      leaks.push({
        kind: "overdue_invoices",
        label: "Invoices sent 14+ days ago and still unpaid",
        amount: round(sum(sentOld.map((e) => Number(e.job.invoice_amount)))),
        basis: "measured",
        count: sentOld.length,
        examples: sentOld.slice(0, 3).map((e) => ex(e)),
      });
    }
  }

  const cancelled = ctx.ej.filter((e) => e.job.job_status === "cancelled" && e.day >= since30 && e.day <= today);
  if (cancelled.length) {
    const quoted = sum(cancelled.map((e) => Number(e.job.invoice_amount ?? 0)));
    const usedAvg = quoted === 0 && ticket !== null;
    leaks.push({
      kind: "cancelled_jobs",
      label: "Cancelled jobs (lost revenue)",
      amount: round(usedAvg ? cancelled.length * (ticket as number) : quoted),
      basis: usedAvg ? "estimated" : "measured",
      count: cancelled.length,
      examples: cancelled.slice(0, 3).map((e) => ex(e)),
    });
  }

  const calls30 = raw.calls.filter((c) => c.call_datetime >= new Date(raw.now.getTime() - 30 * 86400000).toISOString());
  const nonSpam = calls30.filter((c) => c.status !== "spam");
  const missed = nonSpam.filter((c) => c.status === "missed");
  if (nonSpam.length >= 10 && missed.length && ticket !== null) {
    const bookRate = nonSpam.filter((c) => c.status === "booked").length / nonSpam.length;
    leaks.push({
      kind: "missed_calls",
      label: "Missed calls that would likely have booked",
      amount: round(missed.length * bookRate * ticket),
      basis: "estimated",
      count: missed.length,
      examples: [`${missed.length} missed of ${nonSpam.length} calls; ${round(bookRate * 100, 0)}% of calls normally book`],
    });
  }

  const staleQuotes = raw.quotes.filter((q) => {
    if (q.status !== "sent") return false;
    const age = ageDays(q.sent_at ?? q.created_at, raw.now);
    return age !== null && age >= 7 && (!q.valid_until || q.valid_until >= today);
  });
  if (staleQuotes.length) {
    leaks.push({
      kind: "stalled_quotes",
      label: "Quotes unanswered for 7+ days (value still open)",
      amount: round(sum(staleQuotes.map((q) => lineItemsTotalDollars(q.line_items, q.tax_percent)))),
      basis: "measured",
      count: staleQuotes.length,
      examples: staleQuotes.slice(0, 3).map((q) => `${safeText(q.customer_name, 28)} (${usd(lineItemsTotalDollars(q.line_items, q.tax_percent))})`),
    });
  }

  leaks.sort((a, b) => b.amount - a.amount);
  return {
    window: "last 30 days (unbilled work: last 90 days)",
    leaks: leaks.slice(0, 7),
    total_measured: round(sum(leaks.filter((l) => l.basis === "measured").map((l) => l.amount))),
    total_estimated: round(sum(leaks.filter((l) => l.basis === "estimated").map((l) => l.amount))),
    note: "Measured = taken straight from your records. Estimated = derived with a stated rule and should be treated as a range, not a fact. Categories are not additive when the same job appears in two of them.",
  };
}

// =====================================================================
// 3) Which technician should handle this job?
// =====================================================================

function techStats(ctx: Ctx, techId: string) {
  const since = addDays(ctx.today, -90);
  const mine = ctx.completed.filter((e) => e.job.assigned_technician_id === techId && e.day >= since);
  const costed = mine.filter((e) => e.profit !== null);
  const rev = sum(costed.map((e) => e.revenue));
  return {
    jobs: mine,
    reworkRate: mine.length ? mine.filter((e) => e.job.is_rework).length / mine.length : 0,
    marginPct: costed.length >= 3 && rev > 0 ? (sum(costed.map((e) => e.profit as number)) / rev) * 100 : null,
  };
}

function overlaps(a: JobRow, b: JobRow): boolean {
  if (!a.scheduled_datetime || !b.scheduled_datetime) return false;
  const aS = new Date(a.scheduled_datetime).getTime();
  const bS = new Date(b.scheduled_datetime).getTime();
  const aE = aS + jobDurationMinutes(a) * 60000;
  const bE = bS + jobDurationMinutes(b) * 60000;
  return aS < bE && bS < aE;
}

export function technicianFit(ctx: Ctx, plan: QuestionPlan) {
  const { raw, today } = ctx;
  const nowMs = raw.now.getTime();
  const upcoming = ctx.ej
    .filter(
      (e) =>
        e.job.job_status === "scheduled" &&
        !e.job.assigned_technician_id &&
        e.job.scheduled_datetime &&
        new Date(e.job.scheduled_datetime).getTime() >= nowMs - 3600000,
    )
    .sort((a, b) => (a.job.scheduled_datetime as string).localeCompare(b.job.scheduled_datetime as string));

  // Job named in the question? (customer name match), else trade match, else the soonest unassigned jobs.
  const named = upcoming.filter((e) => {
    const n = e.job.customer_name.toLowerCase().trim();
    return n.length >= 4 && plan.normalized.includes(n);
  });
  const tradeMatch = plan.trade ? upcoming.filter((e) => e.trade === plan.trade) : [];
  const targets = (named.length ? named : tradeMatch.length ? tradeMatch : upcoming).slice(0, 3);
  const techs = activeTechs(ctx);

  if (!techs.length) {
    return { jobs: [], note: "No dispatch-enabled technicians are configured, so there is nobody to rank." };
  }

  const teamMargins = techs.map((t) => techStats(ctx, t.id).marginPct).filter((m): m is number => m !== null);
  const teamMargin = mean(teamMargins);

  const rank = (job: EnrichedJob | null, trade: string | null) => {
    const jobDay = job ? job.day : today;
    const ranking = techs.map((t) => {
      const st = techStats(ctx, t.id);
      const sameTrade = trade ? st.jobs.filter((e) => e.trade === trade).length : st.jobs.length;
      const skillHit = !!trade && (t.skills ?? []).some((s) => tradeOf(s) === trade || s.toLowerCase().includes(trade));
      const experience = Math.max(Math.min(1, sameTrade / 8), skillHit ? 0.5 : 0);
      const quality = 1 - Math.min(1, st.reworkRate * 3);
      const profitability =
        st.marginPct !== null && teamMargin !== null ? Math.max(0, Math.min(1, 0.5 + (st.marginPct - teamMargin) / 40)) : 0.5;
      const dayJobs = ctx.ej.filter(
        (e) => e.job.assigned_technician_id === t.id && e.day === jobDay && e.job.job_status !== "cancelled",
      );
      const cap = maxJobsPerDay(t);
      const conflict = !!job && dayJobs.some((e) => overlaps(e.job, job.job));
      const availability = conflict ? 0 : Math.max(0, 1 - dayJobs.length / cap);
      const score = round((0.35 * experience + 0.25 * quality + 0.15 * profitability + 0.25 * availability) * 100);
      const reasons: string[] = [];
      if (sameTrade > 0) reasons.push(`${sameTrade} ${trade ?? "completed"} job${sameTrade === 1 ? "" : "s"} in the last 90 days`);
      else reasons.push("no completed jobs of this type in the last 90 days");
      if (skillHit) reasons.push("has a matching skill tag");
      reasons.push(`${round(st.reworkRate * 100, 0)}% rework rate`);
      if (st.marginPct !== null) reasons.push(`${round(st.marginPct, 1)}% average margin`);
      reasons.push(conflict ? "already booked at that time" : `${dayJobs.length} of ${cap} slots used that day`);
      return {
        technician: techName(ctx, t.id),
        score: conflict ? Math.min(score, 20) : score,
        same_type_jobs_90d: sameTrade,
        rework_rate_pct: round(st.reworkRate * 100, 1),
        avg_margin_pct: st.marginPct === null ? null : round(st.marginPct, 1),
        slots_used_that_day: `${dayJobs.length}/${cap}`,
        time_conflict: conflict,
        reasons,
      };
    });
    return ranking.sort((a, b) => b.score - a.score).slice(0, 3);
  };

  if (!targets.length) {
    return {
      jobs: [],
      general_ranking_for: plan.trade ?? "all work",
      ranking: rank(null, plan.trade),
      note: "There are no unassigned upcoming jobs right now. This is a general ranking for the trade named in the question.",
    };
  }

  return {
    jobs: targets.map((e) => ({
      customer: safeText(e.job.customer_name, 40),
      service: safeText(e.job.service_type ?? "Unspecified", 40),
      scheduled_day: prettyDay(e.day),
      ranking: rank(e, e.trade === "other" ? null : e.trade),
    })),
    note: "Travel distance and live GPS position are not part of this score.",
  };
}

// =====================================================================
// 4) Which customers should we contact today?
// =====================================================================

export function customerOutreach(ctx: Ctx) {
  const { raw, today } = ctx;
  const ticket = avgTicket(ctx, null, 90) ?? 0;
  const decided = raw.leads.filter((l) => ["won", "lost"].includes(l.stage));
  const winRate = decided.length >= 10 ? decided.filter((l) => l.stage === "won").length / decided.length : 0.3;
  const out: (Candidate & { weight: number })[] = [];

  for (const q of raw.quotes) {
    if (q.status !== "sent") continue;
    const age = ageDays(q.sent_at ?? q.created_at, raw.now);
    if (age === null || age < 3 || (q.valid_until && q.valid_until < today)) continue;
    const value = lineItemsTotalDollars(q.line_items, q.tax_percent);
    out.push({
      who: safeText(q.customer_name, 40),
      reason: `Quote for ${usd(value)} sent ${Math.floor(age)} days ago with no answer`,
      value: round(value),
      action: "Call to answer questions and ask for the decision",
      weight: age <= 10 ? 1.2 : 0.9,
    });
  }

  for (const l of raw.leads) {
    if (l.stage !== "new") continue;
    const age = ageDays(l.created_at, raw.now);
    if (age === null || age < 1 || age > 60) continue;
    out.push({
      who: safeText(l.name, 40),
      reason: `New lead${l.service_interested ? ` for ${safeText(l.service_interested, 30)}` : ""} waiting ${Math.floor(age)} days, never contacted`,
      value: round(ticket * winRate),
      action: "Call now; speed to first contact decides most home-service leads",
      weight: age <= 3 ? 1.3 : 0.8,
    });
  }

  for (const i of raw.invoices) {
    if (!["sent", "viewed"].includes(i.status) || !i.due_date || i.due_date >= today) continue;
    const value = lineItemsTotalDollars(i.line_items, i.tax_percent);
    out.push({
      who: safeText(i.customer_name, 40),
      reason: `Invoice for ${usd(value)} was due ${prettyDay(i.due_date)}`,
      value: round(value),
      action: "Send a payment reminder or call to collect",
      weight: 1.1,
    });
  }

  for (const e of ctx.completed) {
    const due = e.job.next_maintenance_date;
    if (!due || due < addDays(today, -30) || due > addDays(today, 14)) continue;
    out.push({
      who: safeText(e.job.customer_name, 40),
      reason: `Maintenance visit ${due < today ? "was due" : "is due"} ${prettyDay(due)}`,
      value: round((avgTicket(ctx, e.trade === "other" ? null : e.trade, 90) ?? ticket) * 0.6),
      action: "Offer to book the maintenance visit",
      weight: 0.9,
    });
  }

  // Lapsed high-value customers (top quartile lifetime revenue, silent 180+ days).
  const byCustomer = new Map<string, { name: string; revenue: number; last: string; jobs: number }>();
  for (const e of ctx.completed) {
    const key = e.job.customer_id ?? e.job.customer_name.toLowerCase();
    const g = byCustomer.get(key) ?? { name: e.job.customer_name, revenue: 0, last: "", jobs: 0 };
    g.revenue += e.revenue;
    g.jobs++;
    if (e.day > g.last) g.last = e.day;
    byCustomer.set(key, g);
  }
  const revs = [...byCustomer.values()].map((c) => c.revenue).sort((a, b) => a - b);
  const q75 = revs.length >= 8 ? revs[Math.floor(revs.length * 0.75)] : Infinity;
  const recentlyContacted = new Set(
    raw.customers
      .filter((c) => c.last_contacted_at && (ageDays(c.last_contacted_at, raw.now) ?? 999) < 60)
      .map((c) => c.name.toLowerCase()),
  );
  for (const c of byCustomer.values()) {
    if (c.revenue < q75 || c.jobs < 2 || daysBetween(c.last, today) < 180) continue;
    if (recentlyContacted.has(c.name.toLowerCase())) continue;
    out.push({
      who: safeText(c.name, 40),
      reason: `Top-quartile customer (${usd(c.revenue)} lifetime) not served since ${prettyDay(c.last)}`,
      value: round(c.revenue / c.jobs),
      action: "Personal check-in with a service-plan or maintenance offer",
      weight: 0.7,
    });
  }

  const seen = new Set<string>();
  const ranked = out
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .filter((c) => {
      const k = c.who.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8)
    .map(({ weight: _w, ...rest }) => rest);

  return {
    candidates: ranked,
    total_value: round(sum(ranked.map((c) => c.value))),
    note: "Value is the quote/invoice amount where one exists; for leads and maintenance it is an expected value (average ticket x your historical win rate or a 60% rebooking factor).",
  };
}

// =====================================================================
// 5) Capacity what-if: "Can we accept N more <trade> jobs this week?"
// =====================================================================

export function capacityWhatIf(ctx: Ctx, plan: QuestionPlan) {
  const { raw, today } = ctx;
  const all = activeTechs(ctx);
  const trade = plan.trade;
  const notes: string[] = [];

  let techs = all;
  if (trade) {
    const skilled = all.filter((t) => (t.skills ?? []).some((s) => tradeOf(s) === trade || s.toLowerCase().includes(trade)));
    if (skilled.length) techs = skilled;
    else if (all.some((t) => (t.skills ?? []).length)) notes.push(`No technician has a "${trade}" skill tag, so all technicians were counted.`);
    else notes.push("Technician skills are not configured, so all technicians were counted.");
  }
  if (!techs.length) {
    return { verdict: "info", notes: ["No dispatch-enabled technicians are configured, so capacity cannot be computed."] };
  }

  const windowDays = 7;
  const end = addDays(today, windowDays - 1);
  const workdays = workdaysIn(ctx, today, windowDays);
  const techIds = new Set(techs.map((t) => t.id));
  const inScope = (e: EnrichedJob) =>
    !trade || e.trade === trade || (!!e.job.assigned_technician_id && techIds.has(e.job.assigned_technician_id));
  const booked = ctx.ej.filter(
    (e) => e.job.job_status !== "cancelled" && e.job.job_status !== "completed" && e.day >= today && e.day <= end && inScope(e),
  );
  // Work already finished today still consumed today's capacity.
  const doneToday = ctx.ej.filter((e) => e.job.job_status === "completed" && e.day === today && inScope(e));
  const bookedCount = booked.length + doneToday.length;

  const capacityJobs = sum(techs.map((t) => maxJobsPerDay(t))) * workdays;
  const capacityHours = techs.length * WORKDAY_HOURS * workdays;
  const hrsPerJob =
    (mean(ctx.completed.filter((e) => (!trade || e.trade === trade) && e.day >= addDays(today, -90)).map((e) => jobDurationMinutes(e.job))) ??
      60) / 60;
  const bookedHours = sum([...booked, ...doneToday].map((e) => jobDurationMinutes(e.job))) / 60;

  const freeByJobs = Math.max(0, capacityJobs - bookedCount);
  const freeByHours = Math.max(0, Math.floor((capacityHours - bookedHours) / hrsPerJob));
  const supported = Math.min(freeByJobs, freeByHours);
  const reserve = Math.max(1, Math.round(capacityJobs * 0.1));
  const usable = Math.max(0, supported - reserve);
  const requested = plan.extraJobs;

  let verdict: "yes" | "no" | "conditional" | "info" = "info";
  if (requested !== null) verdict = requested <= usable ? "yes" : requested <= supported ? "conditional" : "no";

  const ticket = avgTicket(ctx, trade, 60);
  const profitPerJob = avgProfit(ctx, trade, 90);
  const shortfall = requested !== null ? Math.max(0, requested - supported) : 0;
  const perTechWindow = (capacityJobs / techs.length) || 1;

  return {
    window: `${prettyDay(today)} – ${prettyDay(end)}`,
    workdays_in_window: workdays,
    trade: trade === "hvac" ? "HVAC" : (trade ?? "all work"),
    technicians_counted: techs.length,
    capacity_jobs: capacityJobs,
    already_booked_jobs: bookedCount,
    utilization_pct: capacityJobs > 0 ? round((bookedCount / capacityJobs) * 100, 1) : null,
    free_jobs_by_slots: freeByJobs,
    free_jobs_by_hours: freeByHours,
    binding_constraint: freeByHours < freeByJobs ? "technician hours" : "job slots",
    avg_hours_per_job: round(hrsPerJob, 1),
    supported_extra_jobs: supported,
    emergency_reserve_jobs: reserve,
    comfortably_acceptable_jobs: usable,
    requested_extra_jobs: requested,
    verdict,
    shortfall_jobs: shortfall,
    technicians_needed_for_shortfall: shortfall > 0 ? Math.ceil(shortfall / perTechWindow) : 0,
    extra_revenue_if_accepted: requested !== null && ticket !== null ? round(requested * ticket) : null,
    extra_profit_if_accepted: requested !== null && profitPerJob !== null ? round(requested * profitPerJob) : null,
    avg_ticket: ticket === null ? null : round(ticket),
    avg_profit_per_job: profitPerJob === null ? null : round(profitPerJob),
    notes: [
      ...notes,
      "A 10% emergency reserve is held back; 'conditional' means the jobs fit only if you spend that reserve.",
    ],
  };
}

// =====================================================================
// 6) Hiring what-if: "What happens if I hire another technician?"
// =====================================================================

export function hiringWhatIf(ctx: Ctx, plan: QuestionPlan) {
  const { today } = ctx;
  const techs = activeTechs(ctx);
  if (!techs.length) return { note: "No dispatch-enabled technicians are configured, so there is no baseline to compare against." };

  const avgMax = mean(techs.map((t) => maxJobsPerDay(t))) ?? DEFAULT_MAX_JOBS_PER_DAY;
  const wdPerWeek = workWeekdays(ctx).size;
  const weeklyCap = techs.length * avgMax * wdPerWeek;
  const since28 = addDays(today, -28);
  const jobsPerWeek = ctx.completed.filter((e) => e.day >= since28 && e.day < today).length / 4;
  const utilization = weeklyCap > 0 ? jobsPerWeek / weeklyCap : 0;

  const nextWeek = capacityWhatIf(ctx, { ...plan, trade: null, extraJobs: null });
  const nextWeekUtil = "utilization_pct" in nextWeek && typeof nextWeek.utilization_pct === "number" ? nextWeek.utilization_pct : null;

  const pressure = utilization >= 0.85 || (nextWeekUtil !== null && nextWeekUtil >= 90) ? "high" : utilization >= 0.7 ? "moderate" : "low";
  const fill = { high: [0.25, 0.6, 0.85], moderate: [0.1, 0.3, 0.6], low: [0, 0.1, 0.3] }[pressure];
  const newWeeklyCap = avgMax * wdPerWeek * plan.hires;
  const ticket = avgTicket(ctx, null, 60);
  const profitPerJob = avgProfit(ctx, null, 90);
  const scenario = (name: string, f: number) => {
    const jobs = newWeeklyCap * f;
    return {
      case: name,
      extra_jobs_per_week: round(jobs, 1),
      extra_revenue_per_week: ticket === null ? null : round(jobs * ticket),
      extra_gross_profit_per_week: profitPerJob === null ? null : round(jobs * profitPerJob),
    };
  };

  return {
    hires_modelled: plan.hires,
    current: {
      technicians: techs.length,
      weekly_job_capacity: round(weeklyCap),
      completed_jobs_per_week_last_4_weeks: round(jobsPerWeek, 1),
      utilization_pct: round(utilization * 100, 1),
      next_7_days_utilization_pct: nextWeekUtil,
    },
    demand_pressure: pressure,
    added_weekly_capacity_jobs: round(newWeeklyCap),
    scenarios: [scenario("conservative", fill[0]), scenario("base", fill[1]), scenario("optimistic", fill[2])],
    avg_ticket: ticket === null ? null : round(ticket),
    avg_gross_profit_per_job: profitPerJob === null ? null : round(profitPerJob),
    break_even_note:
      "Break-even jobs per week = the new technician's weekly cost divided by avg_gross_profit_per_job. The weekly cost is not in the data, so it is left for the owner to supply.",
    assumptions: [
      "Fill rate (share of the new capacity that turns into extra completed jobs) is a stated assumption driven by current utilization, not a measurement.",
      "Hiring cannot create demand: when utilization is low, extra capacity mostly sits idle.",
    ],
  };
}

// =====================================================================
// 7) What should I change?  (ranked, impact-quantified)
// =====================================================================

export interface Recommendation {
  title: string;
  why: string;
  est_impact_usd: number;
  effort: "low" | "medium" | "high";
  basis: "measured" | "estimated";
}

export function recommendations(ctx: Ctx, leaks: ReturnType<typeof moneyLeaks>): Recommendation[] {
  const recs: Recommendation[] = [];
  const actionFor: Record<string, [string, "low" | "medium" | "high"]> = {
    loss_making_jobs: ["Stop underpricing: add a price floor and review the loss-making jobs", "medium"],
    thin_margin_jobs: ["Raise prices or tighten scope on the thin-margin services", "medium"],
    rework: ["Cut rework: add a pre-departure diagnosis/parts check and coach the repeat offenders", "medium"],
    unbilled_completed_jobs: ["Invoice every completed job within 24 hours (automate the invoice on completion)", "low"],
    overdue_invoices: ["Collect overdue invoices: automated reminders at 3, 7 and 14 days", "low"],
    cancelled_jobs: ["Reduce cancellations: confirmation texts and a rebooking offer", "low"],
    missed_calls: ["Recover missed calls: callback automation within 5 minutes", "low"],
    stalled_quotes: ["Follow up every quote at day 2 and day 5", "low"],
  };
  for (const l of leaks.leaks) {
    const a = actionFor[l.kind];
    if (!a || l.amount <= 0) continue;
    recs.push({ title: a[0], why: `${l.label}: ${usd(l.amount)} across ${l.count} item${l.count === 1 ? "" : "s"}.`, est_impact_usd: l.amount, effort: a[1], basis: l.basis });
  }

  const lines = serviceLines(ctx, 90, 8).filter((s) => s.jobs >= 5 && s.margin_pct !== null);
  const worst = [...lines].sort((a, b) => (a.margin_pct as number) - (b.margin_pct as number))[0];
  const portfolio = lines.length ? median(lines.map((l) => l.margin_pct as number)) : null;
  if (worst && portfolio !== null && (worst.margin_pct as number) < portfolio - 8) {
    const lift = ((portfolio - (worst.margin_pct as number)) / 100) * worst.revenue;
    recs.push({
      title: `Reprice or restructure "${worst.service}"`,
      why: `Its margin is ${worst.margin_pct}% against a median of ${round(portfolio, 1)}% across your services (${worst.jobs} jobs, ${usd(worst.revenue)} revenue).`,
      est_impact_usd: round(lift),
      effort: "medium",
      basis: "estimated",
    });
  }

  return recs.sort((a, b) => b.est_impact_usd - a.est_impact_usd).slice(0, 5);
}
