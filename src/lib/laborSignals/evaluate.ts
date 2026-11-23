// Labor-compliance SIGNALS — pure evaluation (no Supabase, no DOM, no wording).
//
// [COUNSEL] [VERIFY] — see rules.ts. A signal is "this record is worth a look", never a finding that
// a law was broken. The module returns codes + numeric facts only; all user-facing text lives in the
// i18n namespace so it can be translated, reviewed by counsel, and kept free of legal conclusions.
//
// Hours come from time-clock shifts (breaks removed). Nothing is stored: changing a rule
// re-evaluates history, the same approach as breakCompliance.ts.

import { applyReviews, evaluateShifts, type BreakSettings, type ReviewRecord as BreakReviewRecord, type ShiftRecord } from '../breakCompliance';
import type { OvertimeParams, PrevailingWageParams } from './rules';

export type WorkerClassification =
  | 'unreviewed' // nobody has recorded anything — treated like an hourly record for hour signals
  | 'hourly_recorded'
  | 'exempt_recorded' // the business has recorded that it treats this worker as exempt from overtime
  | 'contractor_recorded' // the business has recorded this worker as an independent contractor
  | 'apprentice_recorded';

export const WORKER_CLASSIFICATIONS: readonly WorkerClassification[] = [
  'unreviewed',
  'hourly_recorded',
  'apprentice_recorded',
  'exempt_recorded',
  'contractor_recorded',
];

/** Classifications for which hour-based signals are not evaluated (the business recorded they do not apply). */
export function isHourSignalExcluded(c: WorkerClassification, employmentType: 'w2' | '1099'): boolean {
  return c === 'exempt_recorded' || c === 'contractor_recorded' || employmentType === '1099';
}

export type SignalCode =
  | 'daily_hours_above_threshold'
  | 'weekly_hours_above_threshold'
  | 'payroll_overtime_below_clock'
  | 'seventh_day_clocked'
  | 'open_shift_long'
  | 'classification_with_clock_use'
  | 'pw_classification_missing'
  | 'pw_pay_below_table'
  | 'break_meal_missing'
  | 'break_meal_late'
  | 'break_rest_missing';

export type SignalReviewStatus = 'open' | 'acknowledged' | 'no_action_needed' | 'sent_to_counsel';
export type SignalTopic = 'overtime' | 'classification' | 'prevailing_wage' | 'breaks';

export interface LaborSignal {
  /** Stable id `code:employeeId:YYYY-MM-DD` — what a review is saved against. */
  key: string;
  code: SignalCode;
  topic: SignalTopic;
  employeeId: string;
  /** YYYY-MM-DD the signal is anchored to (a day, a week start, or the first day of a month). */
  anchorDate: string;
  facts: Record<string, number | string>;
  /** Break signals are reviewed on the Break Compliance page, which already owns that workflow. */
  readOnly: boolean;
  status: SignalReviewStatus;
  note: string | null;
}

export interface EmployeeInput {
  id: string;
  team_member_id: string | null;
  name: string;
  employment_type: 'w2' | '1099';
  classification: WorkerClassification;
}

export interface ClockShift {
  id: string;
  employee_id: string;
  team_member_id: string;
  work_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  breaks: { started_at: string; ended_at: string | null }[];
}

export interface PayrollRow {
  employee_id: string;
  work_date: string;
  overtime_hours: number;
}

export interface PwSegment {
  employee_id: string;
  job_id: string;
  work_date: string;
  minutes: number;
  /** Classification recorded for the worker on the job on that date; null = none recorded. */
  classification: string | null;
  /** Hourly pay + plan fringe recorded for the worker, in cents. null = not recorded. */
  paid_cents: number | null;
  /** Wage-table base + fringe for that classification and date, in cents. null = no matching table row. */
  table_cents: number | null;
}

export interface LaborReview {
  signal_key: string;
  status: Exclude<SignalReviewStatus, 'open'>;
  note: string | null;
}

export interface EvaluateInput {
  employees: EmployeeInput[];
  shifts: ClockShift[];
  payroll: PayrollRow[];
  pwSegments: PwSegment[];
  overtime: OvertimeParams | null; // null = topic not configured/enabled → no overtime signals
  prevailingWage: PrevailingWageParams | null;
  breakSettings: BreakSettings | null; // null = break topic not enabled
  breakReviews: BreakReviewRecord[];
  reviews: LaborReview[];
  now: number;
  /**
   * First day (YYYY-MM-DD) the person asked to look at. Data may start a few days earlier so that whole
   * workweeks are present; anything that ends before this day is dropped from the result.
   */
  windowFrom?: string;
}

export interface EvaluateResult {
  signals: LaborSignal[];
  /** Employees whose hour-based signals were skipped because of the recorded classification. */
  excludedEmployeeIds: string[];
}

const MIN = 60_000;
const EPS = 1e-9;

// ------------------------------------------------------------------
// Date helpers (YYYY-MM-DD only; UTC arithmetic so DST never shifts a day)
// ------------------------------------------------------------------

const parseDay = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fmtDay(parseDay(d) + n * 86_400_000);

/** First day (per `startDow`, 0 = Sunday) of the workweek that contains `d`. */
export function weekStartOf(d: string, startDow: number): string {
  const dow = new Date(parseDay(d)).getUTCDay();
  return addDays(d, -((dow - startDow + 7) % 7));
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------
// Worked time
// ------------------------------------------------------------------

/** Net worked minutes of a CLOSED shift (breaks removed). Open shifts return 0. */
export function netMinutes(s: Pick<ClockShift, 'clock_in_at' | 'clock_out_at' | 'breaks'>): number {
  if (!s.clock_out_at) return 0;
  const start = Date.parse(s.clock_in_at);
  const end = Date.parse(s.clock_out_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let brk = 0;
  for (const b of s.breaks) {
    const bs = Date.parse(b.started_at);
    const be = b.ended_at ? Date.parse(b.ended_at) : end;
    if (!Number.isFinite(bs) || !Number.isFinite(be)) continue;
    brk += Math.max(0, Math.min(be, end) - Math.max(bs, start));
  }
  return Math.max(0, (end - start - brk) / MIN);
}

export interface WeekTotals {
  weekStart: string;
  /** Hours per work date, ascending. */
  days: { date: string; hours: number }[];
  totalHours: number;
  /** Hours above the configured thresholds, per the layered rule below. */
  otHours: number;
  dtHours: number;
}

/**
 * Hours above the configured thresholds for ONE workweek (days ascending).
 * Layering: daily second tier, daily first tier, then regular hours past the weekly threshold.
 * This is a threshold approximation for comparing records — it is not a pay calculation.
 */
export function thresholdHours(days: { date: string; hours: number }[], p: OvertimeParams): { otHours: number; dtHours: number } {
  let regularCum = 0;
  let ot = 0;
  let dt = 0;
  for (const { hours } of days) {
    const dtPart = p.daily_dt_after_hours !== null ? Math.max(0, hours - p.daily_dt_after_hours) : 0;
    let otPart = 0;
    if (p.daily_ot_after_hours !== null) {
      otPart = Math.max(0, Math.min(hours, p.daily_dt_after_hours ?? Infinity) - p.daily_ot_after_hours);
    }
    let reg = hours - dtPart - otPart;
    if (p.weekly_threshold_hours !== null) {
      const over = Math.max(0, reg - Math.max(0, p.weekly_threshold_hours - regularCum));
      reg -= over;
      otPart += over;
    }
    regularCum += reg;
    ot += otPart;
    dt += dtPart;
  }
  return { otHours: round2(ot), dtHours: round2(dt) };
}

function buildWeeks(shifts: ClockShift[], startDow: number): Map<string, Map<string, WeekTotals>> {
  // employee -> weekStart -> totals
  const perEmployeeDay = new Map<string, Map<string, number>>();
  for (const s of shifts) {
    const mins = netMinutes(s);
    if (mins <= 0) continue;
    const days = perEmployeeDay.get(s.employee_id) ?? new Map<string, number>();
    days.set(s.work_date, (days.get(s.work_date) ?? 0) + mins);
    perEmployeeDay.set(s.employee_id, days);
  }
  const out = new Map<string, Map<string, WeekTotals>>();
  for (const [emp, days] of perEmployeeDay) {
    const weeks = new Map<string, WeekTotals>();
    for (const [date, mins] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ws = weekStartOf(date, startDow);
      const w = weeks.get(ws) ?? { weekStart: ws, days: [], totalHours: 0, otHours: 0, dtHours: 0 };
      w.days.push({ date, hours: mins / 60 });
      w.totalHours += mins / 60;
      weeks.set(ws, w);
    }
    out.set(emp, weeks);
  }
  return out;
}

// ------------------------------------------------------------------
// Evaluation
// ------------------------------------------------------------------

export function evaluateLaborSignals(input: EvaluateInput): EvaluateResult {
  const { employees, shifts, payroll, pwSegments, overtime, prevailingWage, breakSettings, now } = input;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const empByMember = new Map(employees.filter((e) => e.team_member_id).map((e) => [e.team_member_id as string, e]));
  const signals: LaborSignal[] = [];
  const excluded = new Set<string>();

  const push = (
    code: SignalCode,
    topic: SignalTopic,
    employeeId: string,
    anchorDate: string,
    facts: LaborSignal['facts'],
    readOnly = false,
    keyOverride?: string,
  ) => {
    signals.push({ key: keyOverride ?? `${code}:${employeeId}:${anchorDate}`, code, topic, employeeId, anchorDate, facts, readOnly, status: 'open', note: null });
  };

  const hourExcluded = (empId: string): boolean => {
    const e = empById.get(empId);
    if (!e) return true; // unknown worker: never guess
    const x = isHourSignalExcluded(e.classification, e.employment_type);
    if (x) excluded.add(empId);
    return x;
  };

  // ---- classification vs clock use (no rule config needed: it is a data-consistency check) ----
  const lastShiftDayByEmpMonth = new Map<string, { emp: string; month: string; shifts: number }>();
  for (const s of shifts) {
    const e = empById.get(s.employee_id);
    if (!e) continue;
    if (!(e.classification === 'exempt_recorded' || e.classification === 'contractor_recorded' || e.employment_type === '1099')) continue;
    const month = monthStart(s.work_date);
    const k = `${e.id}:${month}`;
    const cur = lastShiftDayByEmpMonth.get(k) ?? { emp: e.id, month, shifts: 0 };
    cur.shifts += 1;
    lastShiftDayByEmpMonth.set(k, cur);
  }
  for (const v of lastShiftDayByEmpMonth.values()) {
    const e = empById.get(v.emp)!;
    push('classification_with_clock_use', 'classification', v.emp, v.month, { shifts: v.shifts, classification: e.classification, employmentType: e.employment_type });
  }

  // ---- overtime-threshold family ----
  if (overtime) {
    const weeks = buildWeeks(shifts, overtime.workweek_start_dow);
    const payrollByEmpWeek = new Map<string, number>();
    for (const r of payroll) {
      const k = `${r.employee_id}:${weekStartOf(r.work_date, overtime.workweek_start_dow)}`;
      payrollByEmpWeek.set(k, (payrollByEmpWeek.get(k) ?? 0) + (Number(r.overtime_hours) || 0));
    }

    for (const [empId, byWeek] of weeks) {
      if (hourExcluded(empId)) continue;
      for (const w of byWeek.values()) {
        // daily tier
        if (overtime.daily_ot_after_hours !== null) {
          for (const d of w.days) {
            if (d.hours > overtime.daily_ot_after_hours + EPS) {
              push('daily_hours_above_threshold', 'overtime', empId, d.date, {
                hours: round2(d.hours),
                threshold: overtime.daily_ot_after_hours,
                ...(overtime.daily_dt_after_hours !== null && d.hours > overtime.daily_dt_after_hours + EPS ? { secondTier: overtime.daily_dt_after_hours } : {}),
              });
            }
          }
        }
        // weekly
        if (overtime.weekly_threshold_hours !== null && w.totalHours > overtime.weekly_threshold_hours + EPS) {
          push('weekly_hours_above_threshold', 'overtime', empId, w.weekStart, { hours: round2(w.totalHours), threshold: overtime.weekly_threshold_hours });
        }
        // payroll vs clock
        const t = thresholdHours(w.days, overtime);
        const clockOt = t.otHours + t.dtHours;
        if (clockOt > 0) {
          const paid = round2(payrollByEmpWeek.get(`${empId}:${w.weekStart}`) ?? 0);
          if (clockOt - paid > overtime.payroll_gap_tolerance_hours + EPS) {
            push('payroll_overtime_below_clock', 'overtime', empId, w.weekStart, { clockHours: clockOt, payrollHours: paid, gap: round2(clockOt - paid) });
          }
        }
        // seventh day
        if (overtime.seventh_day_signal) {
          const dates = new Set(w.days.map((d) => d.date));
          let all = true;
          for (let i = 0; i < 7; i += 1) if (!dates.has(addDays(w.weekStart, i))) { all = false; break; }
          if (all) push('seventh_day_clocked', 'overtime', empId, addDays(w.weekStart, 6), { weekStart: w.weekStart });
        }
      }
    }

    // long open shifts (data quality: probable missed clock-out)
    for (const s of shifts) {
      if (s.clock_out_at) continue;
      const hours = (now - Date.parse(s.clock_in_at)) / 3_600_000;
      if (Number.isFinite(hours) && hours > overtime.open_shift_alert_hours + EPS && empById.has(s.employee_id)) {
        push('open_shift_long', 'overtime', s.employee_id, s.work_date, { hours: round2(hours), threshold: overtime.open_shift_alert_hours });
      }
    }
  }

  // ---- prevailing-wage data checks ----
  if (prevailingWage) {
    const missing = new Map<string, { emp: string; date: string; jobs: Set<string>; minutes: number }>();
    const below = new Map<string, { emp: string; date: string; paid: number; table: number; minutes: number }>();
    for (const g of pwSegments) {
      if (!empById.has(g.employee_id) || g.minutes <= 0) continue;
      if (prevailingWage.check_missing_classification && !g.classification) {
        const k = `${g.employee_id}:${g.work_date}`;
        const cur = missing.get(k) ?? { emp: g.employee_id, date: g.work_date, jobs: new Set<string>(), minutes: 0 };
        cur.jobs.add(g.job_id);
        cur.minutes += g.minutes;
        missing.set(k, cur);
      }
      if (prevailingWage.check_rate_below_table && g.classification && g.table_cents !== null && g.paid_cents !== null && g.paid_cents < g.table_cents) {
        const k = `${g.employee_id}:${g.work_date}`;
        const cur = below.get(k);
        // keep the largest shortfall of the day so the fact shown is the one worth looking at
        if (!cur || g.table_cents - g.paid_cents > cur.table - cur.paid) below.set(k, { emp: g.employee_id, date: g.work_date, paid: g.paid_cents, table: g.table_cents, minutes: (cur?.minutes ?? 0) + g.minutes });
        else cur.minutes += g.minutes;
      }
    }
    for (const m of missing.values()) push('pw_classification_missing', 'prevailing_wage', m.emp, m.date, { jobs: m.jobs.size, hours: round2(m.minutes / 60) });
    for (const b of below.values()) push('pw_pay_below_table', 'prevailing_wage', b.emp, b.date, { paidCents: b.paid, tableCents: b.table, hours: round2(b.minutes / 60) });
  }

  // ---- breaks: reuse the existing engine (single source of truth), read-only here ----
  if (breakSettings?.enabled) {
    const records: ShiftRecord[] = shifts.map((s) => ({
      id: s.id,
      team_member_id: s.team_member_id,
      work_date: s.work_date,
      clock_in_at: s.clock_in_at,
      clock_out_at: s.clock_out_at,
      breaks: s.breaks,
    }));
    const compliance = applyReviews(evaluateShifts(records, breakSettings, now), input.breakReviews);
    for (const sc of compliance) {
      const e = empByMember.get(sc.memberId);
      if (!e || hourExcluded(e.id)) continue;
      for (const v of sc.violations) {
        if (v.status !== 'open') continue;
        push(`break_${v.code}` as SignalCode, 'breaks', e.id, sc.workDate, { shiftId: sc.shiftId, workedMinutes: Math.round(sc.workedMinutes) }, true, `break:${sc.shiftId}:${v.code}`);
      }
    }
  }

  // ---- window: drop what ends before the requested first day (the data may start earlier for whole weeks) ----
  const from = input.windowFrom;
  const inWindow = (s: LaborSignal): boolean => {
    if (!from) return true;
    if (s.code === 'classification_with_clock_use') return true;
    if (s.code === 'weekly_hours_above_threshold' || s.code === 'payroll_overtime_below_clock') return addDays(s.anchorDate, 6) >= from;
    return s.anchorDate >= from;
  };

  // ---- merge reviews, order: open first, then newest anchor ----
  const reviewByKey = new Map(input.reviews.map((r) => [r.signal_key, r]));
  const merged = signals.filter(inWindow).map((s) => {
    const r = reviewByKey.get(s.key);
    return r && !s.readOnly ? { ...s, status: r.status, note: r.note } : s;
  });
  merged.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.anchorDate.localeCompare(a.anchorDate) || a.key.localeCompare(b.key));
  return { signals: merged, excludedEmployeeIds: [...excluded].sort() };
}

// ------------------------------------------------------------------
// Summary helpers for the page
// ------------------------------------------------------------------

export interface SignalSummary {
  open: number;
  reviewed: number;
  byTopic: Record<SignalTopic, number>;
  byEmployee: { employeeId: string; open: number }[];
}

export function summarizeSignals(list: LaborSignal[]): SignalSummary {
  const byTopic: Record<SignalTopic, number> = { overtime: 0, classification: 0, prevailing_wage: 0, breaks: 0 };
  const perEmp = new Map<string, number>();
  let open = 0;
  let reviewed = 0;
  for (const s of list) {
    if (s.status === 'open') {
      open += 1;
      byTopic[s.topic] += 1;
      perEmp.set(s.employeeId, (perEmp.get(s.employeeId) ?? 0) + 1);
    } else reviewed += 1;
  }
  return { open, reviewed, byTopic, byEmployee: [...perEmp].map(([employeeId, n]) => ({ employeeId, open: n })).sort((a, b) => b.open - a.open || a.employeeId.localeCompare(b.employeeId)) };
}

export type SignalFilter = 'open' | 'all';
export function filterSignals(list: LaborSignal[], employeeId: string, topic: SignalTopic | 'all', filter: SignalFilter): LaborSignal[] {
  return list.filter((s) => (employeeId === 'all' || s.employeeId === employeeId) && (topic === 'all' || s.topic === topic) && (filter === 'all' || s.status === 'open'));
}

/** Server-side key shape accepted by review_labor_signal(). Break signals are intentionally excluded. */
export const REVIEWABLE_KEY_RE = /^[a-z_]{3,40}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2}$/;
