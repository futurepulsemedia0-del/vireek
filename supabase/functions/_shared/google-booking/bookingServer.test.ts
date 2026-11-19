// Contract tests for the Google Booking Server handler (fixtures: Google's published v3 sample shapes).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleBookingServer, int64, parseRoute, type BookingServerDeps, type ClaimResult } from './bookingServer';
import { computeFeedAvailability, sha256Hex, type FeedSnapshot } from './availability';
import { serviceIdFor } from './ids';

const fx = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'booking-server-samples.json'), 'utf8'));
const NOW = Date.parse('2026-11-19T12:00:00Z');
const USER = 'user-1';
const BID = '3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab';
const AUTH = 'Basic ' + btoa('gUser:' + 'p'.repeat(24));

function snapshot(over: Partial<FeedSnapshot['google']> = {}): FeedSnapshot {
  const day = { open: '09:00', close: '17:00' };
  return {
    generated_at: '2026-11-19T12:00:00Z', slug: 'acme-hvac',
    business: { name: 'Acme HVAC', timezone: 'UTC', timezone_set: true, services: ['AC Repair'] },
    settings: { enabled: true, hours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }, holidays: [], duration_minutes: 60, lead_time_hours: 2, window_days: 7, buffer_before: 0, buffer_after: 0 },
    capacity: { technician_capacity: 0, emergency_reserve: 0, full_threshold_pct: 100 },
    google: { feed_enabled: true, structured_data_enabled: false, partner_status: 'sandbox', horizon_days: 7, ...over },
    busy: [], load_by_day: {},
  };
}
const firstSlot = (s: FeedSnapshot) => computeFeedAvailability(s, new Date(NOW), { requirePublished: true }).slots[0];

function mk(over: Partial<BookingServerDeps> = {}, snap: FeedSnapshot | null = snapshot()) {
  const d = {
    now: () => NOW,
    credentials: () => ({ user: 'gUser', password: 'p'.repeat(24) }),
    allowRequest: vi.fn(async () => true),
    ping: vi.fn(async () => true),
    resolveMerchant: vi.fn(async (slug: string) => (snap && slug === 'acme-hvac' ? { userId: USER, snapshot: snap } : null)),
    fsmGate: vi.fn(async () => ({ allows: () => true })),
    claim: vi.fn(async (): Promise<ClaimResult> => ({ state: 'new', id: BID })),
    book: vi.fn(async () => ({ ok: true as const, jobId: 'job-1' })),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ state: 'canceled' as const })),
    afterBooking: vi.fn(),
    sha256Hex,
    log: vi.fn(),
    ...over,
  } satisfies BookingServerDeps;
  return d;
}
const call = (d: BookingServerDeps, mode: string, method: string, body?: unknown, init: RequestInit = {}) =>
  handleBookingServer(
    new Request(`https://x.supabase.co/functions/v1/google-booking-server/${mode}/v3/${method}`, {
      method: method === 'HealthCheck' ? 'GET' : 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    }),
    d,
  );
const fill = (o: unknown, start: number, id = '') => JSON.parse(JSON.stringify(o).replace('__START__', String(start)).replace('__ID__', id));

let slot: { start_sec: number; duration_sec: number };
beforeEach(() => { slot = firstSlot(snapshot()); });

describe('routing + auth', () => {
  it('parses routes', () => {
    expect(parseRoute('/functions/v1/google-booking-server/sandbox/v3/HealthCheck/')).toEqual({ mode: 'sandbox', method: 'HealthCheck' });
    expect(parseRoute('/google-booking-server/staging/v3/HealthCheck')).toBeNull();
  });
  it('rejects missing/wrong credentials with 401 + WWW-Authenticate', async () => {
    const d = mk();
    for (const h of [undefined, 'Basic ' + btoa('gUser:wrong'), 'Bearer x', 'Basic !!!']) {
      const r = await call(d, 'sandbox', 'HealthCheck', undefined, { headers: h ? { Authorization: h } : {} });
      expect(r.status).toBe(401);
      expect(r.headers.get('WWW-Authenticate')).toContain('Basic');
    }
  });
  it('503 when credentials are not configured (fail closed); sandbox and production use separate creds', async () => {
    expect((await call(mk({ credentials: () => null }), 'production', 'HealthCheck')).status).toBe(503);
    const d = mk({ credentials: (m) => (m === 'sandbox' ? { user: 'gUser', password: 'p'.repeat(24) } : { user: 'x', password: 'y'.repeat(24) }) });
    expect((await call(d, 'production', 'HealthCheck')).status).toBe(401);
    expect((await call(d, 'sandbox', 'HealthCheck')).status).toBe(200);
  });
  it('405 on wrong verb, 404 on unknown method', async () => {
    expect((await call(mk(), 'sandbox', 'CreateBooking', undefined, { method: 'GET' })).status).toBe(405);
    expect((await call(mk(), 'sandbox', 'Nope', {})).status).toBe(404);
  });
  it('HealthCheck: 200 healthy, 503 when the database is down', async () => {
    expect((await call(mk(), 'sandbox', 'HealthCheck')).status).toBe(200);
    expect((await call(mk({ ping: async () => false }), 'sandbox', 'HealthCheck')).status).toBe(503);
    expect((await call(mk({ ping: async () => { throw new Error('x'); } }), 'sandbox', 'HealthCheck')).status).toBe(503);
  });
  it('429 when rate limited; 413 oversize; 400 malformed', async () => {
    expect((await call(mk({ allowRequest: async () => false }), 'sandbox', 'CreateBooking', {})).status).toBe(429);
    expect((await call(mk(), 'sandbox', 'CreateBooking', { x: 'a'.repeat(70_000) })).status).toBe(413);
    expect((await call(mk(), 'sandbox', 'CreateBooking', undefined, { body: '{not json' })).status).toBe(400);
  });
});

describe('int64', () => {
  it('accepts numeric strings and safe ints only', () => {
    expect(int64('1606359600')).toBe(1606359600);
    expect(int64(5)).toBe(5);
    for (const v of ['-1', '1.5', 'abc', '', -1, 1.5, 2 ** 60, null, undefined]) expect(int64(v)).toBeNull();
  });
});

describe('BatchAvailabilityLookup', () => {
  it('returns exactly one entry per slot, available for a published slot, echoing the slot_time', async () => {
    const body = fill(fx.batch_request, slot.start_sec);
    body.slot_time.push({ service_id: 'svc_ac-repair', start_sec: String(slot.start_sec + 7 * 3600 * 24), duration_sec: '3600' }); // not published
    body.slot_time.push({ service_id: 'svc_unknown', start_sec: String(slot.start_sec) });
    const r = await call(mk(), 'sandbox', 'BatchAvailabilityLookup', body);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.slot_time_availability).toHaveLength(3);
    expect(j.slot_time_availability.map((x: { available: boolean }) => x.available)).toEqual([true, false, false]);
    expect(j.slot_time_availability[0].slot_time).toMatchObject({ availability_tag: '5042328', confirmation_mode: 'CONFIRMATION_MODE_SYNCHRONOUS', start_sec: String(slot.start_sec) });
  });
  it('duration mismatch => unavailable', async () => {
    const body = fill(fx.batch_request, slot.start_sec); body.slot_time[0].duration_sec = '1800';
    expect((await (await call(mk(), 'sandbox', 'BatchAvailabilityLookup', body)).json()).slot_time_availability[0].available).toBe(false);
  });
  it('unknown / not-served merchants answer unavailable (200), never leak existence', async () => {
    const body = fill(fx.batch_request, slot.start_sec);
    for (const d of [mk({}, null), mk({}, snapshot({ feed_enabled: false })), mk({}, snapshot({ partner_status: 'applied' })), mk({}, snapshot({ partner_status: 'approved' }))]) {
      const j = await (await call(d, 'sandbox', 'BatchAvailabilityLookup', body)).json();
      expect(j.slot_time_availability[0].available).toBe(false);
    }
  });
  it('production serves only approved merchants', async () => {
    const body = fill(fx.batch_request, slot.start_sec);
    expect((await (await call(mk({}, snapshot({ partner_status: 'sandbox' })), 'production', 'BatchAvailabilityLookup', body)).json()).slot_time_availability[0].available).toBe(false);
    expect((await (await call(mk({}, snapshot({ partner_status: 'approved' })), 'production', 'BatchAvailabilityLookup', body)).json()).slot_time_availability[0].available).toBe(true);
  });
  it('FSM says busy => unavailable; FSM read fails => unavailable (fail closed)', async () => {
    const body = fill(fx.batch_request, slot.start_sec);
    const busy = mk({ fsmGate: async () => ({ allows: () => false }) });
    expect((await (await call(busy, 'sandbox', 'BatchAvailabilityLookup', body)).json()).slot_time_availability[0].available).toBe(false);
    const down = mk({ fsmGate: async () => { throw new Error('fsm_availability_http_500'); } });
    expect((await (await call(down, 'sandbox', 'BatchAvailabilityLookup', body)).json()).slot_time_availability[0].available).toBe(false);
    expect(down.log).toHaveBeenCalledWith('fsm_gate_failed', expect.anything());
  });
  it('validates input: empty, >200 slots, bad merchant, bad start_sec', async () => {
    const mkBody = (o: object) => ({ merchant_id: 'acme-hvac', slot_time: [{ service_id: 'a', start_sec: '1' }], ...o });
    for (const b of [mkBody({ slot_time: [] }), mkBody({ slot_time: Array(201).fill({ service_id: 'a', start_sec: '1' }) }), mkBody({ merchant_id: 'A B' }), mkBody({ slot_time: [{ service_id: 'a', start_sec: 'x' }] })]) {
      expect((await call(mk(), 'sandbox', 'BatchAvailabilityLookup', b)).status).toBe(400);
    }
  });
});

describe('CreateBooking', () => {
  it('sandbox: confirms with Google-shaped response and NEVER creates a job or touches the FSM', async () => {
    const d = mk();
    const r = await call(d, 'sandbox', 'CreateBooking', fill(fx.create_request, slot.start_sec));
    const j = await r.json();
    expect(j.booking).toMatchObject({ booking_id: BID, status: 'CONFIRMED', payment_information: { prepayment_status: 'PREPAYMENT_NOT_PROVIDED' } });
    expect(j.booking.slot.merchant_id).toBe('acme-hvac');
    expect(d.book).not.toHaveBeenCalled();
    expect(d.afterBooking).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith({ id: BID, jobId: null, sandbox: true });
  });
  it('production: books via the RPC with the channel details, completes the ledger, then triggers FSM write-back', async () => {
    const d = mk({}, snapshot({ partner_status: 'approved' }));
    const j = await (await call(d, 'production', 'CreateBooking', fill(fx.create_request, slot.start_sec))).json();
    expect(j.booking.booking_id).toBe(BID);
    expect(d.book).toHaveBeenCalledWith({ slug: 'acme-hvac', name: 'John Smith', phone: '+12091111111', email: 'john.smith@example.com', serviceName: 'AC Repair', startIso: new Date(slot.start_sec * 1000).toISOString() });
    expect(d.complete).toHaveBeenCalledWith({ id: BID, jobId: 'job-1', sandbox: false });
    expect(d.afterBooking).toHaveBeenCalledTimes(1);
  });
  it('idempotent replay returns the same booking without booking again', async () => {
    const d = mk({ claim: async () => ({ state: 'replay', id: BID, status: 'confirmed', job_id: 'job-1' }) }, snapshot({ partner_status: 'approved' }));
    const j = await (await call(d, 'production', 'CreateBooking', fill(fx.create_request, slot.start_sec))).json();
    expect(j.booking.booking_id).toBe(BID);
    expect(d.book).not.toHaveBeenCalled();
  });
  it('replay of a canceled booking => SLOT_UNAVAILABLE; in-flight => 503 + Retry-After; duplicate => OVERLAPPING_RESERVATION', async () => {
    const approved = snapshot({ partner_status: 'approved' });
    const b = fill(fx.create_request, slot.start_sec);
    expect((await (await call(mk({ claim: async () => ({ state: 'replay', id: BID, status: 'canceled', job_id: null }) }, approved), 'production', 'CreateBooking', b)).json()).booking_failure.cause).toBe('SLOT_UNAVAILABLE');
    const inflight = await call(mk({ claim: async () => ({ state: 'in_flight' }) }, approved), 'production', 'CreateBooking', b);
    expect(inflight.status).toBe(503); expect(inflight.headers.get('Retry-After')).toBe('2');
    expect((await (await call(mk({ claim: async () => ({ state: 'duplicate' }) }, approved), 'production', 'CreateBooking', b)).json()).booking_failure.cause).toBe('OVERLAPPING_RESERVATION');
    expect((await (await call(mk({ claim: async () => ({ state: 'mismatch' }) }, approved), 'production', 'CreateBooking', b)).json()).booking_failure.cause).toBe('CAUSE_UNSPECIFIED');
  });
  it('slot_taken (race) => HTTP 200 + booking_failure SLOT_UNAVAILABLE and the claim is released', async () => {
    const d = mk({ book: async () => ({ ok: false, reason: 'slot_taken' }) }, snapshot({ partner_status: 'approved' }));
    const r = await call(d, 'production', 'CreateBooking', fill(fx.create_request, slot.start_sec));
    expect(r.status).toBe(200);
    expect((await r.json()).booking_failure.cause).toBe('SLOT_UNAVAILABLE');
    expect(d.fail).toHaveBeenCalledWith(BID, 'slot_taken');
  });
  it('unexpected RPC error => 503 (Google retries) and claim marked failed', async () => {
    const d = mk({ book: async () => ({ ok: false, reason: 'error' }) }, snapshot({ partner_status: 'approved' }));
    expect((await call(d, 'production', 'CreateBooking', fill(fx.create_request, slot.start_sec))).status).toBe(503);
    expect(d.fail).toHaveBeenCalledWith(BID, 'error');
  });
  it('unpublished slot, wrong duration, FSM busy/down => SLOT_UNAVAILABLE and nothing is claimed', async () => {
    const approved = snapshot({ partner_status: 'approved' });
    const cases: Array<[BookingServerDeps, object]> = [
      [mk({}, approved), fill(fx.create_request, slot.start_sec + 60)],
      [mk({}, approved), (() => { const b = fill(fx.create_request, slot.start_sec); b.slot.duration_sec = '60'; return b; })()],
      [mk({ fsmGate: async () => ({ allows: () => false }) }, approved), fill(fx.create_request, slot.start_sec)],
      [mk({ fsmGate: async () => { throw new Error('down'); } }, approved), fill(fx.create_request, slot.start_sec)],
    ];
    for (const [d, b] of cases) {
      expect((await (await call(d, 'production', 'CreateBooking', b)).json()).booking_failure.cause).toBe('SLOT_UNAVAILABLE');
      expect(d.claim).not.toHaveBeenCalled();
      expect(d.book).not.toHaveBeenCalled();
    }
  });
  it('cross-tenant / wrong-status merchants cannot be booked', async () => {
    const b = fill(fx.create_request, slot.start_sec);
    for (const d of [mk({}, null), mk({}, snapshot({ feed_enabled: false })), mk({}, snapshot({ partner_status: 'applied' }))]) {
      expect((await (await call(d, 'sandbox', 'CreateBooking', b)).json()).booking_failure.cause).toBe('SLOT_UNAVAILABLE');
      expect(d.claim).not.toHaveBeenCalled();
    }
    const prodOnSandbox = mk({}, snapshot({ partner_status: 'sandbox' }));
    expect((await (await call(prodOnSandbox, 'production', 'CreateBooking', b)).json()).booking_failure).toBeTruthy();
    expect(prodOnSandbox.book).not.toHaveBeenCalled();
  });
  it('validates payload: missing token/slot (400), missing name or contact (booking_failure), strips control chars', async () => {
    const good = fill(fx.create_request, slot.start_sec);
    const noTok = { ...good }; delete noTok.idempotency_token;
    expect((await call(mk(), 'sandbox', 'CreateBooking', noTok)).status).toBe(400);
    expect((await call(mk(), 'sandbox', 'CreateBooking', { ...good, slot: {} })).status).toBe(400);
    const noName = { ...good, user_information: { telephone: '+1555' } };
    expect((await (await call(mk(), 'sandbox', 'CreateBooking', noName)).json()).booking_failure.cause).toBe('CAUSE_UNSPECIFIED');
    const noContact = { ...good, user_information: { given_name: 'A' } };
    expect((await (await call(mk(), 'sandbox', 'CreateBooking', noContact)).json()).booking_failure).toBeTruthy();
    const d = mk({}, snapshot({ partner_status: 'approved' }));
    await call(d, 'production', 'CreateBooking', { ...good, user_information: { ...good.user_information, given_name: 'Jo\u0000hn\n' } });
    expect((d.book as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe('Jo hn Smith');
  });
  it('does not log PII', async () => {
    const d = mk({ book: async () => ({ ok: false, reason: 'error' }) }, snapshot({ partner_status: 'approved' }));
    await call(d, 'production', 'CreateBooking', fill(fx.create_request, slot.start_sec));
    expect(JSON.stringify((d.log as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/Smith|john\.smith|209111/);
  });
});

describe('UpdateBooking', () => {
  it('cancel: returns CANCELED; sandbox route flags sandbox', async () => {
    const d = mk();
    const r = await call(d, 'sandbox', 'UpdateBooking', fill(fx.update_request, 0, BID));
    expect(await r.json()).toEqual({ booking: { booking_id: BID, status: 'CANCELED' } });
    expect(d.cancel).toHaveBeenCalledWith({ bookingId: BID, sandbox: true });
    await call(d, 'production', 'UpdateBooking', fill(fx.update_request, 0, BID));
    expect(d.cancel).toHaveBeenLastCalledWith({ bookingId: BID, sandbox: false });
  });
  it('already canceled is idempotent; unknown id 404; not cancellable => booking_failure', async () => {
    expect((await call(mk({ cancel: async () => ({ state: 'already_canceled' }) }), 'sandbox', 'UpdateBooking', fill(fx.update_request, 0, BID))).status).toBe(200);
    expect((await call(mk({ cancel: async () => ({ state: 'not_found' }) }), 'sandbox', 'UpdateBooking', fill(fx.update_request, 0, BID))).status).toBe(404);
    expect((await (await call(mk({ cancel: async () => ({ state: 'not_cancellable' }) }), 'sandbox', 'UpdateBooking', fill(fx.update_request, 0, BID))).json()).booking_failure).toBeTruthy();
  });
  it('rejects non-uuid ids (400) and reschedule attempts (booking_failure, no cancel)', async () => {
    expect((await call(mk(), 'sandbox', 'UpdateBooking', fill(fx.update_request, 0, 'not-a-uuid'))).status).toBe(400);
    const d = mk();
    const r = await call(d, 'sandbox', 'UpdateBooking', { booking: { booking_id: BID, status: 'CONFIRMED' } });
    expect((await r.json()).booking_failure).toBeTruthy();
    expect(d.cancel).not.toHaveBeenCalled();
  });
});
