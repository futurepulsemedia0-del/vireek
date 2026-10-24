import { describe, expect, it } from 'vitest';
import { computeCertifiedPayroll, type ComputeInput, type OvertimeRuleSet } from './prevailingWage';
import {
  RULE_SET_TEMPLATES,
  buildLinesCsv,
  describeRuleSet,
  buildReportSnapshot,
  buildWorkersCsv,
  csvCell,
  netPayCents,
  parseRatesCsv,
  reportFileName,
  type ReportMeta,
} from './prevailingWageExport';
import { validateRuleSetInput } from './prevailingWage';

const rules: OvertimeRuleSet = {
  id: 'rs1', name: 'Federal', workweekStartDow: 1, dailyOtAfter: null, dailyDtAfter: null, weeklyOtAfter: 40,
  seventhDayRule: 'none', seventhDayOtHours: 8, otMultiplier: 1.5, dtMultiplier: 2, saturdayMultiplier: null,
  sundayMultiplier: null, holidayMultiplier: null, holidays: [], fringeOvertimeMode: 'straight', legalReviewStatus: 'approved',
};

const meta: ReportMeta = {
  contractorName: 'Acme Electric, LLC', contractorAddress: '1 Main St', projectName: 'City Hall Retrofit', contractNumber: 'C-100',
  awardingAgency: 'City', primeContractor: 'Prime Co', projectLocation: 'Main St', determinationName: 'WD', determinationNumber: 'X1',
  determinationRevision: '0', program: 'davis_bacon', ruleSetName: 'Federal', isFinal: false, noWork: false,
};

const input: ComputeInput = {
  jobId: 'jobA',
  weekEnding: '2027-03-07',
  rules,
  determination: { id: 'd1', name: 'WD', effectiveFrom: '2027-01-01', effectiveTo: null, legalReviewStatus: 'approved' },
  rates: [{ id: 'r1', classification: 'Electrician', effectiveFrom: '2027-01-01', effectiveTo: null, baseRateCents: 4500, fringeCents: 1500, isApprentice: false, otMultiplierOverride: null }],
  entries: [
    { id: 't1', employeeId: 'e1', workDate: '2027-03-01', hours: 8, jobId: 'jobA' },
    { id: 't2', employeeId: 'e1', workDate: '2027-03-02', hours: 7.5, jobId: 'jobA' },
  ],
  workers: [{ employeeId: 'e1', name: '=HYPERLINK("x")', workerIdLast4: '1234', defaultClassification: 'Electrician' }],
  jobWorkerClasses: [],
};

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
  });
  it('neutralises spreadsheet formulas but keeps numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(null)).toBe('');
  });
});

describe('snapshot + CSV', () => {
  const result = computeCertifiedPayroll(input);
  const snap = buildReportSnapshot(result, rules, meta, { e1: { ficaCents: 1000, withholdingCents: 2000, otherCents: 500 } }, new Date('2027-03-08T10:00:00Z'));

  it('builds a stable snapshot with deductions and net pay', () => {
    expect(snap.generatedAt).toBe('2027-03-08T10:00:00.000Z');
    expect(snap.legalNotice).toMatch(/legal review/i);
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0].netCents).toBe(snap.workers[0].grossCashCents - 3500);
    expect(netPayCents(10000, { ficaCents: 1, withholdingCents: 2, otherCents: 3 })).toBe(9994);
  });

  it('writes a lines CSV with day columns, CRLF endings and a protected worker name', () => {
    const csv = buildLinesCsv(snap, 3);
    const rows = csv.trimEnd().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('2027-03-01');
    expect(rows[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(rows[1]).toContain('Electrician');
    expect(rows[1].startsWith('3,2027-03-07,')).toBe(true);
    expect(rows[1]).toContain('15.5');
    expect(rows[1]).toContain('930.00'); // 15.5h x $60.00
  });

  it('writes a workers CSV with totals and deductions', () => {
    const csv = buildWorkersCsv(snap, 3).trimEnd().split('\r\n');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain('930.00');
    expect(csv[1]).toContain('10.00,20.00,5.00');
  });

  it('makes safe file names', () => {
    expect(reportFileName(snap, 3, 'lines', 'csv')).toBe('certified-payroll-city-hall-retrofit-no3-we2027-03-07-lines.csv');
    expect(reportFileName({ weekEnding: '2027-03-07', meta: { ...meta, projectName: '../../x' } }, 1, 'a', 'pdf')).toBe('certified-payroll-x-no1-we2027-03-07-a.pdf');
  });
});

describe('parseRatesCsv', () => {
  it('parses data, skips a header and defaults the date', () => {
    const r = parseRatesCsv('Classification,Base,Fringe\nElectrician,"$45.50",15\nLaborer,30,10.25,2027-07-01,yes', '2027-01-01');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { classification: 'Electrician', baseRateCents: 4550, fringeCents: 1500, effectiveFrom: '2027-01-01', isApprentice: false },
      { classification: 'Laborer', baseRateCents: 3000, fringeCents: 1025, effectiveFrom: '2027-07-01', isApprentice: true },
    ]);
  });

  it('reports row-level problems and keeps the good rows', () => {
    const r = parseRatesCsv('Plumber,abc,5\n,10,5\nPipefitter,40,5,2027-13-01\nOk,40,5\nOk,41,5', '2027-01-01');
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toHaveLength(4);
    expect(r.errors.join(' ')).toMatch(/Row 1.*base rate/);
    expect(r.errors.join(' ')).toMatch(/listed twice/);
  });

  it('rejects empty input and caps very large pastes', () => {
    expect(parseRatesCsv('   \n', '2027-01-01').errors).toHaveLength(1);
    const big = Array.from({ length: 520 }, (_, i) => `Class ${i},10,1`).join('\n');
    const r = parseRatesCsv(big, '2027-01-01');
    expect(r.rows).toHaveLength(500);
    expect(r.errors).toHaveLength(1);
  });
});

describe('parseRatesCsv — tab separated', () => {
  it('detects tabs pasted from a spreadsheet', () => {
    const r = parseRatesCsv('Electrician\t45\t15\nLaborer\t30\t10', '2027-01-01');
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.baseRateCents)).toEqual([4500, 3000]);
  });
});

describe('templates', () => {
  it('are all valid rule sets', () => {
    for (const t of RULE_SET_TEMPLATES) expect(validateRuleSetInput(t.values)).toBeNull();
  });
});

describe('describeRuleSet', () => {
  it('explains a rule set in plain English', () => {
    const lines = describeRuleSet({ ...rules, dailyOtAfter: 8, dailyDtAfter: 12, seventhDayRule: 'ot_first_dt_after', saturdayMultiplier: 1.25 });
    expect(lines.join(' ')).toMatch(/Workweek starts Monday/);
    expect(lines.join(' ')).toMatch(/Daily: ×1.5 after 8 h, ×2 after 12 h/);
    expect(lines.join(' ')).toMatch(/Seventh consecutive day/);
    expect(lines.join(' ')).toMatch(/Saturday ×1.25/);
    expect(lines.join(' ')).toMatch(/straight-time amount/);
  });
});
