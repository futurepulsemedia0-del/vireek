// src/lib/hiddenTech/leakEngine.ts
//
// Hidden Technician — leak attribution engine. Pure, deterministic, no I/O.
//
// Model (all figures are ESTIMATES derived from the job times the owner already has):
//   paid window   = [first job start of the technician-day, + paidHoursPerDay]
//   billable      = time inside the window spent on billable jobs
//   leaked        = everything else inside the window
//   Every leaked segment is assigned to EXACTLY ONE cause, so
//   sum(leaked rows) === paid − billable for every technician-day (tested invariant).
//
// Causes (fixed precedence, explainable via the `rule` code on each row):
//   no_show           job status says the customer was not there                (measured)
//   callback          job flagged as rework / return visit                       (measured)
//   waiting_approval  job status is waiting for customer/office approval         (measured)
//   parts_run         job status waiting_parts, a "parts" tag, or the idle gap
//                     right after such a job                                     (measured / inferred)
//   paperwork         first N minutes of a gap after a billable job              (estimated)
//   drive             gap time before the next job (en-route timestamp if known) (measured / inferred)
//   idle_gap          every remaining gap + unscheduled end-of-day slack         (inferred / estimated)
//
// A job belongs to the local calendar day it STARTS on, so overnight jobs stay in one piece.
// Overlapping jobs are counted once. Rows that cannot be trusted are skipped and reported.

import { DEFAULT_HOURLY_COST, isValidTimeZone, localDay } from '../hoursAudit';

export const LEAK_CAUSES = ['drive', 'idle_gap', 'parts_run', 'no_show', 'callback', 'paperwork', 'waiting_approval'] as const;
export type LeakCause = (typeof LEAK_CAUSES)[number];
export type Confidence = 'measured' | 'inferred' | 'estimated';

export interface HtJob {
  id: string;
  techId: string;
  techName?: string | null;
  /** jobs.scheduled_datetime (ISO) */
  scheduledAt: string | null;
  /** jobs.started_at — technician pressed "in progress" */
  startedAt: string | null;
  /** jobs.arrived_at — set when the technician went "en route" */
  enRouteAt: string | null;
  completedAt: string | null;
  /** telematics_job_visits geofence arrival / departure (measured on-site time, overrides the above) */
  onsiteArrivedAt?: string | null;
  onsiteDepartedAt?: string | null;
  durationMinutes: number | null;
  status: string | null;
  isRework: boolean;
  /** comma separated jobs.tags */
  tags?: string | null;
}

export interface HtSettings {
  timeZone: string;
  paidHoursPerDay: number;
  hourlyCost: number;
  driveGapCapMinutes: number;
  paperworkAllowanceMinutes: number;
  partsRunCapMinutes: number;
  maxJobHours: number;
  /** Count future `scheduled` jobs as billable (used for the forecast of upcoming days). */
  includePlanned: boolean;
}

export function defaultHtSettings(timeZone = 'UTC'): HtSettings {
  return {
    timeZone, paidHoursPerDay: 8, hourlyCost: DEFAULT_HOURLY_COST, driveGapCapMinutes: 30,
    paperworkAllowanceMinutes: 10, partsRunCapMinutes: 90, maxJobHours: 16, includePlanned: false,
  };
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Clamp any user-edited settings into safe ranges so a typo can never create NaN or negative money. */
export function sanitizeHtSettings(raw: Partial<HtSettings> = {}): HtSettings {
  const base = defaultHtSettings();
  const tz = typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone) ? raw.timeZone : base.timeZone;
  return {
    timeZone: tz,
    paidHoursPerDay: clamp(raw.paidHoursPerDay, 1, 16, base.paidHoursPerDay),
    hourlyCost: clamp(raw.hourlyCost, 1, 2000, base.hourlyCost),
    driveGapCapMinutes: clamp(raw.driveGapCapMinutes, 0, 240, base.driveGapCapMinutes),
    paperworkAllowanceMinutes: clamp(raw.paperworkAllowanceMinutes, 0, 60, base.paperworkAllowanceMinutes),
    partsRunCapMinutes: clamp(raw.partsRunCapMinutes, 0, 240, base.partsRunCapMinutes),
    maxJobHours: clamp(raw.maxJobHours, 1, 24, base.maxJobHours),
    includePlanned: raw.includePlanned === true,
  };
}

export interface LeakRow {
  techId: string;
  techName: string;
  day: string; // local YYYY-MM-DD of the first job start
  cause: LeakCause;
  hours: number;
  startMs: number;
  endMs: number;
  jobId: string | null;
  confidence: Confidence;
  rule: string;
}

export interface DayPnL {
  techId: string;
  techName: string;
  day: string;
  jobs: number;
  paidHours: number;
  billableHours: number;
  leakedHours: number;
  overlapHours: number;
  utilization: number; // 0..100
  leakedCost: number;
  byCause: Record<LeakCause, number>;
}

export type SkipCode = 'missing_technician' | 'missing_time' | 'bad_time' | 'end_before_start' | 'too_long' | 'not_run' | 'cancelled' | 'fully_overlapped';
export interface SkippedJob { jobId: string; code: SkipCode }

export interface TechSummary {
  techId: string;
  techName: string;
  workdays: number;
  paidHours: number;
  billableHours: number;
  leakedHours: number;
  utilization: number;
  leakedCost: number;
  byCause: Record<LeakCause, number>;
}

export interface LeakResult {
  rows: LeakRow[];
  days: DayPnL[];
  techs: TechSummary[]; // alphabetical on purpose — this is an audit, not a ranking
  skipped: SkippedJob[];
  totals: { workdays: number; paidHours: number; billableHours: number; leakedHours: number; leakedCost: number; utilization: number; byCause: Record<LeakCause, number> };
  topLeaks: { cause: LeakCause; hours: number; cost: number }[]; // up to 3, hours desc
  settings: HtSettings;
}

const HOUR = 3_600_000;
const MIN = 60_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
export const emptyCauses = (): Record<LeakCause, number> => ({ drive: 0, idle_gap: 0, parts_run: 0, no_show: 0, callback: 0, paperwork: 0, waiting_approval: 0 });

const EXCLUDED = new Set(['cancelled', 'canceled', 'draft', 'rescheduled', 'deleted']);
const NO_SHOW = new Set(['no_show', 'customer_no_show', 'no_access', 'cancelled_on_site', 'canceled_on_site']);
const WAIT_APPROVAL = new Set(['waiting_approval', 'pending_approval', 'awaiting_approval']);
const WAIT_PARTS = new Set(['waiting_parts', 'parts_needed', 'awaiting_parts']);
const DONE = new Set(['completed', 'complete', 'done', 'closed', 'invoiced', 'paid', 'in_progress', 'on_site']);
const PLANNED = new Set(['scheduled', 'confirmed', 'en_route', 'dispatched', 'assigned']);

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const tagSet = (tags?: string | null) => new Set((tags ?? '').split(',').map((t) => norm(t)).filter(Boolean));

const parse = (s: string | null | undefined): number | null | 'bad' => {
  if (s === null || s === undefined || s === '') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 'bad';
};

interface Cls { billable: boolean; cause?: LeakCause; confidence: Confidence; rule: string; partsFlag: boolean }

/** Decides whether a job's own time is billable or which single cause it leaks to. Status = measured, tags = inferred. */
export function classifyJob(job: Pick<HtJob, 'status' | 'isRework' | 'tags'>): Cls {
  const status = norm(job.status);
  const tags = tagSet(job.tags);
  const partsFlag = WAIT_PARTS.has(status) || tags.has('parts') || tags.has('parts_run') || tags.has('waiting_parts');
  if (NO_SHOW.has(status)) return { billable: false, cause: 'no_show', confidence: 'measured', rule: 'job.status.no_show', partsFlag };
  if (tags.has('no_show') || tags.has('no_access')) return { billable: false, cause: 'no_show', confidence: 'inferred', rule: 'job.tag.no_show', partsFlag };
  if (job.isRework) return { billable: false, cause: 'callback', confidence: 'measured', rule: 'job.rework', partsFlag };
  if (tags.has('callback') || tags.has('return_visit')) return { billable: false, cause: 'callback', confidence: 'inferred', rule: 'job.tag.callback', partsFlag };
  if (WAIT_APPROVAL.has(status)) return { billable: false, cause: 'waiting_approval', confidence: 'measured', rule: 'job.status.waiting_approval', partsFlag };
  if (tags.has('waiting_approval')) return { billable: false, cause: 'waiting_approval', confidence: 'inferred', rule: 'job.tag.waiting_approval', partsFlag };
  if (WAIT_PARTS.has(status)) return { billable: false, cause: 'parts_run', confidence: 'measured', rule: 'job.status.waiting_parts', partsFlag };
  return { billable: true, confidence: 'measured', rule: 'job.billable', partsFlag };
}

interface Item { job: HtJob; start: number; end: number; cls: Cls; enRoute: number | null }

/** Resolve a job to a concrete [start,end] interval, or the reason it cannot be used. */
export function resolveInterval(job: HtJob, s: HtSettings): { start: number; end: number; enRoute: number | null } | SkipCode {
  const status = norm(job.status);
  if (EXCLUDED.has(status)) return 'cancelled';
  const cls = classifyJob(job);
  const ran = DONE.has(status) || !cls.billable;
  const planned = PLANNED.has(status) || status === '';
  if (!ran && !(planned && s.includePlanned)) return 'not_run';

  const vals = [job.onsiteArrivedAt, job.startedAt, job.scheduledAt, job.completedAt, job.onsiteDepartedAt, job.enRouteAt].map(parse);
  if (vals.includes('bad')) return 'bad_time';
  const [siteIn, started, scheduled, completed, siteOut, enRouteRaw] = vals as (number | null)[];

  const start = siteIn ?? started ?? scheduled;
  if (start === null) return 'missing_time';
  let end = siteOut ?? completed;
  if (end === null) {
    const dur = job.durationMinutes && job.durationMinutes > 0 ? job.durationMinutes : 60; // documented default for missing end
    end = start + dur * MIN;
  }
  if (end <= start) return 'end_before_start';
  if (end - start > s.maxJobHours * HOUR) return 'too_long';
  // en-route time is only trusted when it precedes the job by at most 3 hours.
  const enRoute = enRouteRaw !== null && enRouteRaw < start && start - enRouteRaw <= 3 * HOUR ? enRouteRaw : null;
  return { start, end, enRoute };
}

export function analyzeLeaks(jobs: HtJob[], rawSettings: Partial<HtSettings> = {}): LeakResult {
  const s = sanitizeHtSettings(rawSettings);
  const skipped: SkippedJob[] = [];
  const groups = new Map<string, { id: string; name: string; days: Map<string, Item[]> }>();

  for (const job of jobs) {
    if (!job.techId) { skipped.push({ jobId: job.id, code: 'missing_technician' }); continue; }
    const r = resolveInterval(job, s);
    if (typeof r === 'string') { skipped.push({ jobId: job.id, code: r }); continue; }
    let g = groups.get(job.techId);
    if (!g) groups.set(job.techId, (g = { id: job.techId, name: job.techName?.trim() || 'Technician', days: new Map() }));
    if (job.techName && g.name === 'Technician') g.name = job.techName.trim();
    const day = localDay(r.start, s.timeZone);
    const list = g.days.get(day) ?? [];
    list.push({ job, start: r.start, end: r.end, cls: classifyJob(job), enRoute: r.enRoute });
    g.days.set(day, list);
  }

  const rows: LeakRow[] = [];
  const days: DayPnL[] = [];
  const paidMs = s.paidHoursPerDay * HOUR;
  const capMs = s.driveGapCapMinutes * MIN;
  const paperMs = s.paperworkAllowanceMinutes * MIN;
  const partsCapMs = s.partsRunCapMinutes * MIN;

  for (const g of groups.values()) {
    for (const [day, raw] of g.days) {
      const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
      // 1) remove overlaps: later job starts where the earlier one ends; fully covered jobs are dropped.
      const items: Item[] = [];
      let overlapMs = 0;
      let cursorEnd = -Infinity;
      for (const it of sorted) {
        if (it.end <= cursorEnd) { overlapMs += it.end - it.start; skipped.push({ jobId: it.job.id, code: 'fully_overlapped' }); continue; }
        if (it.start < cursorEnd) { overlapMs += cursorEnd - it.start; items.push({ ...it, start: cursorEnd }); } else items.push(it);
        cursorEnd = Math.max(cursorEnd, it.end);
      }
      if (items.length === 0) continue;

      const w0 = items[0].start;
      const w1 = w0 + paidMs;
      let billableMs = 0;
      const dayRows: LeakRow[] = [];
      const push = (cause: LeakCause, a: number, b: number, jobId: string | null, confidence: Confidence, rule: string) => {
        const lo = Math.max(a, w0), hi = Math.min(b, w1);
        if (hi - lo <= 0) return;
        dayRows.push({ techId: g.id, techName: g.name, day, cause, hours: (hi - lo) / HOUR, startMs: lo, endMs: hi, jobId, confidence, rule });
      };

      const splitGap = (a: number, b: number, before: Item | null, next: Item) => {
        let t = a;
        // paperwork: first N minutes after a billable job
        if (before && before.cls.billable && paperMs > 0) {
          const e = Math.min(b, t + paperMs);
          push('paperwork', t, e, before.job.id, 'estimated', 'gap.paperwork.allowance');
          t = e;
        }
        if (t >= b) return;
        // drive: measured from the en-route timestamp when valid, otherwise the last `cap` minutes of the gap
        let driveStart: number;
        let driveConf: Confidence;
        if (next.enRoute !== null && next.enRoute >= t && next.enRoute < b) { driveStart = next.enRoute; driveConf = 'measured'; }
        else { driveStart = Math.max(t, b - capMs); driveConf = 'inferred'; }
        if (driveStart > t) {
          if (before?.cls.partsFlag && driveStart - t <= partsCapMs) push('parts_run', t, driveStart, before.job.id, 'inferred', 'gap.parts_run.after_parts_job');
          else push('idle_gap', t, driveStart, null, 'inferred', 'gap.idle');
        }
        push('drive', driveStart, b, next.job.id, driveConf, driveConf === 'measured' ? 'gap.drive.en_route' : 'gap.drive.cap');
      };

      let cur = w0;
      let prev: Item | null = null;
      for (const it of items) {
        if (cur >= w1) break;
        if (it.start > cur) splitGap(cur, it.start, prev, it);
        const lo = Math.max(it.start, w0), hi = Math.min(it.end, w1);
        if (hi > lo) {
          if (it.cls.billable) billableMs += hi - lo;
          else push(it.cls.cause as LeakCause, lo, hi, it.job.id, it.cls.confidence, it.cls.rule);
        }
        cur = Math.max(cur, it.end);
        prev = it;
      }
      if (cur < w1) push('idle_gap', cur, w1, null, 'estimated', 'day.unscheduled_slack');

      const byCause = emptyCauses();
      let leakedMs = 0;
      for (const r of dayRows) { byCause[r.cause] += r.hours; leakedMs += r.endMs - r.startMs; }
      // billable + leaked tile the window exactly; the remainder (if the window was clipped) is 0 by construction.
      const paidUsed = Math.max(billableMs + leakedMs, 0);
      for (const c of LEAK_CAUSES) byCause[c] = r2(byCause[c]);
      days.push({
        techId: g.id, techName: g.name, day, jobs: items.length,
        paidHours: r2(paidUsed / HOUR), billableHours: r2(billableMs / HOUR), leakedHours: r2(leakedMs / HOUR),
        overlapHours: r2(overlapMs / HOUR), utilization: paidUsed > 0 ? Math.round((billableMs / paidUsed) * 1000) / 10 : 0,
        leakedCost: r2((leakedMs / HOUR) * s.hourlyCost), byCause,
      });
      rows.push(...dayRows);
    }
  }

  days.sort((a, b) => (a.day === b.day ? a.techName.localeCompare(b.techName) : a.day < b.day ? -1 : 1));
  rows.sort((a, b) => a.startMs - b.startMs || a.techName.localeCompare(b.techName));

  const techMap = new Map<string, TechSummary>();
  const totals = { workdays: 0, paidHours: 0, billableHours: 0, leakedHours: 0, leakedCost: 0, utilization: 0, byCause: emptyCauses() };
  for (const d of days) {
    let t = techMap.get(d.techId);
    if (!t) techMap.set(d.techId, (t = { techId: d.techId, techName: d.techName, workdays: 0, paidHours: 0, billableHours: 0, leakedHours: 0, utilization: 0, leakedCost: 0, byCause: emptyCauses() }));
    t.workdays++; t.paidHours += d.paidHours; t.billableHours += d.billableHours; t.leakedHours += d.leakedHours;
    totals.workdays++; totals.paidHours += d.paidHours; totals.billableHours += d.billableHours; totals.leakedHours += d.leakedHours;
    for (const c of LEAK_CAUSES) { t.byCause[c] += d.byCause[c]; totals.byCause[c] += d.byCause[c]; }
  }
  const techs = [...techMap.values()].sort((a, b) => a.techName.localeCompare(b.techName)).map((t) => {
    const byCause = emptyCauses();
    for (const c of LEAK_CAUSES) byCause[c] = r2(t.byCause[c]);
    return {
      ...t, byCause, paidHours: r2(t.paidHours), billableHours: r2(t.billableHours), leakedHours: r2(t.leakedHours),
      utilization: t.paidHours > 0 ? Math.round((t.billableHours / t.paidHours) * 1000) / 10 : 0,
      leakedCost: r2(t.leakedHours * s.hourlyCost),
    };
  });
  for (const c of LEAK_CAUSES) totals.byCause[c] = r2(totals.byCause[c]);
  totals.paidHours = r2(totals.paidHours); totals.billableHours = r2(totals.billableHours); totals.leakedHours = r2(totals.leakedHours);
  totals.leakedCost = r2(totals.leakedHours * s.hourlyCost);
  totals.utilization = totals.paidHours > 0 ? Math.round((totals.billableHours / totals.paidHours) * 1000) / 10 : 0;

  const topLeaks = LEAK_CAUSES.map((cause) => ({ cause, hours: totals.byCause[cause], cost: r2(totals.byCause[cause] * s.hourlyCost) }))
    .filter((x) => x.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 3);

  return { rows, days, techs, skipped, totals, topLeaks, settings: s };
}
