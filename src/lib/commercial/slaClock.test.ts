import { describe, it, expect } from 'vitest';
import {
  addBusinessMinutes, applyStatusChange, businessMinutesBetween, capPauses, dueEscalations, evaluateTimer,
  isValidTimeZone, localInstant, localParts, normalizePauses, standardBusinessWindows, twentyFourSeven, validateCalendar,
  type EscalationStep, type SlaCalendar,
} from './slaClock';

const NY: SlaCalendar = { timeZone: 'America/New_York', windows: standardBusinessWindows(), holidays: [] };
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

describe('time-zone helpers', () => {
  it('validates zones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
  it('maps UTC to local parts across a date line', () => {
    // 2027-06-07T02:30Z is still Sunday evening in New York (22:30 EDT)
    expect(localParts(at('2027-06-07T02:30:00Z'), 'America/New_York')).toEqual({ dateKey: '2027-06-06', dow: 0, minutes: 22 * 60 + 30 });
  });
  it('converts local wall time to UTC, including end-of-day (1440)', () => {
    expect(iso(localInstant('2027-06-07', 8 * 60, 'America/New_York'))).toBe('2027-06-07T12:00:00.000Z');
    expect(iso(localInstant('2027-06-07', 1440, 'America/New_York'))).toBe('2027-06-08T04:00:00.000Z');
  });
});

describe('validateCalendar', () => {
  it('accepts a normal calendar', () => expect(validateCalendar(NY)).toEqual([]));
  it('rejects bad zone, empty windows, inverted window, bad holiday', () => {
    expect(validateCalendar({ ...NY, timeZone: 'Nope/Zone' })).toContain('Unknown time zone');
    expect(validateCalendar({ ...NY, windows: [] })).toContain('At least one business window is required');
    expect(validateCalendar({ ...NY, windows: [{ days: [1], startMin: 600, endMin: 600 }] }).length).toBe(1);
    expect(validateCalendar({ ...NY, windows: [{ days: [7], startMin: 0, endMin: 60 }] }).length).toBe(1);
    expect(validateCalendar({ ...NY, holidays: ['2027-13-45'] }).length).toBe(1);
    expect(validateCalendar({ ...NY, holidays: ['2027-02-30'] }).length).toBe(1); // regression: must not roll over to Mar 2
    expect(validateCalendar({ ...NY, holidays: ['2028-02-29'] })).toEqual([]);
  });
});

describe('addBusinessMinutes', () => {
  it('stays within the same business day', () => {
    expect(iso(addBusinessMinutes(at('2027-06-07T14:00:00Z'), 60, NY))).toBe('2027-06-07T15:00:00.000Z');
  });
  it('rolls past close of business to the next business morning', () => {
    // Fri 16:30 EDT + 60 → 30 left Friday, Mon 08:30 EDT
    expect(iso(addBusinessMinutes(at('2027-06-11T20:30:00Z'), 60, NY))).toBe('2027-06-14T12:30:00.000Z');
  });
  it('starts counting at opening time when the request arrives on a weekend', () => {
    expect(iso(addBusinessMinutes(at('2027-06-12T16:00:00Z'), 60, NY))).toBe('2027-06-14T13:00:00.000Z');
  });
  it('skips holidays (local dates)', () => {
    const cal = { ...NY, holidays: ['2027-06-14'] };
    expect(iso(addBusinessMinutes(at('2027-06-11T20:45:00Z'), 30, cal))).toBe('2027-06-15T12:15:00.000Z');
  });
  it('is correct across spring-forward (US, 2027-03-14)', () => {
    expect(iso(addBusinessMinutes(at('2027-03-12T21:00:00Z'), 120, NY))).toBe('2027-03-15T13:00:00.000Z');
  });
  it('is correct across fall-back (US, 2027-11-07)', () => {
    expect(iso(addBusinessMinutes(at('2027-11-05T20:00:00Z'), 120, NY))).toBe('2027-11-08T14:00:00.000Z');
  });
  it('handles southern-hemisphere DST (Sydney, 2027-10-03)', () => {
    const cal = { ...NY, timeZone: 'Australia/Sydney' };
    expect(iso(addBusinessMinutes(at('2027-10-01T06:30:00Z'), 60, cal))).toBe('2027-10-03T21:30:00.000Z');
  });
  it('handles half-hour offsets (Asia/Kolkata)', () => {
    const cal: SlaCalendar = { timeZone: 'Asia/Kolkata', windows: [{ days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1080 }], holidays: [] };
    expect(iso(addBusinessMinutes(at('2027-06-07T02:30:00Z'), 30, cal))).toBe('2027-06-07T04:00:00.000Z');
  });
  it('honours split windows (lunch gap)', () => {
    const cal: SlaCalendar = { ...NY, windows: [{ days: [1, 2, 3, 4, 5], startMin: 480, endMin: 720 }, { days: [1, 2, 3, 4, 5], startMin: 780, endMin: 1020 }] };
    expect(iso(addBusinessMinutes(at('2027-06-07T15:30:00Z'), 60, cal))).toBe('2027-06-07T17:30:00.000Z');
  });
  it('24x7 calendars count straight through nights and weekends', () => {
    expect(iso(addBusinessMinutes(at('2027-06-12T23:30:00Z'), 90, twentyFourSeven()))).toBe('2027-06-13T01:00:00.000Z');
  });
  it('returns the start for zero minutes, throws for negatives, null for an empty calendar', () => {
    expect(addBusinessMinutes(1000, 0, NY)).toBe(1000);
    expect(() => addBusinessMinutes(1000, -1, NY)).toThrow(RangeError);
    expect(addBusinessMinutes(at('2027-06-07T14:00:00Z'), 5, { ...NY, windows: [] })).toBeNull();
  });
});

describe('businessMinutesBetween', () => {
  it('counts only business time across a weekend', () => {
    // Fri 15:00 EDT → Tue 09:00 EDT = 120 + 540 + 60
    expect(businessMinutesBetween(at('2027-06-11T19:00:00Z'), at('2027-06-15T13:00:00Z'), NY)).toBe(720);
  });
  it('is 0 when end <= start and for a fully non-business span', () => {
    expect(businessMinutesBetween(at('2027-06-07T14:00:00Z'), at('2027-06-07T13:00:00Z'), NY)).toBe(0);
    expect(businessMinutesBetween(at('2027-06-12T14:00:00Z'), at('2027-06-13T14:00:00Z'), NY)).toBe(0);
  });
  it('is the inverse of addBusinessMinutes', () => {
    const start = at('2027-06-10T18:20:00Z');
    const due = addBusinessMinutes(start, 777, NY)!;
    expect(businessMinutesBetween(start, due, NY)).toBeCloseTo(777, 6);
  });
});

describe('pauses', () => {
  const start = at('2027-06-07T14:00:00Z'); // Mon 10:00 EDT
  it('a pause inside business hours pushes the deadline out by its length', () => {
    const pauses = [{ from: '2027-06-07T15:00:00Z', to: '2027-06-07T17:00:00Z' }];
    expect(iso(addBusinessMinutes(start, 120, NY, pauses))).toBe('2027-06-07T18:00:00.000Z');
  });
  it('a pause entirely outside business hours changes nothing', () => {
    const s = at('2027-06-11T20:00:00Z');
    const pauses = [{ from: '2027-06-12T10:00:00Z', to: '2027-06-13T10:00:00Z' }];
    expect(iso(addBusinessMinutes(s, 120, NY, pauses))).toBe(iso(addBusinessMinutes(s, 120, NY)));
  });
  it('overlapping and invalid pauses are merged / ignored', () => {
    const n = normalizePauses([
      { from: '2027-06-07T15:00:00Z', to: '2027-06-07T16:00:00Z' },
      { from: '2027-06-07T15:30:00Z', to: '2027-06-07T17:00:00Z' },
      { from: 'garbage', to: null },
      { from: '2027-06-07T18:00:00Z', to: '2027-06-07T18:00:00Z' },
    ]);
    expect(n).toHaveLength(1);
    expect(n[0].to - n[0].from).toBe(2 * 3_600_000);
  });
  it('an open pause makes the deadline unknowable', () => {
    expect(addBusinessMinutes(start, 120, NY, [{ from: '2027-06-07T15:00:00Z', to: null }])).toBeNull();
  });
  it('capPauses closes an over-long open pause at the cap', () => {
    const now = at('2027-06-07T18:00:00Z');
    const capped = capPauses([{ from: '2027-06-07T15:00:00Z', to: null }], 60, now);
    expect(capped[0].to).toBe('2027-06-07T16:00:00.000Z');
    expect(capPauses([{ from: '2027-06-07T15:00:00Z', to: null }], 600, now)[0].to).toBeNull();
    expect(capPauses([{ from: '2027-06-07T15:00:00Z', to: '2027-06-07T20:00:00Z' }], 60, now)[0].to).toBe('2027-06-07T16:00:00.000Z');
  });
  it('applyStatusChange opens once, closes once, and is idempotent', () => {
    const rule = { pauseOnStatuses: ['awaiting_customer'] };
    let p = applyStatusChange([], rule, 'awaiting_customer', '2027-06-07T15:00:00Z');
    expect(p).toHaveLength(1);
    p = applyStatusChange(p, rule, 'awaiting_customer', '2027-06-07T15:05:00Z');
    expect(p).toHaveLength(1);
    p = applyStatusChange(p, rule, 'in_progress', '2027-06-07T16:00:00Z');
    expect(p[0].to).toBe('2027-06-07T16:00:00Z');
    expect(applyStatusChange(p, rule, 'in_progress', '2027-06-07T16:30:00Z')).toBe(p);
  });
});

describe('evaluateTimer', () => {
  const base = { startedAt: '2027-06-07T14:00:00Z', targetMinutes: 100, calendar: NY };
  it('running → at_risk → breached', () => {
    expect(evaluateTimer(base, '2027-06-07T14:30:00Z').state).toBe('running');
    const risk = evaluateTimer(base, '2027-06-07T15:25:00Z');
    expect(risk.state).toBe('at_risk');
    expect(risk.remainingMinutes).toBe(15);
    const late = evaluateTimer(base, '2027-06-07T15:45:00Z');
    expect(late.state).toBe('breached');
    expect(late.overByMinutes).toBe(5);
    expect(late.dueAt).toBe('2027-06-07T15:40:00.000Z');
  });
  it('met vs missed when stopped', () => {
    expect(evaluateTimer({ ...base, stoppedAt: '2027-06-07T15:30:00Z' }, '2027-06-09T00:00:00Z').state).toBe('met');
    expect(evaluateTimer({ ...base, stoppedAt: '2027-06-07T15:50:00Z' }, '2027-06-09T00:00:00Z').state).toBe('missed');
  });
  it('a request received after hours does not breach overnight', () => {
    const e = evaluateTimer({ ...base, startedAt: '2027-06-07T22:00:00Z' }, '2027-06-08T11:00:00Z');
    expect(e.elapsedMinutes).toBe(0);
    expect(e.state).toBe('running');
  });
  it('reports paused with an unknown deadline while a pause is open', () => {
    const e = evaluateTimer({ ...base, targetMinutes: 120, pauses: [{ from: '2027-06-07T15:00:00Z', to: null }] }, '2027-06-07T16:00:00Z');
    expect(e.state).toBe('paused');
    expect(e.dueAt).toBeNull();
    expect(e.elapsedMinutes).toBe(60);
    expect(e.remainingMinutes).toBe(60);
  });
  it('rejects invalid input', () => {
    expect(() => evaluateTimer({ ...base, targetMinutes: 0 }, '2027-06-07T14:00:00Z')).toThrow(RangeError);
    expect(() => evaluateTimer({ ...base, startedAt: 'x' }, '2027-06-07T14:00:00Z')).toThrow(RangeError);
  });
});

describe('dueEscalations', () => {
  const steps: EscalationStep[] = [
    { key: 'warn', atPct: 80, notify: 'dispatcher' },
    { key: 'breach', atPct: 100, notify: 'manager' },
    { key: 'late60', atPct: 160, notify: 'owner' },
  ];
  const base = { startedAt: '2027-06-07T14:00:00Z', targetMinutes: 100, calendar: NY };
  it('fires only steps whose threshold is reached and not yet fired, lowest first', () => {
    const ev = evaluateTimer(base, '2027-06-07T15:45:00Z'); // 105 %
    expect(dueEscalations(ev, steps, new Set()).map((s) => s.key)).toEqual(['warn', 'breach']);
    expect(dueEscalations(ev, steps, new Set(['warn'])).map((s) => s.key)).toEqual(['breach']);
  });
  it('never fires for paused, met or missed timers', () => {
    const paused = evaluateTimer({ ...base, pauses: [{ from: '2027-06-07T15:00:00Z', to: null }] }, '2027-06-07T20:00:00Z');
    expect(dueEscalations(paused, steps, new Set())).toEqual([]);
    const met = evaluateTimer({ ...base, stoppedAt: '2027-06-07T15:00:00Z' }, '2027-06-08T15:00:00Z');
    expect(dueEscalations(met, steps, new Set())).toEqual([]);
  });
});
