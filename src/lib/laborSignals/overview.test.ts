import { describe, expect, it } from 'vitest';
import { RANGES, parseOverview, windowFor } from './overview';
import { DEFAULT_OVERTIME_PARAMS } from './rules';

describe('parseOverview', () => {
  it('turns null / garbage into an empty, safe overview (never throws)', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}]) {
      const o = parseOverview(bad);
      expect(o.employees).toEqual([]);
      expect(o.shifts).toEqual([]);
      expect(o.overtime).toBeNull();
      expect(o.prevailingWage).toBeNull();
      expect(o.breakSettings).toBeNull();
      expect(o.canEdit).toBe(false);
    }
  });
  it('drops malformed rows and normalises unknown enum values', () => {
    const o = parseOverview({
      can_edit: true,
      employees: [{ id: 'e1', name: 'Ana', employment_type: 'weird', classification: 'made_up', team_member_id: 't1' }, { name: 'no id' }],
      shifts: [{ id: 's1', employee_id: 'e1', team_member_id: 't1', work_date: '2027-03-01T00:00:00Z', clock_in_at: '2027-03-01T08:00:00Z', clock_out_at: null, breaks: [{ started_at: 'x', ended_at: null }, {}] }, { id: 'bad' }],
      payroll: [{ employee_id: 'e1', work_date: '2027-03-01', overtime_hours: '2.5' }, { employee_id: 'e1' }],
      pw_segments: [{ employee_id: 'e1', job_id: 'j', work_date: '2027-03-01', minutes: 60, classification: '', paid_cents: 5000, table_cents: null }],
      reviews: [{ signal_key: 'k', status: 'acknowledged', note: 'n' }, { signal_key: 'k2', status: 'open' }],
      break_reviews: [{ shift_id: 's1', code: 'meal_missing', status: 'waived' }, { shift_id: 's1', code: 'nope', status: 'waived' }],
    });
    expect(o.canEdit).toBe(true);
    expect(o.employees).toHaveLength(1);
    expect(o.employees[0].employment_type).toBe('w2');
    expect(o.employees[0].classification).toBe('unreviewed');
    expect(o.shifts).toHaveLength(1);
    expect(o.shifts[0].work_date).toBe('2027-03-01');
    expect(o.shifts[0].breaks).toHaveLength(1);
    expect(o.payroll).toEqual([{ employee_id: 'e1', work_date: '2027-03-01', overtime_hours: 2.5 }]);
    expect(o.pwSegments[0].classification).toBeNull();
    expect(o.pwSegments[0].table_cents).toBeNull();
    expect(o.reviews).toEqual([{ signal_key: 'k', status: 'acknowledged', note: 'n' }]);
    expect(o.breakReviews).toHaveLength(1);
  });
  it('reads rule configs with markers state and falls back to defaults on bad params', () => {
    const o = parseOverview({
      rules: [
        { topic: 'overtime', jurisdiction: 'CA', enabled: true, params: { weekly_threshold_hours: -3 }, counsel_status: 'counsel_reviewed', counsel_reviewed_by: 'X LLP', verified_on: '2027-02-01' },
        { topic: 'prevailing_wage', jurisdiction: 'FED', enabled: false, params: { check_missing_classification: true, check_rate_below_table: false } },
      ],
      break_settings: { enabled: true, jurisdiction: 'CA' },
    });
    expect(o.overtime?.params).toEqual(DEFAULT_OVERTIME_PARAMS);
    expect(o.overtime?.counsel_status).toBe('counsel_reviewed');
    expect(o.overtime?.verified_on).toBe('2027-02-01');
    expect(o.prevailingWage?.enabled).toBe(false);
    expect(o.prevailingWage?.counsel_status).toBe('needs_counsel');
    expect(o.prevailingWage?.verified_on).toBeNull();
    expect(o.breakSettings?.enabled).toBe(true);
    expect(o.breakJurisdiction).toBe('CA');
  });
});

describe('windowFor', () => {
  it('covers the range and pre-loads 6 days for whole workweeks', () => {
    const now = new Date(2027, 2, 15, 12, 0, 0).getTime();
    const w = windowFor(14, now);
    expect(w.to).toBe('2027-03-15');
    expect(w.windowFrom).toBe('2027-03-02');
    expect(w.dataFrom).toBe('2027-02-24');
  });
  it('stays inside the server limit of 120 days for every offered range', () => {
    const now = new Date(2027, 5, 30, 12, 0, 0).getTime();
    for (const d of RANGES) {
      const w = windowFor(d, now);
      const span = (Date.parse(w.to) - Date.parse(w.dataFrom)) / 86_400_000;
      expect(span).toBeLessThan(121);
    }
  });
});
