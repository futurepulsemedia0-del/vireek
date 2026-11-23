// Parses the JSON returned by labor_signals_overview() into typed, defensively-normalised data.
// Pure (no Supabase) so it can be unit-tested. Bad or missing fields never throw: they fall back to
// "nothing known", which means fewer signals — never invented ones.

import { normalizeSettings, type BreakSettings, type ReviewRecord as BreakReviewRecord } from '../breakCompliance';
import { WORKER_CLASSIFICATIONS, addDays, type ClockShift, type EmployeeInput, type LaborReview, type PayrollRow, type PwSegment, type WorkerClassification } from './evaluate';
import {
  normalizeOvertimeParams,
  normalizePwParams,
  type CounselStatus,
  type OvertimeParams,
  type PrevailingWageParams,
  type RuleConfigRecord,
  type RuleTopic,
} from './rules';

export interface LaborOverview {
  canEdit: boolean;
  shiftsTruncated: boolean;
  employees: (EmployeeInput & { pay_type: string; basis_note: string | null })[];
  shifts: ClockShift[];
  payroll: PayrollRow[];
  pwSegments: PwSegment[];
  overtime: RuleConfigRecord<OvertimeParams> | null;
  prevailingWage: RuleConfigRecord<PrevailingWageParams> | null;
  breakSettings: BreakSettings | null;
  breakJurisdiction: string | null;
  breakReviews: BreakReviewRecord[];
  reviews: LaborReview[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_STATUSES = ['acknowledged', 'no_action_needed', 'sent_to_counsel'] as const;

function parseRule<P>(row: Obj | undefined, topic: RuleTopic, normalize: (p: unknown) => P): RuleConfigRecord<P> | null {
  if (!row) return null;
  const status: CounselStatus = row.counsel_status === 'counsel_reviewed' ? 'counsel_reviewed' : 'needs_counsel';
  const verified = str(row.verified_on);
  return {
    topic,
    jurisdiction: str(row.jurisdiction) ?? 'CUSTOM',
    enabled: row.enabled !== false,
    params: normalize(row.params),
    citation: str(row.citation),
    source_url: str(row.source_url),
    counsel_status: status,
    counsel_reviewed_by: str(row.counsel_reviewed_by),
    counsel_reviewed_at: str(row.counsel_reviewed_at),
    verified_on: verified && DAY_RE.test(verified.slice(0, 10)) ? verified.slice(0, 10) : null,
  };
}

export function parseOverview(raw: unknown): LaborOverview {
  const r = obj(raw);

  const employees = arr(r.employees)
    .filter((e) => str(e.id))
    .map((e) => ({
      id: e.id as string,
      team_member_id: str(e.team_member_id),
      name: str(e.name) ?? '—',
      employment_type: e.employment_type === '1099' ? ('1099' as const) : ('w2' as const),
      pay_type: str(e.pay_type) ?? 'hourly',
      classification: (WORKER_CLASSIFICATIONS as readonly string[]).includes(e.classification as string) ? (e.classification as WorkerClassification) : ('unreviewed' as const),
      basis_note: str(e.basis_note),
    }));

  const shifts: ClockShift[] = arr(r.shifts)
    .filter((s) => str(s.id) && str(s.employee_id) && str(s.team_member_id) && str(s.work_date) && str(s.clock_in_at))
    .map((s) => ({
      id: s.id as string,
      employee_id: s.employee_id as string,
      team_member_id: s.team_member_id as string,
      work_date: (s.work_date as string).slice(0, 10),
      clock_in_at: s.clock_in_at as string,
      clock_out_at: str(s.clock_out_at),
      breaks: arr(s.breaks).filter((b) => str(b.started_at)).map((b) => ({ started_at: b.started_at as string, ended_at: str(b.ended_at) })),
    }));

  const payroll: PayrollRow[] = arr(r.payroll)
    .filter((p) => str(p.employee_id) && str(p.work_date))
    .map((p) => ({ employee_id: p.employee_id as string, work_date: (p.work_date as string).slice(0, 10), overtime_hours: num(p.overtime_hours) ?? 0 }));

  const pwSegments: PwSegment[] = arr(r.pw_segments)
    .filter((g) => str(g.employee_id) && str(g.job_id) && str(g.work_date))
    .map((g) => ({
      employee_id: g.employee_id as string,
      job_id: g.job_id as string,
      work_date: (g.work_date as string).slice(0, 10),
      minutes: num(g.minutes) ?? 0,
      classification: str(g.classification),
      paid_cents: num(g.paid_cents),
      table_cents: num(g.table_cents),
    }));

  const rules = arr(r.rules);
  const bs = obj(r.break_settings);

  return {
    canEdit: r.can_edit === true,
    shiftsTruncated: r.shifts_truncated === true,
    employees,
    shifts,
    payroll,
    pwSegments,
    overtime: parseRule(rules.find((x) => x.topic === 'overtime'), 'overtime', normalizeOvertimeParams),
    prevailingWage: parseRule(rules.find((x) => x.topic === 'prevailing_wage'), 'prevailing_wage', normalizePwParams),
    breakSettings: Object.keys(bs).length ? normalizeSettings(bs) : null,
    breakJurisdiction: str(bs.jurisdiction),
    breakReviews: arr(r.break_reviews)
      .filter((b) => str(b.shift_id) && ['meal_missing', 'meal_late', 'rest_missing'].includes(b.code as string) && ['waived', 'excused', 'premium_paid'].includes(b.status as string))
      .map((b) => ({ shift_id: b.shift_id as string, code: b.code as BreakReviewRecord['code'], status: b.status as BreakReviewRecord['status'], note: str(b.note) })),
    reviews: arr(r.reviews)
      .filter((v) => str(v.signal_key) && (REVIEW_STATUSES as readonly string[]).includes(v.status as string))
      .map((v) => ({ signal_key: v.signal_key as string, status: v.status as LaborReview['status'], note: str(v.note) })),
  };
}

export const RANGES = [14, 30, 60, 90] as const;
export type RangeDays = (typeof RANGES)[number];

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day of `ms` as YYYY-MM-DD. */
export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Date window to request. `dataFrom` is 6 days before `windowFrom` so any workweek (whatever day it starts on)
 * that overlaps the window is fully present. The server accepts at most 120 days, so ranges are capped at 90 + 6.
 */
export function windowFor(days: RangeDays, now: number): { windowFrom: string; dataFrom: string; to: string } {
  const to = localDay(now);
  const windowFrom = addDays(to, -(days - 1));
  return { windowFrom, dataFrom: addDays(windowFrom, -6), to };
}
