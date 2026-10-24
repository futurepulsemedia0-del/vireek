import { describe, expect, it } from 'vitest';
import {
  addDays,
  allocateProportional,
  bucketWeek,
  computeCertifiedPayroll,
  dayOfWeek,
  dayPremiumX100,
  formatHours,
  isIsoDate,
  parseMoneyToCents,
  resolveRate,
  validateRateInput,
  validateRuleSetInput,
  workweekEnding,
  workweekStart,
  type ComputeInput,
  type OvertimeRuleSet,
  type WageRate,
} from './prevailingWage';

const rules = (over: Partial<OvertimeRuleSet> = {}): OvertimeRuleSet => ({
  id: 'rs1',
  name: 'Federal',
  workweekStartDow: 1, // Monday
  dailyOtAfter: null,
  dailyDtAfter: null,
  weeklyOtAfter: 40,
  seventhDayRule: 'none',
  seventhDayOtHours: 8,
  otMultiplier: 1.5,
  dtMultiplier: 2,
  saturdayMultiplier: null,
  sundayMultiplier: null,
  holidayMultiplier: null,
  holidays: [],
  fringeOvertimeMode: 'straight',
  legalReviewStatus: 'approved',
  ...over,
});

const rate = (over: Partial<WageRate> = {}): WageRate => ({
  id: 'r1',
  classification: 'Electrician',
  effectiveFrom: '2027-01-01',
  effectiveTo: null,
  baseRateCents: 4500,
  fringeCents: 1500,
  isApprentice: false,
  otMultiplierOverride: null,
  ...over,
});

// Week: Mon 2027-03-01 … Sun 2027-03-07
const WEEK_END = '2027-03-07';
const D = ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05', '2027-03-06', '2027-03-07'];

const entry = (id: string, date: string, hours: number, jobId: string | null = 'jobA', employeeId = 'e1') => ({
  id,
  employeeId,
  workDate: date,
  hours,
  jobId,
});

const input = (over: Partial<ComputeInput> = {}): ComputeInput => ({
  jobId: 'jobA',
  weekEnding: WEEK_END,
  rules: rules(),
  determination: { id: 'd1', name: 'WD', effectiveFrom: '2027-01-01', effectiveTo: null, legalReviewStatus: 'approved' },
  rates: [rate()],
  entries: [],
  workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Electrician' }],
  jobWorkerClasses: [],
  ...over,
});

const forty = () => D.slice(0, 5).map((d, i) => entry(`t${i}`, d, 8));

describe('date helpers', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-30')).toBe(false);
    expect(isIsoDate('2027-2-3')).toBe(false);
    expect(isIsoDate(20270228)).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('finds workweek boundaries for any start day', () => {
    expect(dayOfWeek('2027-03-01')).toBe(1);
    expect(workweekStart('2027-03-04', 1)).toBe('2027-03-01');
    expect(workweekEnding('2027-03-04', 1)).toBe('2027-03-07');
    expect(workweekStart('2027-03-07', 0)).toBe('2027-03-07'); // Sunday-start week
    expect(workweekEnding('2027-03-01', 0)).toBe('2027-03-06');
  });
});

describe('number helpers', () => {
  it('allocates exactly with largest remainder, ties to the earlier index', () => {
    expect(allocateProportional(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateProportional(100, [600, 400])).toEqual([60, 40]);
    expect(allocateProportional(0, [1, 2])).toEqual([0, 0]);
    expect(allocateProportional(5, [0, 0])).toEqual([0, 0]);
    const out = allocateProportional(12345, [17, 31, 53, 7]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(12345);
  });

  it('parses money into integer cents', () => {
    expect(parseMoneyToCents('45')).toBe(4500);
    expect(parseMoneyToCents('$1,234.5')).toBe(123450);
    expect(parseMoneyToCents('45.99')).toBe(4599);
    expect(parseMoneyToCents('-5')).toBeNull();
    expect(parseMoneyToCents('4.999')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
  });

  it('formats hours without trailing zeros', () => {
    expect(formatHours(8)).toBe('8');
    expect(formatHours(7.5)).toBe('7.5');
    expect(formatHours(0)).toBe('0');
    expect(formatHours(1.2)).toBe('1.2');
  });
});

describe('bucketWeek', () => {
  it('federal 40-hour rule: overtime lands on the hours past 40', () => {
    const b = bucketWeek([800, 800, 800, 800, 800, 400, 0], rules());
    expect(b[4]).toEqual({ st: 800, ot: 0, dt: 0 });
    expect(b[5]).toEqual({ st: 0, ot: 400, dt: 0 });
  });

  it('daily overtime and double-time', () => {
    const b = bucketWeek([1300, 0, 0, 0, 0, 0, 0], rules({ dailyOtAfter: 8, dailyDtAfter: 12 }));
    expect(b[0]).toEqual({ st: 800, ot: 400, dt: 100 });
  });

  it('does not pyramid daily overtime into the weekly threshold', () => {
    const b = bucketWeek([1000, 1000, 1000, 1000, 0, 0, 0], rules({ dailyOtAfter: 8 }));
    expect(b.slice(0, 4).every((x) => x.st === 800 && x.ot === 200)).toBe(true);
  });

  it('seventh consecutive day: overtime for the first N hours, double-time after', () => {
    const b = bucketWeek([900, 900, 900, 900, 900, 900, 900], rules({ dailyOtAfter: 8, seventhDayRule: 'ot_first_dt_after' }));
    expect(b[5]).toEqual({ st: 0, ot: 900, dt: 0 });
    expect(b[6]).toEqual({ st: 0, ot: 800, dt: 100 });
  });

  it('seventh-day rule needs all seven days worked', () => {
    const b = bucketWeek([800, 800, 800, 800, 800, 800, 0], rules({ seventhDayRule: 'ot_first_dt_after' }));
    expect(b[6]).toEqual({ st: 0, ot: 0, dt: 0 });
  });
});

describe('dayPremiumX100', () => {
  const r = rules({ saturdayMultiplier: 1.25, sundayMultiplier: 1.5, holidayMultiplier: 2, holidays: ['2027-03-03'] });
  it('picks the highest applicable multiplier and never stacks', () => {
    expect(dayPremiumX100('2027-03-06', r)).toBe(125); // Saturday
    expect(dayPremiumX100('2027-03-07', r)).toBe(150); // Sunday
    expect(dayPremiumX100('2027-03-03', r)).toBe(200); // holiday (Wednesday)
    expect(dayPremiumX100('2027-03-02', r)).toBe(100);
  });
});

describe('resolveRate', () => {
  const rs = [rate({ id: 'old', effectiveTo: '2027-06-30', baseRateCents: 4000 }), rate({ id: 'new', effectiveFrom: '2027-07-01', baseRateCents: 4200 })];
  it('selects the rate effective on the date, case/space-insensitive', () => {
    expect(resolveRate(rs, '  electrician ', '2027-06-30')?.id).toBe('old');
    expect(resolveRate(rs, 'ELECTRICIAN', '2027-07-01')?.id).toBe('new');
    expect(resolveRate(rs, 'Electrician', '2026-12-31')).toBeNull();
    expect(resolveRate(rs, 'Plumber', '2027-07-01')).toBeNull();
  });
});

describe('computeCertifiedPayroll — pay', () => {
  it('prices straight time: base + cash fringe', () => {
    const r = computeCertifiedPayroll(input({ entries: forty() }));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ hourType: 'ST', hours: 40, cashHourlyCents: 6000, grossCashCents: 240000, fringePlanCents: 0 });
    expect(r.totals.grossCashCents).toBe(240000);
    expect(r.totals.workerCount).toBe(1);
    expect(r.weekStart).toBe('2027-03-01');
  });

  it('credits fringe paid to a bona fide plan and pays the rest in cash', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Electrician', fringePlanCentsPerHour: 1000 }] }));
    expect(r.lines[0]).toMatchObject({ cashHourlyCents: 5000, fringePlanHourlyCents: 1000, grossCashCents: 200000, fringePlanCents: 40000 });
    expect(r.totals.fringeCashCents).toBe(20000);
    expect(r.totals.totalCompCents).toBe(240000);
  });

  it('caps plan credit at the required fringe', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Electrician', fringePlanCentsPerHour: 9999 }] }));
    expect(r.lines[0]).toMatchObject({ fringePlanHourlyCents: 1500, fringeCashHourlyCents: 0, cashHourlyCents: 4500 });
  });

  it('overtime premium applies to base only; fringe stays straight-time', () => {
    const r = computeCertifiedPayroll(input({ entries: [...forty(), entry('t5', D[5], 4)] }));
    const ot = r.lines.find((l) => l.hourType === 'OT');
    expect(ot).toMatchObject({ hours: 4, multiplierX100: 150, cashHourlyCents: 8250, grossCashCents: 33000 });
    expect(r.totals.grossCashCents).toBe(240000 + 33000);
    expect(r.totals.premiumHours).toBe(4);
  });

  it('"multiplied" fringe mode scales fringe with the overtime multiplier', () => {
    const r = computeCertifiedPayroll(input({ rules: rules({ fringeOvertimeMode: 'multiplied' }), entries: [...forty(), entry('t5', D[5], 4)] }));
    expect(r.lines.find((l) => l.hourType === 'OT')).toMatchObject({ cashHourlyCents: 9000, grossCashCents: 36000 });
  });

  it('honours a per-classification overtime multiplier override', () => {
    const r = computeCertifiedPayroll(input({ rates: [rate({ otMultiplierOverride: 2 })], entries: [...forty(), entry('t5', D[5], 4)] }));
    expect(r.lines.find((l) => l.hourType === 'OT')).toMatchObject({ multiplierX100: 200, cashHourlyCents: 10500 });
  });

  it('pays the higher rate on file and shows it', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Electrician', hourlyRateCents: 7000 }] }));
    expect(r.lines[0]).toMatchObject({ paidBaseCents: 5500, cashHourlyCents: 7000, grossCashCents: 280000 });
    expect(r.warnings.some((w) => w.code === 'RATE_BELOW_PREVAILING')).toBe(false);
  });

  it('flags a rate on file below prevailing and prices at the required rate', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Electrician', hourlyRateCents: 5000 }] }));
    expect(r.lines[0].cashHourlyCents).toBe(6000);
    expect(r.warnings.find((w) => w.code === 'RATE_BELOW_PREVAILING')?.severity).toBe('warning');
  });

  it('weekend/holiday premium is reported as PREM and never stacks with overtime', () => {
    const holiday = computeCertifiedPayroll(
      input({ rules: rules({ holidays: ['2027-03-01'], holidayMultiplier: 1.5 }), entries: [entry('h', '2027-03-01', 8)] }),
    );
    expect(holiday.lines[0]).toMatchObject({ hourType: 'PREM', multiplierX100: 150, cashHourlyCents: 8250, grossCashCents: 66000 });
  });

  it('applies the effective-dated rate on each work date', () => {
    const rs = [rate({ id: 'old', effectiveTo: '2027-06-30', baseRateCents: 4000, fringeCents: 0 }), rate({ id: 'new', effectiveFrom: '2027-07-01', baseRateCents: 4200, fringeCents: 0 })];
    const r = computeCertifiedPayroll(input({ weekEnding: '2027-07-04', rates: rs, entries: [entry('a', '2027-06-30', 8), entry('b', '2027-07-01', 8)] }));
    expect(r.lines.map((l) => [l.rateId, l.grossCashCents]).sort()).toEqual([['new', 33600], ['old', 32000]]);
  });

  it('uses the job-level classification that is effective on the date', () => {
    const rs = [rate({ id: 'lab', classification: 'Laborer', baseRateCents: 3000, fringeCents: 0 }), rate({ id: 'ele', baseRateCents: 4500, fringeCents: 0 })];
    const r = computeCertifiedPayroll(
      input({
        weekEnding: '2027-07-04',
        rates: rs,
        workers: [{ employeeId: 'e1', name: 'Ana Ruiz', defaultClassification: 'Laborer' }],
        jobWorkerClasses: [{ employeeId: 'e1', classification: 'Electrician', effectiveFrom: '2027-06-30' }],
        entries: [entry('a', '2027-06-29', 8), entry('b', '2027-06-30', 8)],
      }),
    );
    expect(r.lines.map((l) => [l.classification, l.grossCashCents]).sort()).toEqual([['Electrician', 36000], ['Laborer', 24000]]);
  });
});

describe('computeCertifiedPayroll — hours across jobs', () => {
  it('pools hours across every job when finding the weekly threshold', () => {
    const entries = [
      entry('a1', D[0], 10), entry('a2', D[1], 10), entry('a3', D[2], 10),
      entry('b1', D[3], 8, 'jobB'), entry('b2', D[4], 7, 'jobB'),
    ];
    const jobA = computeCertifiedPayroll(input({ entries }));
    expect(jobA.lines.map((l) => l.hourType)).toEqual(['ST']);
    expect(jobA.totals.hours).toBe(30);
    const jobB = computeCertifiedPayroll(input({ jobId: 'jobB', entries }));
    expect(jobB.lines.find((l) => l.hourType === 'OT')?.hours).toBe(5);
  });

  it('shares a day’s overtime across jobs in proportion to hours', () => {
    const entries = [entry('a1', D[1], 6, 'jobA'), entry('b1', D[1], 4, 'jobB')];
    const r = computeCertifiedPayroll(input({ rules: rules({ dailyOtAfter: 8 }), entries }));
    expect(r.entryResults).toHaveLength(1);
    expect(r.entryResults[0].hoursByType).toMatchObject({ ST: 4.8, OT: 1.2 });
  });

  it('entry-level pay always reconciles to line-level pay, to the cent', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 25; run++) {
      const entries = [];
      for (let i = 0; i < 12; i++) entries.push(entry(`t${run}-${i}`, D[Math.floor(rnd() * 7)], Math.round(rnd() * 600) / 100 + 0.25, rnd() > 0.4 ? 'jobA' : 'jobB'));
      const r = computeCertifiedPayroll(input({ rules: rules({ dailyOtAfter: 8, saturdayMultiplier: 1.25 }), entries, workers: [{ employeeId: 'e1', name: 'Ana', defaultClassification: 'Electrician', fringePlanCentsPerHour: 777 }] }));
      expect(r.entryResults.reduce((s, e) => s + e.grossCashCents, 0)).toBe(r.totals.grossCashCents);
      expect(r.entryResults.reduce((s, e) => s + e.fringePlanCents, 0)).toBe(r.totals.fringePlanCents);
      expect(Math.round(r.entryResults.reduce((s, e) => s + e.hours, 0) * 100)).toBe(Math.round(r.totals.hours * 100));
    }
  });

  it('is deterministic regardless of input order', () => {
    const entries = [entry('x3', D[2], 5, 'jobA'), entry('x1', D[2], 4, 'jobB'), entry('x2', D[2], 3, 'jobA'), entry('x4', D[0], 9, 'jobA')];
    const a = computeCertifiedPayroll(input({ rules: rules({ dailyOtAfter: 8 }), entries }));
    const b = computeCertifiedPayroll(input({ rules: rules({ dailyOtAfter: 8 }), entries: [...entries].reverse() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('ignores rows outside the reported week and notes it', () => {
    const r = computeCertifiedPayroll(input({ entries: [entry('x', '2027-03-08', 8), ...forty()] }));
    expect(r.totals.hours).toBe(40);
    expect(r.warnings.some((w) => w.code === 'OUT_OF_WEEK')).toBe(true);
  });
});

describe('computeCertifiedPayroll — problems and certification gate', () => {
  it('blocks certification when a worker has no classification and does not price the hours', () => {
    const r = computeCertifiedPayroll(input({ workers: [{ employeeId: 'e1', name: 'Ana Ruiz' }], entries: forty() }));
    expect(r.lines).toHaveLength(0);
    expect(r.totals.unresolvedHours).toBe(40);
    expect(r.warnings.find((w) => w.code === 'NO_CLASSIFICATION')?.severity).toBe('error');
    expect(r.entryResults.every((e) => e.status === 'no_classification')).toBe(true);
    expect(r.certifyBlockers.length).toBeGreaterThan(0);
  });

  it('flags a classification that is missing from the wage table', () => {
    const r = computeCertifiedPayroll(input({ rates: [rate({ classification: 'Plumber' })], entries: forty() }));
    expect(r.warnings.some((w) => w.code === 'NO_RATE')).toBe(true);
    expect(r.entryResults.every((e) => e.status === 'no_rate')).toBe(true);
  });

  it('rejects impossible days (more than 24 hours)', () => {
    const r = computeCertifiedPayroll(input({ entries: [entry('a', D[0], 14), entry('b', D[0], 12)] }));
    expect(r.warnings.some((w) => w.code === 'DAY_OVER_24' && w.severity === 'error')).toBe(true);
  });

  it('requires both the wage table and the rule set to be legally reviewed', () => {
    const unreviewed = computeCertifiedPayroll(
      input({ entries: forty(), rules: rules({ legalReviewStatus: 'in_review' }), determination: { id: 'd1', name: 'WD', effectiveFrom: '2027-01-01', effectiveTo: null, legalReviewStatus: 'unreviewed' } }),
    );
    expect(unreviewed.certifyBlockers).toHaveLength(2);
    const ok = computeCertifiedPayroll(input({ entries: forty() }));
    expect(ok.certifyBlockers).toEqual([]);
  });

  it('warns about pending timesheets, mixed rule sets and apprentices', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), pendingEntryCount: 3, mixedRuleSets: true, rates: [rate({ isApprentice: true })] }));
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['PENDING_TIMESHEETS', 'MIXED_RULE_SETS', 'APPRENTICE_VERIFY']));
  });

  it('warns when the work date is outside the determination window', () => {
    const r = computeCertifiedPayroll(input({ entries: forty(), determination: { id: 'd1', name: 'WD', effectiveFrom: '2027-04-01', effectiveTo: null, legalReviewStatus: 'approved' } }));
    expect(r.warnings.some((w) => w.code === 'DETERMINATION_WINDOW')).toBe(true);
  });
});

describe('validators', () => {
  const base = { name: 'x', workweekStartDow: 0, dailyOtAfter: null, dailyDtAfter: null, weeklyOtAfter: 40, seventhDayRule: 'none' as const, seventhDayOtHours: 8, otMultiplier: 1.5, dtMultiplier: 2, saturdayMultiplier: null, sundayMultiplier: null, holidayMultiplier: null, holidays: [], fringeOvertimeMode: 'straight' as const };
  it('accepts a sane rule set and rejects nonsense', () => {
    expect(validateRuleSetInput(base)).toBeNull();
    expect(validateRuleSetInput({ ...base, name: ' ' })).toMatch(/name/i);
    expect(validateRuleSetInput({ ...base, dailyOtAfter: 10, dailyDtAfter: 8 })).toMatch(/after overtime/i);
    expect(validateRuleSetInput({ ...base, otMultiplier: 0.5 })).toMatch(/multiplier/i);
    expect(validateRuleSetInput({ ...base, holidays: ['nope'] })).toMatch(/holidays/i);
  });

  it('validates rate rows', () => {
    const ok = { classification: 'Electrician', baseRateCents: 4500, fringeCents: 1500, effectiveFrom: '2027-01-01', effectiveTo: null, otMultiplierOverride: null };
    expect(validateRateInput(ok)).toBeNull();
    expect(validateRateInput({ ...ok, classification: '' })).toMatch(/classification/i);
    expect(validateRateInput({ ...ok, baseRateCents: null })).toMatch(/base/i);
    expect(validateRateInput({ ...ok, effectiveTo: '2026-12-31' })).toMatch(/effective-to/i);
  });
});
