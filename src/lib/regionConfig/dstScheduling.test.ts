import { describe, it, expect } from 'vitest';
import { addZonedDays, offsetMinutesAt, wallTimeIn, zonedWallTimeToInstant, startOfZonedDay, zonedDayKey } from '../timezone';

const at = (z: string, y: number, mo: number, d: number, h: number, mi = 0, dis?: 'earlier' | 'later') =>
  zonedWallTimeToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, z, dis);
const wall = (i: Date, z: string) => { const w = wallTimeIn(i, z); return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`; };

describe('recurring 09:00 appointment keeps its wall-clock time across DST', () => {
  const cases: Array<[string, string, number, number, number]> = [
    // zone, label, start y, m, d  (weekly series that crosses a transition)
    ['America/Chicago', 'US spring forward 2027-03-14', 2027, 3, 8],
    ['America/Chicago', 'US fall back 2027-11-07', 2027, 11, 1],
    ['Europe/Berlin', 'EU spring forward 2027-03-28', 2027, 3, 22],
    ['Europe/Berlin', 'EU fall back 2027-10-31', 2027, 10, 25],
    ['Australia/Sydney', 'AU (southern) spring forward 2027-10-03', 2027, 9, 27],
    ['Australia/Sydney', 'AU fall back 2027-04-04', 2027, 3, 29],
  ];
  for (const [zone, label, y, m, d] of cases) {
    it(`${zone} — ${label}`, () => {
      let cur = at(zone, y, m, d, 9);
      const offsets = new Set<number>();
      for (let i = 0; i < 3; i++) {
        expect(wall(cur, zone).endsWith('09:00')).toBe(true);
        offsets.add(offsetMinutesAt(cur, zone));
        cur = addZonedDays(cur, 7, zone);
      }
      expect(offsets.size).toBe(2); // the UTC offset really did change; the local hour did not
    });
  }
  it('the UTC gap between occurrences is 167h or 169h at a transition, never a silent 168h drift', () => {
    const a = at('America/Chicago', 2027, 3, 8, 9);
    const b = addZonedDays(a, 7, 'America/Chicago');
    expect((b.getTime() - a.getTime()) / 3_600_000).toBe(167);
  });
});

describe('non-existent and ambiguous local times', () => {
  it('US spring forward: 02:30 does not exist and moves forward by the gap', () => {
    expect(wall(at('America/Chicago', 2027, 3, 14, 2, 30), 'America/Chicago')).toBe('2027-03-14 03:30');
  });
  it('EU spring forward: 02:30 does not exist in Berlin', () => {
    expect(wall(at('Europe/Berlin', 2027, 3, 28, 2, 30), 'Europe/Berlin')).toBe('2027-03-28 03:30');
  });
  it('US fall back: 01:30 happens twice; earlier/later are exactly one hour apart', () => {
    const e = at('America/Chicago', 2027, 11, 7, 1, 30, 'earlier');
    const l = at('America/Chicago', 2027, 11, 7, 1, 30, 'later');
    expect(l.getTime() - e.getTime()).toBe(3_600_000);
    expect(wall(e, 'America/Chicago')).toBe('2027-11-07 01:30');
    expect(wall(l, 'America/Chicago')).toBe('2027-11-07 01:30');
  });
  it('Sydney (half the year ahead): 02:30 on fall-back is ambiguous too', () => {
    const e = at('Australia/Sydney', 2027, 4, 4, 2, 30, 'earlier');
    const l = at('Australia/Sydney', 2027, 4, 4, 2, 30, 'later');
    expect(l.getTime() - e.getTime()).toBe(3_600_000);
  });
});

describe('day boundaries & zones without DST', () => {
  it('a DST day is 23h or 25h long, and startOfZonedDay lands on local midnight', () => {
    const z = 'America/Chicago';
    const start = startOfZonedDay(at(z, 2027, 3, 14, 12), z);
    const next = startOfZonedDay(at(z, 2027, 3, 15, 12), z);
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23);
    const s2 = startOfZonedDay(at(z, 2027, 11, 7, 12), z);
    const n2 = startOfZonedDay(at(z, 2027, 11, 8, 12), z);
    expect((n2.getTime() - s2.getTime()) / 3_600_000).toBe(25);
  });
  it('the same instant is a different calendar day in different business zones', () => {
    const i = new Date(Date.UTC(2027, 5, 1, 23, 30));
    expect(zonedDayKey(i, 'America/Los_Angeles')).toBe('2027-06-01');
    expect(zonedDayKey(i, 'Europe/Berlin')).toBe('2027-06-02');
    expect(zonedDayKey(i, 'Australia/Sydney')).toBe('2027-06-02');
  });
  it('half-hour zone without DST (Asia/Kolkata) is a constant +05:30', () => {
    const a = at('Asia/Kolkata', 2027, 1, 15, 9); const b = at('Asia/Kolkata', 2027, 7, 15, 9);
    expect(offsetMinutesAt(a, 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutesAt(b, 'Asia/Kolkata')).toBe(330);
  });
  it('a customer in another zone sees the booking at the correct converted wall time on a DST-mismatch week', () => {
    // 2027-03-15: US already on DST, Berlin not yet (EU switches 03-28) → gap is 5h, not the usual 6h
    const i = at('America/Chicago', 2027, 3, 15, 9);
    expect(wall(i, 'Europe/Berlin')).toBe('2027-03-15 15:00');
  });
});
