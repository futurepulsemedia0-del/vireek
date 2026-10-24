import { describe, it, expect } from 'vitest';
import { checkRequestedSlot, commitCapacityBooking, getAvailability, validateIntake } from './capacityBooking';
import { CHECK_AVAILABILITY_TOOL } from './mcpTool';
import { spreadSlots, voiceBookingGuard, voiceCheckAvailability } from './voiceBooking';
import { sanitizePolicy, type SlotDecision } from './capacityEngine';

// ------------------------------------------------------------------ minimal fake Supabase (filters ignored: single-tenant fixtures)
type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
function fakeAdmin(tables: Record<string, unknown>, rpc: Rpc) {
  const chain = (rows: unknown) => {
    const o: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'lte', 'order', 'limit']) o[m] = () => o;
    o.maybeSingle = () => Promise.resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error: null });
    o.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res, rej);
    return o;
  };
  // deno-lint-ignore no-explicit-any
  return { from: (t: string) => chain(tables[t] ?? []), rpc } as any;
}

const DAY = 86_400_000;
const tomorrowNoon = (() => { const d = new Date(Date.now() + DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0); })();
const ALL_DAYS = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: '00:00', close: '23:59' }]));

function tables(over: Record<string, unknown> = {}) {
  return {
    booking_capacity_policies: { user_id: 'o', enabled: true, slot_step_minutes: 60, default_travel_minutes: 0, overbook_jobs_per_tech: 0, overbook_min_cancel_rate_pct: 10, max_slots_per_day: 24 },
    capacity_demand_policies: { low_threshold_pct: 50, full_threshold_pct: 90, emergency_reserve_slots: 0 },
    business_profile: { business_hours: ALL_DAYS, holidays: [], booking_slug: 'acme', booking_enabled: true, services_offered: ['hvac'], booking_default_duration_minutes: 60, booking_lead_time_hours: 0, booking_window_days: 5, timezone: 'UTC', booking_deposit_cents: 5000, booking_intake_questions: [] },
    team_members: [{ id: 't1', member_name: 'Ali', member_email: null, skills: ['hvac'], service_area: null, territory_id: null, max_jobs_per_day: 6, home_latitude: null, home_longitude: null, current_latitude: null, current_longitude: null }],
    jobs: [],
    ...over,
  };
}
const ok = (data: unknown) => Promise.resolve({ data, error: null });
const input = { startMs: tomorrowNoon, customerName: 'Sam', customerPhone: '+15125550100', serviceType: 'hvac', channel: 'web_booking' };

describe('commitCapacityBooking', () => {
  it('falls back to legacy when smart booking is disabled', async () => {
    let called = 0;
    const admin = fakeAdmin(tables({ booking_capacity_policies: { enabled: false } }), () => { called++; return ok(null); });
    expect(await commitCapacityBooking(admin, 'o', input)).toEqual({ status: 'legacy' });
    expect(called).toBe(0);
  });

  it('books atomically with the engine-chosen technician and predicted duration', async () => {
    const calls: Record<string, unknown>[] = [];
    const admin = fakeAdmin(tables(), (name, args) => {
      if (name === 'technician_compliance_gaps') return ok([]);
      calls.push(args);
      return ok({ status: 'booked', job_id: 'j1', technician_id: 't1', technician_name: 'Ali', overbooked: false, deposit_due_cents: 5000 });
    });
    const r = await commitCapacityBooking(admin, 'o', input);
    expect(r.status).toBe('booked');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_user_id: 'o', p_technician_id: 't1', p_duration_minutes: 60, p_customer_name: 'Sam', p_deposit_cents: 5000, p_overbook_allowance: 0 });
    expect(calls[0].p_start).toBe(new Date(tomorrowNoon).toISOString());
  });

  it('retries with fresh state when the DB says the slot just went, then succeeds', async () => {
    let n = 0;
    const admin = fakeAdmin(tables(), (name) => {
      if (name === 'technician_compliance_gaps') return ok([]);
      n++;
      return ok(n < 3 ? { status: 'slot_conflict' } : { status: 'booked', job_id: 'j2', technician_id: 't1' });
    });
    const r = await commitCapacityBooking(admin, 'o', input);
    expect(r.status).toBe('booked');
    expect(n).toBe(3);
  });

  it('gives up with "unavailable" after repeated capacity rejections', async () => {
    let n = 0;
    const admin = fakeAdmin(tables(), (name) => { if (name === 'technician_compliance_gaps') return ok([]); n++; return ok({ status: 'at_capacity' }); });
    const r = await commitCapacityBooking(admin, 'o', input);
    expect(r.status).toBe('unavailable');
    expect(n).toBe(3);
  });

  it('never calls the write RPC for a time the engine would not offer, and returns alternatives', async () => {
    let wrote = 0;
    const busy = [{ id: 'x', assigned_technician_id: 't1', scheduled_datetime: new Date(tomorrowNoon).toISOString(), duration_minutes: 60, latitude: null, longitude: null }];
    const admin = fakeAdmin(tables({ jobs: busy }), (name) => { if (name === 'technician_compliance_gaps') return ok([]); wrote++; return ok({ status: 'booked' }); });
    const r = await commitCapacityBooking(admin, 'o', input);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.alternatives.length).toBeGreaterThan(0);
    expect(wrote).toBe(0);
  });

  it('treats a missing migration (RPC not found) as legacy and a missing name as an error', async () => {
    const admin = fakeAdmin(tables(), (name) => (name === 'technician_compliance_gaps' ? ok([]) : Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'nf' } })));
    expect(await commitCapacityBooking(admin, 'o', input)).toEqual({ status: 'legacy' });
    expect((await commitCapacityBooking(admin, 'o', { ...input, customerName: '  ' })).status).toBe('error');
  });
});

describe('availability + agents', () => {
  it('getAvailability reports disabled, then offers slots when enabled', async () => {
    const off = fakeAdmin(tables({ booking_capacity_policies: { enabled: false } }), () => ok([]));
    expect((await getAvailability(off, 'o', {})).enabled).toBe(false);
    const on = fakeAdmin(tables(), () => ok([]));
    const out = await getAvailability(on, 'o', { serviceType: 'hvac' });
    expect(out.enabled && out.result.slots.length > 0).toBe(true);
  });

  it('a credential gap removes the technician for that service', async () => {
    const admin = fakeAdmin(tables(), (name) => ok(name === 'technician_compliance_gaps' ? ['EPA 608'] : []));
    const v = await checkRequestedSlot(admin, 'o', { serviceType: 'hvac' }, tomorrowNoon);
    expect(v.offered).toBe(false);
    expect(v.message).toMatch(/credential/);
  });

  it('voice: guard blocks with real alternatives, passes the technician when offered, falls open when disabled', async () => {
    const admin = fakeAdmin(tables(), () => ok([]));
    const g = await voiceBookingGuard(admin, 'o', { serviceType: 'hvac', address: null, scheduledDatetime: new Date(tomorrowNoon).toISOString() });
    expect(g).toMatchObject({ mode: 'ok', technicianId: 't1', durationMinutes: 60 });
    const busy = fakeAdmin(tables({ jobs: [{ id: 'x', assigned_technician_id: 't1', scheduled_datetime: new Date(tomorrowNoon).toISOString(), duration_minutes: 60 }] }), () => ok([]));
    const b = await voiceBookingGuard(busy, 'o', { serviceType: 'hvac', address: null, scheduledDatetime: new Date(tomorrowNoon).toISOString() });
    expect(b.mode).toBe('blocked');
    const disabled = fakeAdmin(tables({ booking_capacity_policies: { enabled: false } }), () => ok([]));
    expect(await voiceBookingGuard(disabled, 'o', { serviceType: 'hvac', address: null, scheduledDatetime: new Date(tomorrowNoon).toISOString() })).toEqual({ mode: 'legacy' });
    expect(await voiceBookingGuard(admin, 'o', { serviceType: 'hvac', address: null, scheduledDatetime: null })).toEqual({ mode: 'legacy' });
  });

  it('voice: check_availability speaks only real open times', async () => {
    const admin = fakeAdmin(tables(), () => ok([]));
    expect(await voiceCheckAvailability(admin, 'o', { service_type: 'hvac' })).toMatch(/Open times .* Only offer these times/);
    expect(await voiceCheckAvailability(admin, 'o', { requested_datetime: 'garbage' })).toMatch(/isn't valid/);
  });

  it('spreadSlots caps per day and total', () => {
    const mk = (iso: string): SlotDecision => ({ start: iso, end: iso, offered: true, technician_id: 't', technician_name: 'T', overbooked: false, reasons: ['offered'], explanation: '', score: 0, travel_estimated: false });
    const slots = ['2030-01-01T09:00:00Z', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', '2030-01-02T09:00:00Z'].map(mk);
    expect(spreadSlots(slots, 'UTC', 6, 2).map((s) => s.start)).toEqual(['2030-01-01T09:00:00Z', '2030-01-01T10:00:00Z', '2030-01-02T09:00:00Z']);
    expect(spreadSlots(slots, 'UTC', 2, 1)).toHaveLength(2);
  });
});

describe('MCP tool + intake validation', () => {
  const v = (a: unknown) => CHECK_AVAILABILITY_TOOL.validate(a);
  it('accepts valid input and normalises the timestamp', () => {
    const r = v({ service_type: ' hvac ', lat: 30, lon: -97, requested_start: '2030-01-01T10:00:00-06:00', days: 3 });
    expect(r.ok && r.value).toMatchObject({ service_type: 'hvac', requested_start: '2030-01-01T16:00:00.000Z', days: 3 });
  });
  it('rejects unknown keys, lone lat, bad days and non-object input', () => {
    expect(v({ foo: 1 }).ok).toBe(false);
    expect(v({ lat: 30 }).ok).toBe(false);
    expect(v({ days: 99 }).ok).toBe(false);
    expect(v({ requested_start: 'nope' }).ok).toBe(false);
    expect(v(null).ok).toBe(false);
    expect(v({}).ok).toBe(true);
  });
  it('is read-only and needs only schedule:read', () => {
    expect(CHECK_AVAILABILITY_TOOL.write).toBe(false);
    expect(CHECK_AVAILABILITY_TOOL.scope).toBe('schedule:read');
  });

  const Q = [
    { id: 'a', label: 'Issue', type: 'text', required: true, options: [] },
    { id: 'b', label: 'Pets', type: 'yesno', required: false, options: [] },
    { id: 'c', label: 'Floor', type: 'select', required: false, options: ['1', '2'] },
  ];
  it('validateIntake enforces required, yes/no and select options', () => {
    expect(validateIntake(Q, {})).toEqual({ ok: false, reason: 'intake_required' });
    expect(validateIntake(Q, { a: 'leak', b: 'maybe' })).toEqual({ ok: false, reason: 'intake_invalid' });
    expect(validateIntake(Q, { a: 'leak', c: '9' })).toEqual({ ok: false, reason: 'intake_invalid' });
    expect(validateIntake(Q, { a: ' leak ', b: 'yes' })).toEqual({ ok: true, intake: [{ id: 'a', label: 'Issue', answer: 'leak' }, { id: 'b', label: 'Pets', answer: 'yes' }] });
    expect(validateIntake(Q, [] as unknown as Record<string, unknown>).ok).toBe(false);
  });

  it('sanitizePolicy is stable for DB rows with extra columns', () => {
    expect(sanitizePolicy({ enabled: true, slot_step_minutes: 45, user_id: 'x' } as never).slot_step_minutes).toBe(45);
  });
});
