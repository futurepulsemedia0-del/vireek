// src/lib/hiddenTech/fixes.ts
//
// Auto-fix suggestions (always owner-approved, never automatic) and honest recovery measurement.
//
// Suggestions come from two ledgers computed by the same engine:
//   forecast = upcoming scheduled jobs (gaps that still exist and can be filled)
//   history  = the last 28 days (what keeps leaking)
// `estimatedHours` is a PLANNING figure built from the constants below — it is never reported as
// recovered. Recovered hours come only from `measureBaselineDelta` / `measureFillGap`, which compare
// real later job data with the baseline stored when the fix was suggested.

import { resolveInterval, sanitizeHtSettings, type DayPnL, type HtJob, type HtSettings, type LeakCause, type LeakResult, type LeakRow } from './leakEngine';

export type FixKind = 'fill_gap' | 'cluster_route' | 'stage_parts' | 'noshow_reminder' | 'paperwork_capture';
export type FixStatus = 'suggested' | 'approved' | 'dismissed' | 'measured' | 'expired';
export type MeasureMethod = 'direct_slot' | 'baseline_delta';

export const FIX_ASSUMPTIONS = {
  defaultJobMinutes: 60, // length assumed for a waitlist job (the waitlist table has no duration)
  slotBufferMinutes: 15, // extra room for travel/setup around an offered slot
  routeReduction: 0.25,
  partsReduction: 0.5,
  noShowReduction: 0.4,
  paperworkReduction: 0.3,
  minRouteDriveHours: 1.5,
  minCauseHours: 1.5, // history threshold before a pattern fix is suggested
  historyDays: 28,
  maxFillSuggestions: 25,
  minWorkdaysToMeasure: 5,
} as const;

export interface WaitlistEntry { id: string; customerName: string; serviceType: string | null; requestedDate: string; priority: number; createdAt: string }

export interface FixSuggestion {
  fingerprint: string;
  kind: FixKind;
  cause: LeakCause;
  technicianId: string | null;
  waitlistEntryId: string | null;
  targetDay: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  estimatedHours: number;
  baselineHoursPerDay: number | null;
  title: string;
  detail: Record<string, string | number>;
}

const MIN = 60_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();

/** Which ledger rows count as "this cause" when measuring a baseline-delta fix. */
export const MEASURE_SCOPE: Record<Exclude<FixKind, 'fill_gap'>, { causes: LeakCause[]; rules?: string[] }> = {
  cluster_route: { causes: ['drive'] },
  stage_parts: { causes: ['parts_run'] },
  noshow_reminder: { causes: ['no_show'] },
  paperwork_capture: { causes: ['paperwork'] }, // see note in measureBaselineDelta
};

export interface SuggestInput {
  forecast: LeakResult;
  history: LeakResult;
  waitlist: WaitlistEntry[];
  nowMs: number;
  settings?: Partial<HtSettings>;
}

export function suggestFixes(input: SuggestInput): FixSuggestion[] {
  const { forecast, history, waitlist, nowMs } = input;
  const A = FIX_ASSUMPTIONS;
  const month = iso(nowMs).slice(0, 7);
  const out: FixSuggestion[] = [];
  const jobMs = A.defaultJobMinutes * MIN;

  // 1) fill idle gaps in upcoming days with ready waitlist jobs (one entry per gap, one gap per entry)
  const entries = [...waitlist].sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const gaps = forecast.rows
    .filter((r) => r.cause === 'idle_gap' && r.startMs > nowMs && (r.rule === 'gap.idle' || r.rule === 'day.unscheduled_slack') && r.endMs - r.startMs >= jobMs + A.slotBufferMinutes * MIN)
    .sort((a, b) => a.startMs - b.startMs);
  const used = new Set<string>();
  for (const gap of gaps) {
    if (out.length >= A.maxFillSuggestions) break;
    const e = entries.find((x) => !used.has(x.id));
    if (!e) break;
    used.add(e.id);
    out.push({
      fingerprint: `fill_gap:${gap.day}:${gap.techId}:${e.id}`, kind: 'fill_gap', cause: 'idle_gap',
      technicianId: gap.techId, waitlistEntryId: e.id, targetDay: gap.day,
      windowStart: iso(gap.startMs), windowEnd: iso(gap.startMs + jobMs),
      estimatedHours: r2(jobMs / 3_600_000), baselineHoursPerDay: null,
      title: `Fill ${gap.techName}'s open slot on ${gap.day} with ${e.customerName}`,
      detail: { tech: gap.techName, day: gap.day, customer: e.customerName, service: e.serviceType ?? '', gapHours: r2(gap.hours) },
    });
  }

  // 2) cluster routes on upcoming days with heavy driving
  for (const d of forecast.days) {
    if (d.day < iso(nowMs).slice(0, 10) || d.jobs < 3 || d.byCause.drive < A.minRouteDriveHours) continue;
    out.push({
      fingerprint: `cluster_route:${d.day}:${d.techId}`, kind: 'cluster_route', cause: 'drive', technicianId: d.techId, waitlistEntryId: null,
      targetDay: d.day, windowStart: null, windowEnd: null, estimatedHours: r2(d.byCause.drive * A.routeReduction),
      baselineHoursPerDay: perDay(history, 'drive', d.techId),
      title: `Re-order ${d.techName}'s ${d.jobs} visits on ${d.day} to cut driving`,
      detail: { tech: d.techName, day: d.day, jobs: d.jobs, driveHours: d.byCause.drive },
    });
  }

  // 3) pattern fixes from history
  const patterns: { kind: Exclude<FixKind, 'fill_gap' | 'cluster_route'>; cause: LeakCause; reduction: number; perTech: boolean }[] = [
    { kind: 'stage_parts', cause: 'parts_run', reduction: A.partsReduction, perTech: true },
    { kind: 'noshow_reminder', cause: 'no_show', reduction: A.noShowReduction, perTech: false },
    { kind: 'paperwork_capture', cause: 'paperwork', reduction: A.paperworkReduction, perTech: false },
  ];
  for (const p of patterns) {
    if (p.perTech) {
      for (const t of history.techs) {
        const h = t.byCause[p.cause];
        if (h < A.minCauseHours) continue;
        out.push({
          fingerprint: `${p.kind}:${t.techId}:${month}`, kind: p.kind, cause: p.cause, technicianId: t.techId, waitlistEntryId: null,
          targetDay: null, windowStart: null, windowEnd: null, estimatedHours: r2(h * p.reduction),
          baselineHoursPerDay: t.workdays > 0 ? Math.round((h / t.workdays) * 1000) / 1000 : null,
          title: `Stage parts the night before for ${t.techName}`, detail: { tech: t.techName, hours: h, workdays: t.workdays },
        });
      }
    } else {
      const h = history.totals.byCause[p.cause];
      if (h < A.minCauseHours) continue;
      out.push({
        fingerprint: `${p.kind}:${month}`, kind: p.kind, cause: p.cause, technicianId: null, waitlistEntryId: null,
        targetDay: null, windowStart: null, windowEnd: null, estimatedHours: r2(h * p.reduction),
        baselineHoursPerDay: history.totals.workdays > 0 ? Math.round((h / history.totals.workdays) * 1000) / 1000 : null,
        title: p.kind === 'noshow_reminder' ? 'Send automatic appointment reminders to cut no-shows' : 'Capture notes by voice or photo to cut paperwork time',
        detail: { hours: h, workdays: history.totals.workdays },
      });
    }
  }
  return out;
}

function perDay(history: LeakResult, cause: LeakCause, techId: string): number | null {
  const t = history.techs.find((x) => x.techId === techId);
  if (!t || t.workdays === 0) return null;
  return Math.round((t.byCause[cause] / t.workdays) * 1000) / 1000;
}

// ------------------------------------------------------------------ measurement

export interface MeasureResult { ready: boolean; hours: number; method: MeasureMethod; workdays: number }

export interface MeasurableFix {
  kind: FixKind;
  technicianId: string | null;
  approvedAt: string | null;
  baselineHoursPerDay: number | null;
  windowStart: string | null;
  windowEnd: string | null;
}

/**
 * Baseline-delta measurement: hours per technician-day of the fix's cause BEFORE approval (stored on the fix)
 * minus the same figure over the technician-days after approval, multiplied by those days. Never negative.
 * Needs at least FIX_ASSUMPTIONS.minWorkdaysToMeasure workdays of later data, otherwise `ready` is false and
 * nothing is reported as recovered.
 * Note: the paperwork rule is an allowance, so for that fix only real shrinkage of the allowance-bearing gap
 * shows up; treat its figure as a conservative lower bound.
 */
export function measureBaselineDelta(fix: MeasurableFix, rowsAfter: LeakRow[], daysAfter: DayPnL[], afterDay: string): MeasureResult {
  const none: MeasureResult = { ready: false, hours: 0, method: 'baseline_delta', workdays: 0 };
  if (fix.kind === 'fill_gap' || !fix.approvedAt || fix.baselineHoursPerDay === null) return none;
  const scope = MEASURE_SCOPE[fix.kind];
  const approvedMs = Date.parse(fix.approvedAt);
  if (!Number.isFinite(approvedMs)) return none;
  const days = daysAfter.filter((d) => d.day > afterDay && (fix.technicianId === null || d.techId === fix.technicianId));
  const workdays = days.length;
  if (workdays < FIX_ASSUMPTIONS.minWorkdaysToMeasure) return { ...none, workdays };
  const inScope = new Set(days.map((d) => `${d.techId}|${d.day}`));
  const actual = rowsAfter
    .filter((r) => scope.causes.includes(r.cause) && inScope.has(`${r.techId}|${r.day}`))
    .reduce((a, r) => a + r.hours, 0);
  const recovered = Math.max(0, fix.baselineHoursPerDay * workdays - actual);
  return { ready: true, hours: r2(recovered), method: 'baseline_delta', workdays };
}

/** Direct measurement for an accepted waitlist offer: billable hours the booked job actually worked inside the offered slot. */
export function measureFillGap(fix: MeasurableFix, bookedJob: HtJob | null, nowMs: number, settings: Partial<HtSettings> = {}): MeasureResult {
  const base: MeasureResult = { ready: false, hours: 0, method: 'direct_slot', workdays: 0 };
  if (!fix.windowStart || !fix.windowEnd) return base;
  const w0 = Date.parse(fix.windowStart), w1 = Date.parse(fix.windowEnd);
  if (!Number.isFinite(w0) || !Number.isFinite(w1) || nowMs < w1) return base; // slot has not happened yet
  if (!bookedJob) return { ...base, ready: true }; // slot passed with no booked job → 0 recovered, honestly
  const s = sanitizeHtSettings({ ...settings, includePlanned: false });
  const iv = resolveInterval(bookedJob, s);
  if (typeof iv === 'string') return { ...base, ready: true };
  const overlap = Math.max(0, Math.min(iv.end, w1) - Math.max(iv.start, w0));
  return { ready: true, hours: r2(overlap / 3_600_000), method: 'direct_slot', workdays: 1 };
}
