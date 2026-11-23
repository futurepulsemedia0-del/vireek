import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../breakCompliance';
import {
  REVIEWABLE_KEY_RE,
  addDays,
  evaluateLaborSignals,
  filterSignals,
  isHourSignalExcluded,
  netMinutes,
  summarizeSignals,
  thresholdHours,
  weekStartOf,
  type ClockShift,
  type EmployeeInput,
  type EvaluateInput,
  type PwSegment,
} from './evaluate';
import { DEFAULT_OVERTIME_PARAMS, DEFAULT_PW_PARAMS, getOvertimePack, type OvertimeParams } from './rules';

// Monday 2027-03-01 is the first day of the fixture week (workweek starts Monday = 1).
const MON = '2027-03-01';
const day = (n: number) => addDays(MON, n);
const EMP: EmployeeInput = { id: '11111111-1111-1111-1111-111111111111', team_member_id: 'tm-1', name: 'Ana', employment_type: 'w2', classification: 'hourly_recorded' };

function shift(id: string, date: string, startHour: number, hours: number, extra: Partial<ClockShift> = {}): ClockShift {
  const start = Date.parse(`${date}T00:00:00Z`) + startHour * 3_600_000;
  return {
    id,
    employee_id: EMP.id,
    team_member_id: 'tm-1',
    work_date: date,
    clock_in_at: new Date(start).toISOString(),
    clock_out_at: new Date(start + hours * 3_600_000).toISOString(),
    breaks: [],
    ...extra,
  };
}

const base = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  employees: [EMP],
  shifts: [],
  payroll: [],
  pwSegments: [],
  overtime: null,
  prevailingWage: null,
  breakSettings: null,
  breakReviews: [],
  reviews: [],
  now: Date.parse(`${day(10)}T12:00:00Z`),
  ...over,
});

const FED: OvertimeParams = getOvertimePack('FED')!.params;
const CA: OvertimeParams = getOvertimePack('CA')!.params;
const codes = (i: EvaluateInput) => evaluateLaborSignals(i).signals.map((s) => s.code);

describe('date helpers', () => {
  it('finds the workweek start for any start day', () => {
    expect(weekStartOf('2027-03-04', 1)).toBe('2027-03-01'); // Thu -> Mon
    expect(weekStartOf('2027-03-01', 1)).toBe('2027-03-01');
    expect(weekStartOf('2027-03-07', 1)).toBe('2027-03-01'); // Sun belongs to the Monday week
    expect(weekStartOf('2027-03-07', 0)).toBe('2027-03-07'); // Sunday-start week
  });
  it('adds days across month and DST boundaries', () => {
    expect(addDays('2027-03-30', 3)).toBe('2027-04-02');
    expect(addDays('2027-03-13', 2)).toBe('2027-03-15');
  });
});

describe('netMinutes', () => {
  it('removes closed breaks and ignores open shifts', () => {
    const s = shift('s', MON, 8, 8, { breaks: [{ started_at: `${MON}T12:00:00Z`, ended_at: `${MON}T12:30:00Z` }] });
    expect(netMinutes(s)).toBe(450);
    expect(netMinutes({ ...s, clock_out_at: null })).toBe(0);
  });
  it('returns 0 for impossible or garbage timestamps', () => {
    expect(netMinutes({ clock_in_at: 'x', clock_out_at: 'y', breaks: [] })).toBe(0);
    expect(netMinutes({ clock_in_at: `${MON}T10:00:00Z`, clock_out_at: `${MON}T09:00:00Z`, breaks: [] })).toBe(0);
  });
});

describe('thresholdHours', () => {
  it('weekly only: hours beyond the weekly threshold', () => {
    const days = [0, 1, 2, 3, 4].map((i) => ({ date: day(i), hours: 9 })); // 45h
    expect(thresholdHours(days, FED)).toEqual({ otHours: 5, dtHours: 0 });
  });
  it('daily tiers do not double count with the weekly threshold', () => {
    // 5 days x 10h = 50h. Daily OT: 2h x 5 = 10h. Regular = 8h x 5 = 40h -> no extra weekly OT.
    const days = [0, 1, 2, 3, 4].map((i) => ({ date: day(i), hours: 10 }));
    expect(thresholdHours(days, CA)).toEqual({ otHours: 10, dtHours: 0 });
  });
  it('second daily tier', () => {
    expect(thresholdHours([{ date: MON, hours: 14 }], CA)).toEqual({ otHours: 4, dtHours: 2 });
  });
  it('regular hours past the weekly threshold become overtime', () => {
    const days = [0, 1, 2, 3, 4, 5].map((i) => ({ date: day(i), hours: 8 })); // 48h, no daily excess
    expect(thresholdHours(days, CA)).toEqual({ otHours: 8, dtHours: 0 });
  });
});

describe('overtime signals', () => {
  it('no configuration -> no overtime signals', () => {
    expect(codes(base({ shifts: [shift('a', MON, 6, 14)] }))).toEqual([]);
  });
  it('weekly threshold signal with facts, and none exactly at the threshold', () => {
    const over = [0, 1, 2, 3, 4].map((i) => shift(`o${i}`, day(i), 8, 9));
    const r = evaluateLaborSignals(base({ overtime: FED, shifts: over }));
    const w = r.signals.find((s) => s.code === 'weekly_hours_above_threshold');
    expect(w?.facts).toEqual({ hours: 45, threshold: 40 });
    expect(w?.anchorDate).toBe(MON);
    const at = [0, 1, 2, 3, 4].map((i) => shift(`a${i}`, day(i), 8, 8));
    expect(codes(base({ overtime: FED, shifts: at }))).toEqual([]);
  });
  it('daily threshold signal (CA pack) incl. second tier fact', () => {
    const r = evaluateLaborSignals(base({ overtime: CA, shifts: [shift('a', MON, 6, 13)] }));
    const d = r.signals.find((s) => s.code === 'daily_hours_above_threshold');
    expect(d?.facts).toEqual({ hours: 13, threshold: 8, secondTier: 12 });
  });
  it('payroll overtime below what the clock shows is flagged; matching payroll is not', () => {
    const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 8, 9)); // 45h -> 5h above 40
    const gap = evaluateLaborSignals(base({ overtime: FED, shifts, payroll: [{ employee_id: EMP.id, work_date: day(4), overtime_hours: 2 }] }));
    expect(gap.signals.find((s) => s.code === 'payroll_overtime_below_clock')?.facts).toEqual({ clockHours: 5, payrollHours: 2, gap: 3 });
    const ok = evaluateLaborSignals(base({ overtime: FED, shifts, payroll: [{ employee_id: EMP.id, work_date: day(4), overtime_hours: 5 }] }));
    expect(ok.signals.some((s) => s.code === 'payroll_overtime_below_clock')).toBe(false);
  });
  it('payroll overtime above the clock is never flagged (manual rows are legitimate)', () => {
    const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 8, 9));
    const r = evaluateLaborSignals(base({ overtime: FED, shifts, payroll: [{ employee_id: EMP.id, work_date: day(4), overtime_hours: 9 }] }));
    expect(r.signals.some((s) => s.code === 'payroll_overtime_below_clock')).toBe(false);
  });
  it('tolerance suppresses tiny gaps', () => {
    const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 8, 9));
    const r = evaluateLaborSignals(base({ overtime: { ...FED, payroll_gap_tolerance_hours: 6 }, shifts }));
    expect(r.signals.some((s) => s.code === 'payroll_overtime_below_clock')).toBe(false);
  });
  it('seventh day: only when all 7 days of the workweek have time', () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => shift(`s${i}`, day(i), 8, 4));
    expect(codes(base({ overtime: CA, shifts: six }))).not.toContain('seventh_day_clocked');
    const seven = [...six, shift('s6', day(6), 8, 4)];
    const sig = evaluateLaborSignals(base({ overtime: CA, shifts: seven })).signals.find((s) => s.code === 'seventh_day_clocked');
    expect(sig?.anchorDate).toBe(day(6));
    expect(codes(base({ overtime: { ...CA, seventh_day_signal: false }, shifts: seven }))).not.toContain('seventh_day_clocked');
  });
  it('workweek start day moves the week boundary', () => {
    // Sat+Sun+Mon..Wed... with a Sunday workweek these 4 x 11h days fall into different weeks than Monday-based
    const shifts = [day(5), day(6), day(7), day(8)].map((d, i) => shift(`s${i}`, d, 8, 11)); // Sat, Sun, Mon, Tue
    const mondayWeek = evaluateLaborSignals(base({ overtime: { ...FED, weekly_threshold_hours: 30 }, shifts }));
    const sundayWeek = evaluateLaborSignals(base({ overtime: { ...FED, weekly_threshold_hours: 30, workweek_start_dow: 0 }, shifts }));
    expect(mondayWeek.signals.filter((s) => s.code === 'weekly_hours_above_threshold')).toHaveLength(0); // 22h + 22h
    expect(sundayWeek.signals.filter((s) => s.code === 'weekly_hours_above_threshold')).toHaveLength(1); // Sun+Mon+Tue = 33h
  });
  it('long open shift is flagged, a short one is not; open shifts add no hours', () => {
    const now = Date.parse(`${day(1)}T12:00:00Z`);
    const longOpen = shift('o', MON, 8, 1, { clock_out_at: null });
    const r = evaluateLaborSignals(base({ overtime: FED, shifts: [longOpen], now }));
    expect(r.signals.map((s) => s.code)).toEqual(['open_shift_long']);
    const recent = shift('o2', day(1), 8, 1, { clock_out_at: null });
    expect(codes(base({ overtime: FED, shifts: [recent], now }))).toEqual([]);
  });
});

describe('classification', () => {
  it('flags clock use by a worker recorded as contractor or exempt, once per month, and skips hour signals', () => {
    const exempt: EmployeeInput = { ...EMP, classification: 'exempt_recorded' };
    const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 6, 11));
    const r = evaluateLaborSignals(base({ employees: [exempt], overtime: CA, shifts }));
    expect(r.signals.map((s) => s.code)).toEqual(['classification_with_clock_use']);
    expect(r.signals[0].facts.shifts).toBe(5);
    expect(r.signals[0].anchorDate).toBe('2027-03-01');
    expect(r.excludedEmployeeIds).toEqual([EMP.id]);
  });
  it('treats a 1099 payroll record like a recorded contractor', () => {
    const c: EmployeeInput = { ...EMP, employment_type: '1099', classification: 'unreviewed' };
    expect(isHourSignalExcluded(c.classification, c.employment_type)).toBe(true);
    expect(codes(base({ employees: [c], shifts: [shift('a', MON, 8, 6)] }))).toEqual(['classification_with_clock_use']);
  });
  it('unreviewed and hourly records are evaluated normally', () => {
    expect(isHourSignalExcluded('unreviewed', 'w2')).toBe(false);
    expect(isHourSignalExcluded('hourly_recorded', 'w2')).toBe(false);
    expect(isHourSignalExcluded('apprentice_recorded', 'w2')).toBe(false);
  });
  it('shifts of an unknown employee are ignored, never guessed', () => {
    expect(codes(base({ overtime: CA, shifts: [{ ...shift('a', MON, 6, 14), employee_id: 'nope' }] }))).toEqual([]);
  });
});

describe('prevailing-wage data checks', () => {
  const seg = (over: Partial<PwSegment>): PwSegment => ({ employee_id: EMP.id, job_id: 'job-1', work_date: MON, minutes: 240, classification: 'Electrician', paid_cents: 5000, table_cents: 4000, ...over });
  it('not configured -> nothing', () => {
    expect(codes(base({ pwSegments: [seg({ classification: null })] }))).toEqual([]);
  });
  it('missing classification groups jobs per day', () => {
    const r = evaluateLaborSignals(base({ prevailingWage: DEFAULT_PW_PARAMS, pwSegments: [seg({ classification: null }), seg({ classification: null, job_id: 'job-2', minutes: 60 })] }));
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].code).toBe('pw_classification_missing');
    expect(r.signals[0].facts).toEqual({ jobs: 2, hours: 5 });
  });
  it('pay below the table, not at or above it, and not when no table row matches', () => {
    expect(codes(base({ prevailingWage: DEFAULT_PW_PARAMS, pwSegments: [seg({ paid_cents: 3999 })] }))).toEqual(['pw_pay_below_table']);
    expect(codes(base({ prevailingWage: DEFAULT_PW_PARAMS, pwSegments: [seg({ paid_cents: 4000 })] }))).toEqual([]);
    expect(codes(base({ prevailingWage: DEFAULT_PW_PARAMS, pwSegments: [seg({ table_cents: null })] }))).toEqual([]);
    expect(codes(base({ prevailingWage: DEFAULT_PW_PARAMS, pwSegments: [seg({ paid_cents: null })] }))).toEqual([]);
  });
  it('each check can be switched off', () => {
    expect(codes(base({ prevailingWage: { check_missing_classification: false, check_rate_below_table: true }, pwSegments: [seg({ classification: null })] }))).toEqual([]);
    expect(codes(base({ prevailingWage: { check_missing_classification: true, check_rate_below_table: false }, pwSegments: [seg({ paid_cents: 1 })] }))).toEqual([]);
  });
});

describe('break signals reuse the existing engine', () => {
  const long = shift('b1', MON, 8, 8); // 8h with no break at all
  it('maps open violations, read-only', () => {
    const r = evaluateLaborSignals(base({ breakSettings: DEFAULT_SETTINGS, shifts: [long] }));
    const b = r.signals.filter((s) => s.topic === 'breaks');
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((s) => s.readOnly && s.key.startsWith('break:b1:'))).toBe(true);
  });
  it('a reviewed break violation is not raised again', () => {
    const all = evaluateLaborSignals(base({ breakSettings: DEFAULT_SETTINGS, shifts: [long] })).signals;
    const reviews = all.map((s) => ({ shift_id: 'b1', code: s.code.replace('break_', '') as 'meal_missing', status: 'waived' as const, note: null }));
    expect(evaluateLaborSignals(base({ breakSettings: DEFAULT_SETTINGS, shifts: [long], breakReviews: reviews })).signals).toHaveLength(0);
  });
  it('disabled or missing break settings -> none', () => {
    expect(codes(base({ breakSettings: null, shifts: [long] }))).toEqual([]);
    expect(codes(base({ breakSettings: { ...DEFAULT_SETTINGS, enabled: false }, shifts: [long] }))).toEqual([]);
  });
});

describe('window', () => {
  it('drops day signals before the requested first day but keeps the week that overlaps it', () => {
    const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 8, 9)); // weekly signal anchored on MON
    const keepsWeek = evaluateLaborSignals(base({ overtime: CA, shifts, windowFrom: day(4) }));
    expect(keepsWeek.signals.some((s) => s.code === 'weekly_hours_above_threshold')).toBe(true); // week MON..SUN overlaps day(4)
    expect(keepsWeek.signals.some((s) => s.code === 'daily_hours_above_threshold' && s.anchorDate < day(4))).toBe(false);
    const dropsWeek = evaluateLaborSignals(base({ overtime: CA, shifts, windowFrom: day(8) }));
    expect(dropsWeek.signals).toHaveLength(0);
  });
});

describe('reviews, ordering, summary', () => {
  const shifts = [0, 1, 2, 3, 4].map((i) => shift(`s${i}`, day(i), 8, 9));
  it('applies a saved review and orders open signals first', () => {
    const first = evaluateLaborSignals(base({ overtime: CA, shifts })).signals;
    const key = first.find((s) => s.code === 'weekly_hours_above_threshold')!.key;
    const r = evaluateLaborSignals(base({ overtime: CA, shifts, reviews: [{ signal_key: key, status: 'sent_to_counsel', note: 'asked' }] }));
    const reviewed = r.signals.find((s) => s.key === key)!;
    expect(reviewed.status).toBe('sent_to_counsel');
    expect(reviewed.note).toBe('asked');
    const firstReviewedIdx = r.signals.findIndex((s) => s.status !== 'open');
    const lastOpenIdx = r.signals.map((s) => s.status).lastIndexOf('open');
    expect(lastOpenIdx).toBeLessThan(firstReviewedIdx === -1 ? Infinity : firstReviewedIdx);
  });
  it('keys are stable across re-evaluation and match the server key shape', () => {
    const a = evaluateLaborSignals(base({ overtime: CA, shifts })).signals.filter((s) => !s.readOnly);
    const b = evaluateLaborSignals(base({ overtime: CA, shifts })).signals.filter((s) => !s.readOnly);
    expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
    expect(a.every((s) => REVIEWABLE_KEY_RE.test(s.key))).toBe(true);
    expect(REVIEWABLE_KEY_RE.test('x:not-a-uuid:2027-03-01')).toBe(false);
  });
  it('summarizes and filters', () => {
    const sigs = evaluateLaborSignals(base({ overtime: CA, shifts })).signals;
    const sum = summarizeSignals(sigs);
    expect(sum.open).toBe(sigs.length);
    expect(sum.byTopic.overtime).toBe(sigs.length);
    expect(sum.byEmployee).toEqual([{ employeeId: EMP.id, open: sigs.length }]);
    expect(filterSignals(sigs, 'other', 'all', 'all')).toHaveLength(0);
    expect(filterSignals(sigs, 'all', 'prevailing_wage', 'all')).toHaveLength(0);
    expect(filterSignals(sigs, EMP.id, 'overtime', 'open')).toHaveLength(sigs.length);
  });
  it('defaults are well-formed', () => {
    expect(DEFAULT_OVERTIME_PARAMS.weekly_threshold_hours).toBe(40);
  });
});
