import { describe, it, expect } from 'vitest';
import {
  EMPTY_AVAILABILITY,
  addDays,
  buildAgenda,
  capacityForDays,
  dayOfWeek,
  diffDays,
  findConflicts,
  formatRange,
  isValidIsoDate,
  jobDay,
  monthDays,
  normalizeBlackout,
  normalizeList,
  normalizeTimeOff,
  normalizeWeekly,
  overlappingBlackouts,
  overlappingTimeOff,
  previewConflicts,
  shiftMonth,
  summarizeTimeOff,
  toggleWorkingDay,
  unavailability,
  unavailabilityForTimestamp,
  validateBlackout,
  validateRange,
  validateTimeOff,
  type AvailabilityData,
  type BlackoutEntry,
  type ScheduledJob,
  type TechnicianLite,
  type TimeOffEntry,
} from './timeOff';

function off(over: Partial<TimeOffEntry> = {}): TimeOffEntry {
  return {
    id: 'o1',
    user_id: 'owner',
    technician_id: 'alex',
    kind: 'pto',
    start_date: '2026-06-10',
    end_date: '2026-06-12',
    note: null,
    status: 'approved',
    created_by: 'owner',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function blackout(over: Partial<BlackoutEntry> = {}): BlackoutEntry {
  return {
    id: 'b1',
    user_id: 'owner',
    label: 'Founders Day',
    start_date: '2026-06-19',
    end_date: '2026-06-19',
    status: 'active',
    created_by: 'owner',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const data = (over: Partial<AvailabilityData> = {}): AvailabilityData => ({ ...EMPTY_AVAILABILITY, ...over });

const alex: TechnicianLite = { id: 'alex', member_name: 'Alex', max_jobs_per_day: 4, dispatch_enabled: true };
const sam: TechnicianLite = { id: 'sam', member_name: 'Sam', max_jobs_per_day: 0, dispatch_enabled: true };
const idle: TechnicianLite = { id: 'idle', member_name: 'Idle', max_jobs_per_day: 5, dispatch_enabled: false };

// A local-noon timestamp so the local calendar day is stable in any timezone.
const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();

function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
  return { id: 'j1', customer_name: 'Jane', assigned_technician_id: 'alex', scheduled_datetime: noon('2026-06-11'), job_status: 'scheduled', ...over };
}

describe('calendar-day helpers', () => {
  it('validates real dates only', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-2-3')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });

  it('adds days across month and year boundaries and handles leap years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-06-01', '2026-06-30')).toBe(29);
  });

  it('knows the weekday (0 = Sunday, matching Postgres dow)', () => {
    expect(dayOfWeek('2026-06-14')).toBe(0);
    expect(dayOfWeek('2026-06-15')).toBe(1);
  });

  it('builds month grids and shifts months both ways', () => {
    expect(monthDays(2026, 1)).toHaveLength(28);
    expect(monthDays(2028, 1)).toHaveLength(29);
    expect(monthDays(2026, 5)[0]).toBe('2026-06-01');
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(shiftMonth(2026, 5, -17)).toEqual({ year: 2025, month0: 0 });
  });

  it('formats ranges compactly', () => {
    expect(formatRange('2026-06-03', '2026-06-03')).toBe('Jun 3');
    expect(formatRange('2026-06-03', '2026-06-05')).toBe('Jun 3–5');
    expect(formatRange('2026-06-28', '2026-07-02')).toBe('Jun 28 – Jul 2');
  });

  it('derives the local day of a job and rejects garbage', () => {
    expect(jobDay(noon('2026-06-11'))).toBe('2026-06-11');
    expect(jobDay(null)).toBeNull();
    expect(jobDay('not a date')).toBeNull();
  });
});

describe('unavailability', () => {
  it('treats technicians with no rows as available every day', () => {
    expect(unavailability('alex', '2026-06-11', EMPTY_AVAILABILITY)).toBeNull();
  });

  it('applies approved time off inclusively and ignores cancelled entries', () => {
    const d = data({ timeOff: [off(), off({ id: 'o2', technician_id: 'sam', status: 'cancelled' })] });
    expect(unavailability('alex', '2026-06-10', d)?.reason).toBe('On PTO');
    expect(unavailability('alex', '2026-06-12', d)?.cause).toBe('time_off');
    expect(unavailability('alex', '2026-06-13', d)).toBeNull();
    expect(unavailability('sam', '2026-06-11', d)).toBeNull();
    expect(unavailability('alex', '2026-06-09', d)).toBeNull();
  });

  it('blackouts block everyone and win over time off', () => {
    const d = data({ blackouts: [blackout()], timeOff: [off({ start_date: '2026-06-19', end_date: '2026-06-19' })] });
    expect(unavailability('alex', '2026-06-19', d)).toEqual({ cause: 'blackout', reason: 'Company blackout: Founders Day', entryId: 'b1' });
    expect(unavailability('sam', '2026-06-19', d)?.cause).toBe('blackout');
    expect(unavailability('sam', '2026-06-19', data({ blackouts: [blackout({ status: 'cancelled' })] }))).toBeNull();
  });

  it('respects weekly working days and an empty week', () => {
    const weekdays = data({ weekly: { alex: [1, 2, 3, 4, 5], sam: [] } });
    expect(unavailability('alex', '2026-06-13', weekdays)?.reason).toBe('Not scheduled on Saturdays');
    expect(unavailability('alex', '2026-06-15', weekdays)).toBeNull();
    expect(unavailability('sam', '2026-06-15', weekdays)?.cause).toBe('not_scheduled');
    expect(unavailability('idle', '2026-06-13', weekdays)).toBeNull();
  });

  it('resolves from a job timestamp', () => {
    const d = data({ timeOff: [off()] });
    expect(unavailabilityForTimestamp('alex', noon('2026-06-11'), d)?.cause).toBe('time_off');
    expect(unavailabilityForTimestamp('alex', null, d)).toBeNull();
  });
});

describe('conflicts and capacity', () => {
  const d = data({ timeOff: [off()] });

  it('finds active assigned jobs on unavailable days only', () => {
    const jobs = [
      job(),
      job({ id: 'j2', job_status: 'completed' }),
      job({ id: 'j3', assigned_technician_id: null }),
      job({ id: 'j4', scheduled_datetime: noon('2026-06-20') }),
      job({ id: 'j5', assigned_technician_id: 'sam' }),
    ];
    expect(findConflicts(jobs, d).map((c) => c.job.id)).toEqual(['j1']);
  });

  it('previews conflicts for a draft range, per technician or for everyone', () => {
    const jobs = [job(), job({ id: 'j2', assigned_technician_id: 'sam' })];
    expect(previewConflicts(jobs, '2026-06-11', '2026-06-11', 'alex').map((j) => j.id)).toEqual(['j1']);
    expect(previewConflicts(jobs, '2026-06-11', '2026-06-11', null)).toHaveLength(2);
    expect(previewConflicts(jobs, '2026-06-12', '2026-06-11', null)).toEqual([]);
  });

  it('computes open slots from available, dispatch-enabled technicians only', () => {
    const jobs = [job(), job({ id: 'j2', assigned_technician_id: 'sam' }), job({ id: 'j3', assigned_technician_id: null })];
    const cap = capacityForDays(['2026-06-11', '2026-06-13'], [alex, sam, idle], d, jobs);
    expect(cap['2026-06-11']).toEqual({
      day: '2026-06-11',
      availableTechnicians: 1,
      totalTechnicians: 2,
      slots: 6,
      booked: 1,
      unassigned: 1,
      open: 5,
    });
    expect(cap['2026-06-13'].slots).toBe(10);
    expect(cap['2026-06-13'].open).toBe(10);
  });

  it('shows zero capacity on a blackout and never goes negative', () => {
    const cap = capacityForDays(['2026-06-19'], [alex], data({ blackouts: [blackout()] }), [job({ scheduled_datetime: noon('2026-06-19') })]);
    expect(cap['2026-06-19'].open).toBe(0);
    expect(cap['2026-06-19'].availableTechnicians).toBe(0);
  });

  it('summarises today for the dashboard tiles', () => {
    const s = summarizeTimeOff('2026-06-11', [alex, sam], d, [job()]);
    expect(s).toEqual({ offToday: 1, upcoming30: 1, conflicts: 1, openSlotsToday: 6 });
  });
});

describe('validation and overlaps', () => {
  it('validates ranges', () => {
    expect(validateRange('2026-06-10', '2026-06-10')).toEqual({});
    expect(validateRange('', '2026-06-10').start_date).toBeTruthy();
    expect(validateRange('2026-06-10', '2026-06-09').end_date).toBeTruthy();
    expect(validateRange('2026-01-01', '2027-01-02').end_date).toBeTruthy();
    expect(validateRange('2026-01-01', '2026-12-31')).toEqual({});
  });

  it('validates time off and blackout drafts', () => {
    const draft = { technician_id: '', kind: 'pto' as const, start_date: '2026-06-10', end_date: '2026-06-10', note: 'x'.repeat(501) };
    expect(Object.keys(validateTimeOff(draft)).sort()).toEqual(['note', 'technician_id']);
    expect(validateTimeOff({ ...draft, technician_id: 'alex', note: '' })).toEqual({});
    expect(validateBlackout({ label: '  ', start_date: '2026-06-10', end_date: '2026-06-10' }).label).toBeTruthy();
    expect(validateBlackout({ label: 'Holiday', start_date: '2026-06-10', end_date: '2026-06-10' })).toEqual({});
  });

  it('detects overlapping entries but ignores cancelled and other technicians', () => {
    const entries = [off(), off({ id: 'o2', status: 'cancelled' }), off({ id: 'o3', technician_id: 'sam' })];
    expect(overlappingTimeOff(entries, 'alex', '2026-06-12', '2026-06-14').map((e) => e.id)).toEqual(['o1']);
    expect(overlappingTimeOff(entries, 'alex', '2026-06-13', '2026-06-14')).toEqual([]);
    expect(overlappingBlackouts([blackout()], '2026-06-18', '2026-06-19')).toHaveLength(1);
  });
});

describe('agenda and weekly helpers', () => {
  it('lists upcoming approved entries sorted by start, skipping past and cancelled', () => {
    const d = data({
      timeOff: [
        off({ id: 'late', start_date: '2026-07-01', end_date: '2026-07-02', note: 'Beach' }),
        off({ id: 'past', start_date: '2026-05-01', end_date: '2026-05-02' }),
        off({ id: 'gone', status: 'cancelled' }),
      ],
      blackouts: [blackout()],
    });
    const items = buildAgenda(d, [alex], '2026-06-11');
    expect(items.map((i) => i.id)).toEqual(['b1', 'late']);
    expect(items[1].title).toBe('Alex');
    expect(items[1].detail).toBe('PTO · Beach');
  });

  it('toggles working days starting from "every day"', () => {
    expect(toggleWorkingDay(undefined, 0)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toggleWorkingDay([1, 2], 0)).toEqual([0, 1, 2]);
    expect(toggleWorkingDay([1], 1)).toEqual([]);
  });
});

describe('normalisers', () => {
  it('drops malformed rows instead of throwing', () => {
    expect(normalizeTimeOff(null)).toBeNull();
    expect(normalizeTimeOff({ ...off(), kind: 'vacation' })).toBeNull();
    expect(normalizeTimeOff({ ...off(), start_date: '2026-13-01' })).toBeNull();
    expect(normalizeBlackout({ ...blackout(), status: 'weird' })).toBeNull();
    expect(normalizeList([off(), { junk: 1 }], normalizeTimeOff)).toHaveLength(1);
    expect(normalizeList('nope', normalizeTimeOff)).toEqual([]);
  });

  it('cleans weekly rows (range, duplicates, order)', () => {
    expect(normalizeWeekly([{ technician_id: 'a', working_days: [5, 1, 1, 9, -1, 2.5] }, { technician_id: 'b' }, 7])).toEqual({ a: [1, 5] });
  });
});
