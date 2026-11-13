/**
 * Landscaping pack — crew productivity metrics (pure).
 *
 * Honest by construction: a visit without both a start and a completion time contributes to counts but
 * never to time-based ratios, and is counted in `missingTimeData` so a dashboard can say how much of the
 * picture is measured rather than guessed. Divisions by zero return null, never 0 or Infinity.
 */

import type { VisitRow } from './types.ts';

export interface CrewMetrics {
  crewId: string | null;
  scheduled: number;
  completed: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  /** completed ÷ (completed + skipped-for-weather-or-crew + still open past due is NOT counted) — see completionRate(). */
  completionRate: number | null;
  plannedMinutes: number;
  actualMinutes: number;
  /** plannedMinutes ÷ actualMinutes over visits with both times; >1 means faster than planned. */
  efficiency: number | null;
  /** Share of started visits that began within `graceMinutes` of their scheduled time. */
  onTimeRate: number | null;
  revenueCents: number;
  /** Labor hours = actual minutes × crew size ÷ 60. */
  laborHours: number;
  revenuePerLaborHourCents: number | null;
  tasksTotal: number;
  tasksDone: number;
  taskCompletionRate: number | null;
  missingTimeData: number;
}

export interface MetricsOptions {
  /** Inclusive range on visit_date. */
  from: string;
  to: string;
  graceMinutes?: number;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

function empty(crewId: string | null): CrewMetrics {
  return {
    crewId,
    scheduled: 0,
    completed: 0,
    skipped: 0,
    skippedByReason: {},
    completionRate: null,
    plannedMinutes: 0,
    actualMinutes: 0,
    efficiency: null,
    onTimeRate: null,
    revenueCents: 0,
    laborHours: 0,
    revenuePerLaborHourCents: null,
    tasksTotal: 0,
    tasksDone: 0,
    taskCompletionRate: null,
    missingTimeData: 0,
  };
}

/** Completion rate = completed ÷ (completed + skipped). Cancelled visits and open future visits are outside the denominator. */
export function summarizeCrewProductivity(visits: readonly VisitRow[], opts: MetricsOptions): CrewMetrics[] {
  const grace = opts.graceMinutes ?? 15;
  const by = new Map<string, CrewMetrics>();
  const timed = new Map<string, { planned: number; actual: number; started: number; onTime: number }>();

  for (const v of visits) {
    if (v.visit_date < opts.from || v.visit_date > opts.to || v.status === 'cancelled') continue;
    const k = v.crew_id ?? '__none__';
    const m = by.get(k) ?? empty(v.crew_id);
    const t = timed.get(k) ?? { planned: 0, actual: 0, started: 0, onTime: 0 };
    by.set(k, m);
    timed.set(k, t);

    m.scheduled += 1;
    if (v.status === 'skipped') {
      m.skipped += 1;
      const r = v.skip_reason ?? 'manual';
      m.skippedByReason[r] = (m.skippedByReason[r] ?? 0) + 1;
    }
    if (v.status !== 'completed') continue;

    m.completed += 1;
    m.revenueCents += v.price_cents;
    m.tasksTotal += v.tasks_total;
    m.tasksDone += v.tasks_done;
    m.plannedMinutes += v.planned_minutes;

    if (v.started_at && v.completed_at && Date.parse(v.completed_at) >= Date.parse(v.started_at)) {
      const actual = minutesBetween(v.started_at, v.completed_at);
      m.actualMinutes += actual;
      t.planned += v.planned_minutes;
      t.actual += actual;
      m.laborHours += (actual * Math.max(1, v.crew_size)) / 60;
      t.started += 1;
      if (minutesBetween(v.scheduled_at, v.started_at) <= grace) t.onTime += 1;
    } else {
      m.missingTimeData += 1;
    }
  }

  const rows = [...by.entries()].map(([k, m]) => {
    const t = timed.get(k) as { planned: number; actual: number; started: number; onTime: number };
    m.actualMinutes = Math.round(m.actualMinutes);
    m.laborHours = Math.round(m.laborHours * 100) / 100;
    m.completionRate = ratio(m.completed, m.completed + m.skipped);
    m.efficiency = ratio(t.planned, t.actual);
    m.onTimeRate = ratio(t.onTime, t.started);
    m.revenuePerLaborHourCents = m.laborHours > 0 ? Math.round(m.revenueCents / m.laborHours) : null;
    m.taskCompletionRate = ratio(m.tasksDone, m.tasksTotal);
    return m;
  });
  // Stable order: by crew id, unassigned last.
  return rows.sort((a, b) => (a.crewId === null ? 1 : b.crewId === null ? -1 : a.crewId < b.crewId ? -1 : 1));
}

export function totals(rows: readonly CrewMetrics[]): Pick<CrewMetrics, 'scheduled' | 'completed' | 'skipped' | 'revenueCents' | 'laborHours'> {
  return rows.reduce(
    (a, r) => ({ scheduled: a.scheduled + r.scheduled, completed: a.completed + r.completed, skipped: a.skipped + r.skipped, revenueCents: a.revenueCents + r.revenueCents, laborHours: Math.round((a.laborHours + r.laborHours) * 100) / 100 }),
    { scheduled: 0, completed: 0, skipped: 0, revenueCents: 0, laborHours: 0 },
  );
}
