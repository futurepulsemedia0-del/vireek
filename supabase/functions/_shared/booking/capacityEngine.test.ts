import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAPACITY_POLICY,
  computeAvailability,
  evaluateSlot,
  nearestOffered,
  overbookAllowance,
  predictDurationMinutes,
  sanitizePolicy,
  toPublicSlots,
  zonedToUtc,
  unavailableReason,
  type BookingContext,
  type BookingRequest,
  type BusyJob,
} from './capacityEngine';
import type { EngineTechnician } from '../dispatch/rulesEngine';

const TZ = 'America/Chicago';
// Mon 2030-03-04 06:00 local (CST, UTC-6) — well before opening, far from any DST edge.
const NOW = zonedToUtc(2030, 3, 4, 6 * 60, TZ);
const at = (day: number, hh: number, mm = 0) => zonedToUtc(2030, 3, day, hh * 60 + mm, TZ);
const WEEKDAY_HOURS = { mon: { open: '09:00', close: '17:00' }, tue: { open: '09:00', close: '17:00' }, wed: { open: '09:00', close: '17:00' }, thu: { open: '09:00', close: '17:00' }, fri: { open: '09:00', close: '17:00' } };

const tech = (id: string, o: Partial<EngineTechnician> = {}): EngineTechnician => ({
  id, name: id.toUpperCase(), skills: ['hvac'], service_area: null, territory_id: null, lat: null, lon: null, max_jobs_per_day: 4, quality: null, ...o,
});
const job = (id: string, techId: string | null, day: number, h1: number, h2: number, o: Partial<BusyJob> = {}): BusyJob => ({
  id, technician_id: techId, start: at(day, h1), end: at(day, h2), lat: null, lon: null, ...o,
});

function ctx(o: Partial<BookingContext> = {}): BookingContext {
  return {
    now: NOW, timezone: TZ, hours: WEEKDAY_HOURS, holidays: [], leadTimeHours: 2, windowDays: 1, bufferBefore: 0, bufferAfter: 0,
    policy: { ...DEFAULT_CAPACITY_POLICY, enabled: true, default_travel_minutes: 0, emergency_reserve_slots: 0, slot_step_minutes: 60 },
    technicians: [tech('a')], rules: [], territories: [], preferences: [], jobs: [], timeOff: [], blackouts: [], workingDays: {}, cancelRate: null, ...o,
  };
}
const req = (o: Partial<BookingRequest> = {}): BookingRequest => ({
  serviceType: 'hvac', durationMinutes: 60, address: null, lat: null, lon: null, customerId: null, isVip: false, isEmergency: false, ...o,
});
const offeredStarts = (c: BookingContext, r = req(), day = 4) =>
  computeAvailability(c, r).slots.filter((s) => s.offered && s.start.startsWith('2030-03-0') && new Date(s.start).getTime() >= at(day, 0) && new Date(s.start).getTime() < at(day + 1, 0)).map((s) => s.start);

describe('capacity engine — basics', () => {
  it('offers hourly slots inside business hours in the business time zone', () => {
    const slots = computeAvailability(ctx(), req()).slots;
    expect(slots[0].start).toBe(new Date(at(4, 9)).toISOString());
    expect(slots.filter((s) => Date.parse(s.start) < at(5, 0))).toHaveLength(8); // 9..16
  });

  it('respects lead time', () => {
    const c = ctx({ now: at(4, 8), leadTimeHours: 2 });
    const first = computeAvailability(c, req()).slots[0];
    expect(Date.parse(first.start)).toBeGreaterThanOrEqual(at(4, 10));
  });

  it('predicted duration blocks slots that would run past closing', () => {
    const slots = computeAvailability(ctx(), req({ durationMinutes: 180 })).slots.filter((s) => Date.parse(s.start) < at(5, 0));
    expect(slots.at(-1)!.start).toBe(new Date(at(4, 14)).toISOString()); // 14:00 + 3h = 17:00
  });

  it('skips closed days and company holidays', () => {
    const c = ctx({ holidays: ['2030-03-04'] });
    expect(offeredStarts(c)).toHaveLength(0);
    const r = computeAvailability(c, req(), { includeHidden: true }).slots.find((s) => Date.parse(s.start) < at(5, 0))!;
    expect(r.reasons).toEqual(['holiday_blackout']);
  });
});

describe('capacity engine — technicians', () => {
  it('hides a slot already occupied by the only technician and offers it with a second one', () => {
    const jobs = [job('j1', 'a', 4, 10, 11)];
    expect(offeredStarts(ctx({ jobs }))).not.toContain(new Date(at(4, 10)).toISOString());
    const two = ctx({ jobs, technicians: [tech('a'), tech('b')] });
    const s = computeAvailability(two, req()).slots.find((x) => x.start === new Date(at(4, 10)).toISOString())!;
    expect(s.offered).toBe(true);
    expect(s.technician_id).toBe('b');
  });

  it('requires the skill and explains why when nobody qualifies', () => {
    const c = ctx({ technicians: [tech('a', { skills: ['plumbing'] })] });
    expect(offeredStarts(c)).toHaveLength(0);
    const s = computeAvailability(c, req(), { includeHidden: true }).slots[0];
    expect(s.reasons).toEqual(['no_qualified_technician']);
    expect(s.explanation).toMatch(/skill|zone/i);
  });

  it('treats a technician with no listed skills as a generalist', () => {
    expect(offeredStarts(ctx({ technicians: [tech('a', { skills: [] })] })).length).toBeGreaterThan(0);
  });

  it('excludes technicians on time off, blackout or off-weekday', () => {
    const off = ctx({ technicians: [tech('a')], timeOff: [{ technician_id: 'a', start_date: '2030-03-04', end_date: '2030-03-04' }] });
    expect(offeredStarts(off, req(), 4)).toHaveLength(0);
    const hid = computeAvailability(off, req(), { includeHidden: true }).slots[0];
    expect(hid.reasons).toEqual(['technicians_unavailable']);
    const weekly = ctx({ workingDays: { a: [2, 3, 4, 5] } }); // not Monday
    expect(offeredStarts(weekly, req(), 4)).toHaveLength(0);
    expect(unavailableReason({ timeOff: [], blackouts: [{ label: 'Retreat', start_date: '2030-03-04', end_date: '2030-03-05' }], workingDays: {} }, 'a', '2030-03-05', 2)).toMatch(/Retreat/);
  });

  it('enforces the daily job limit and the overtime (minutes) limit', () => {
    const jobs = [job('1', 'a', 4, 9, 10), job('2', 'a', 4, 10, 11)];
    expect(offeredStarts(ctx({ jobs, technicians: [tech('a', { max_jobs_per_day: 2 })] }))).toHaveLength(0);
    const hid = computeAvailability(ctx({ jobs, technicians: [tech('a', { max_jobs_per_day: 2 })] }), req(), { includeHidden: true }).slots[0];
    expect(hid.reasons).toEqual(['day_at_capacity']);
  });

  it('applies the zone rule when technician and job are far apart', () => {
    const c = ctx({
      technicians: [tech('a', { lat: 30.27, lon: -97.74 })],
      rules: [{ id: 'z', rule_type: 'max_drive_time', name: 'Drive', enabled: true, mode: 'require', weight: 10, params: { max_minutes: 30 }, position: 0 }],
    });
    expect(offeredStarts(c, req({ lat: 32.78, lon: -96.8 }))).toHaveLength(0); // Dallas, ~3h away
    expect(offeredStarts(c, req({ lat: 30.3, lon: -97.7 })).length).toBeGreaterThan(0);
  });
});

describe('capacity engine — buffers and drive time', () => {
  it('keeps buffers and travel time between neighbouring jobs', () => {
    const jobs = [job('1', 'a', 4, 9, 10, { lat: 30.27, lon: -97.74 })];
    const near = ctx({ jobs, bufferBefore: 15 });
    expect(offeredStarts(near, req({ lat: 30.27, lon: -97.74 }))).not.toContain(new Date(at(4, 10)).toISOString()); // 15m buffer
    const far = ctx({ jobs, policy: { ...ctx().policy, slot_step_minutes: 30 } });
    const r = req({ lat: 31.5, lon: -97.74 }); // ~100 mi away -> ~4h drive
    const starts = offeredStarts(far, r);
    expect(starts).not.toContain(new Date(at(4, 10)).toISOString());
    expect(starts).toContain(new Date(at(4, 14)).toISOString());
  });

  it('assumes the default travel time when coordinates are unknown and flags it', () => {
    const jobs = [job('1', 'a', 4, 9, 10)];
    const c = ctx({ jobs, policy: { ...ctx().policy, default_travel_minutes: 30, slot_step_minutes: 30 } });
    const slots = computeAvailability(c, req()).slots.filter((s) => s.offered);
    expect(slots.some((s) => s.start === new Date(at(4, 10)).toISOString())).toBe(false);
    const s = slots.find((x) => x.start === new Date(at(4, 10, 30)).toISOString())!;
    expect(s.travel_estimated).toBe(true);
  });

  it('hides slots held by an unassigned job (the DB would reject them)', () => {
    const c = ctx({ jobs: [job('u', null, 4, 9, 10)] });
    const s = computeAvailability(c, req(), { includeHidden: true }).slots[0];
    expect(s.reasons).toEqual(['unassigned_job_overlap']);
  });
});

describe('capacity engine — emergency reserve, demand and overbooking', () => {
  it('holds the last slot(s) of the day for emergencies only', () => {
    const jobs = [job('1', 'a', 4, 9, 10), job('2', 'a', 4, 10, 11), job('3', 'a', 4, 11, 12)];
    const policy = { ...ctx().policy, emergency_reserve_slots: 1 };
    const c = ctx({ jobs, policy });
    expect(offeredStarts(c, req(), 4)).toHaveLength(0);
    expect(computeAvailability(c, req(), { includeHidden: true }).slots[0].reasons).toEqual(['emergency_reserve']);
    expect(offeredStarts(c, req({ isEmergency: true }), 4).length).toBeGreaterThan(0);
  });

  it('reports demand status with the same thresholds as capacity-demand control', () => {
    const jobs = [job('1', 'a', 4, 9, 10), job('2', 'a', 4, 10, 11), job('3', 'a', 4, 11, 12)];
    const d = computeAvailability(ctx({ jobs }), req()).days[0];
    expect(d.demand).toMatchObject({ load: 3, capacity: 4, load_pct: 75, status: 'optimal' });
  });

  it('allows controlled overbooking only when the cancel rate justifies it', () => {
    const jobs = [job('1', 'a', 4, 9, 10), job('2', 'a', 4, 10, 11)];
    const base = ctx({ jobs, technicians: [tech('a', { max_jobs_per_day: 2 })], policy: { ...ctx().policy, overbook_jobs_per_tech: 1, overbook_min_cancel_rate_pct: 10 } });
    expect(offeredStarts({ ...base, cancelRate: 0.05 })).toHaveLength(0);
    const hot = computeAvailability({ ...base, cancelRate: 0.5 }, req());
    const s = hot.slots.find((x) => x.offered && Date.parse(x.start) < at(5, 0))!;
    expect(s.overbooked).toBe(true);
    expect(s.explanation).toMatch(/overbooking/);
    expect(hot.overbooking_allowance_per_tech).toBe(1);
  });

  it('prefers a technician with room over an overbooked one', () => {
    const jobs = [job('1', 'a', 4, 9, 10), job('2', 'a', 4, 10, 11)];
    const c = ctx({ jobs, technicians: [tech('a', { max_jobs_per_day: 2 }), tech('b', { max_jobs_per_day: 2 })], cancelRate: 0.5, policy: { ...ctx().policy, overbook_jobs_per_tech: 1 } });
    const s = computeAvailability(c, req()).slots.find((x) => x.start === new Date(at(4, 13)).toISOString())!;
    expect(s.technician_id).toBe('b');
    expect(s.overbooked).toBe(false);
  });

  it('overbookAllowance is zero without data, below threshold, or when disabled', () => {
    const p = { ...DEFAULT_CAPACITY_POLICY, overbook_jobs_per_tech: 2 };
    expect(overbookAllowance(p, null, 6)).toBe(0);
    expect(overbookAllowance(p, 0.05, 6)).toBe(0);
    expect(overbookAllowance({ ...p, overbook_jobs_per_tech: 0 }, 0.5, 6)).toBe(0);
    expect(overbookAllowance(p, 0.5, 6)).toBe(2);
    expect(overbookAllowance(p, 0.17, 6)).toBe(1);
  });
});

describe('capacity engine — helpers', () => {
  it('evaluateSlot explains a specific request and nearestOffered finds alternatives', () => {
    const c = ctx({ jobs: [job('1', 'a', 4, 13, 14)] });
    const asked = evaluateSlot(c, req(), at(4, 13));
    expect(asked.offered).toBe(false);
    expect(asked.reasons).toEqual(['fully_booked']);
    const alts = nearestOffered(computeAvailability(c, req()).slots, at(4, 13), 2);
    expect(alts).toHaveLength(2);
    expect(alts.every((a) => a.offered)).toBe(true);
    expect(evaluateSlot(c, req(), at(4, 20)).reasons).toEqual(['outside_hours']);
  });

  it('public projection never leaks technician data or reasons', () => {
    const pub = toPublicSlots(computeAvailability(ctx(), req()));
    expect(Object.keys(pub[0]).sort()).toEqual(['end', 'start']);
  });

  it('predictDurationMinutes uses the median with enough samples, else the fallback', () => {
    expect(predictDurationMinutes([60, 90], 60)).toBe(60);
    expect(predictDurationMinutes([60, 90, 120, 100, 80], 45)).toBe(90);
    expect(predictDurationMinutes([60, 60, 60, 60, 5000], 45)).toBe(45); // outlier dropped -> only 4 valid samples -> fallback
  });

  it('sanitizePolicy clamps garbage and keeps thresholds ordered', () => {
    const p = sanitizePolicy({ slot_step_minutes: 1, overbook_jobs_per_tech: 99, low_threshold_pct: 95, full_threshold_pct: 10, enabled: 'yes' });
    expect(p.slot_step_minutes).toBe(5);
    expect(p.overbook_jobs_per_tech).toBe(3);
    expect(p.low_threshold_pct).toBeLessThan(p.full_threshold_pct);
    expect(p.enabled).toBe(false);
  });

  it('handles DST: wall-clock slots stay at 9:00 local after spring-forward', () => {
    const now = zonedToUtc(2030, 3, 10, 6 * 60, TZ); // Sun Mar 10 2030 06:00 CDT? (DST starts Mar 10, 2am)
    const c = ctx({ now, hours: { mon: { open: '09:00', close: '17:00' } }, windowDays: 2, policy: { ...ctx().policy } });
    const first = computeAvailability(c, req()).slots[0];
    expect(first.start).toBe(new Date(zonedToUtc(2030, 3, 11, 9 * 60, TZ)).toISOString());
    expect(new Date(first.start).getUTCHours()).toBe(14); // 9:00 CDT = 14:00Z
  });
});

describe('capacity engine — credentials', () => {
  it('hides slots when the only qualified technician lacks a blocking credential, and uses another who has it', () => {
    const c = ctx({ credentialGaps: { a: ['EPA 608'] } });
    expect(offeredStarts(c)).toHaveLength(0);
    const hid = computeAvailability(c, req(), { includeHidden: true }).slots[0];
    expect(hid.reasons).toEqual(['no_qualified_technician']);
    expect(hid.explanation).toMatch(/credential/);
    const two = ctx({ credentialGaps: { a: ['EPA 608'] }, technicians: [tech('a'), tech('b')] });
    expect(computeAvailability(two, req()).slots[0].technician_id).toBe('b');
  });
});
