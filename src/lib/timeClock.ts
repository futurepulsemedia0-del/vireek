// Technician time clock — pure logic (no Supabase, no DOM).
//
// The device records an ordered list of events (clock in/out, break start/end,
// switch job). The same rules run here (instant UI, works offline) and in the
// database (apply_time_events), so a replayed queue gives the same hours.

export type ClockEventType = 'clock_in' | 'clock_out' | 'break_start' | 'break_end' | 'switch_job';

export interface ClockEvent {
  /** Idempotency key — the server ignores an event id it has already seen. */
  id: string;
  type: ClockEventType;
  /** ISO timestamp captured on the device when the button was pressed. */
  at: string;
  shift_id: string;
  job_id?: string | null;
  /** Local calendar date of the clock-in (YYYY-MM-DD); clock_in only. */
  work_date?: string;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  gps_error?: GpsError | null;
}

export interface ShiftView {
  id: string;
  workDate: string;
  clockInAt: number;
  clockOutAt: number | null;
  breaks: { startAt: number; endAt: number | null }[];
  segments: { jobId: string | null; startAt: number; endAt: number | null }[];
}

export type ClockStatus = 'off' | 'working' | 'on_break';

export interface ServerShiftJson {
  id: string;
  work_date: string;
  clock_in_at: string;
  breaks: { started_at: string; ended_at: string | null }[];
  segments: { job_id: string | null; started_at: string; ended_at: string | null }[];
}

export const CLOCK_ERROR_COPY: Record<string, string> = {
  tc_already_clocked_in: 'You were already clocked in on another device.',
  tc_no_open_shift: 'There was no open shift to apply this to.',
  tc_already_on_break: 'A break was already running.',
  tc_not_on_break: 'There was no break running.',
  tc_same_job: 'You were already on that job.',
  tc_out_of_order: 'The times did not line up with earlier entries.',
  tc_overlaps_previous_shift: 'This overlaps a shift that is already saved.',
  tc_duplicate_shift: 'This shift was already saved.',
  tc_wrong_shift: 'This belonged to a different shift.',
  tc_invalid_job: 'That job is not part of your company account.',
  tc_clock_skew: "Your device clock is ahead of the server's. Fix the time and try again.",
  tc_too_old: 'This entry is older than 14 days, so it could not be saved. Ask your manager to add it.',
  tc_zero_length: 'A shift must be longer than zero minutes.',
  tc_no_employee: 'Your account is not linked to a payroll employee yet.',
  tc_not_a_team_member: 'Your account is not set up as a technician.',
  tc_invalid_event: 'This entry was not valid.',
};

export function clockErrorCopy(code: string | null | undefined): string {
  return (code && CLOCK_ERROR_COPY[code]) || 'This entry could not be saved.';
}

// ------------------------------------------------------------------
// State machine (mirrors _tc_apply_event)
// ------------------------------------------------------------------

export function viewFromServer(json: ServerShiftJson | null): ShiftView | null {
  if (!json) return null;
  return {
    id: json.id,
    workDate: json.work_date,
    clockInAt: Date.parse(json.clock_in_at),
    clockOutAt: null,
    breaks: json.breaks.map((b) => ({ startAt: Date.parse(b.started_at), endAt: b.ended_at ? Date.parse(b.ended_at) : null })),
    segments: json.segments.map((s) => ({ jobId: s.job_id, startAt: Date.parse(s.started_at), endAt: s.ended_at ? Date.parse(s.ended_at) : null })),
  };
}

type ApplyResult = { ok: true; view: ShiftView | null } | { ok: false; code: string };

function lastTouch(v: ShiftView): number {
  let last = v.clockInAt;
  for (const b of v.breaks) last = Math.max(last, b.startAt, b.endAt ?? 0);
  for (const s of v.segments) last = Math.max(last, s.startAt, s.endAt ?? 0);
  return last;
}

const isOpen = (v: ShiftView | null): boolean => v !== null && v.clockOutAt === null;

export function applyEvent(view: ShiftView | null, ev: ClockEvent): ApplyResult {
  const at = Date.parse(ev.at);
  if (!Number.isFinite(at)) return { ok: false, code: 'tc_invalid_event' };

  if (ev.type === 'clock_in') {
    if (isOpen(view)) return { ok: false, code: 'tc_already_clocked_in' };
    if (view && view.clockOutAt !== null && at < view.clockOutAt) return { ok: false, code: 'tc_overlaps_previous_shift' };
    if (!ev.work_date) return { ok: false, code: 'tc_invalid_event' };
    return {
      ok: true,
      view: { id: ev.shift_id, workDate: ev.work_date, clockInAt: at, clockOutAt: null, breaks: [], segments: [{ jobId: ev.job_id ?? null, startAt: at, endAt: null }] },
    };
  }

  if (!view || view.clockOutAt !== null) return { ok: false, code: 'tc_no_open_shift' };
  if (ev.shift_id !== view.id) return { ok: false, code: 'tc_wrong_shift' };
  if (at < lastTouch(view)) return { ok: false, code: 'tc_out_of_order' };

  const openBreak = view.breaks.find((b) => b.endAt === null);
  const openSeg = view.segments.find((s) => s.endAt === null);

  switch (ev.type) {
    case 'break_start':
      if (openBreak) return { ok: false, code: 'tc_already_on_break' };
      return { ok: true, view: { ...view, breaks: [...view.breaks, { startAt: at, endAt: null }] } };
    case 'break_end':
      if (!openBreak) return { ok: false, code: 'tc_not_on_break' };
      return { ok: true, view: { ...view, breaks: view.breaks.map((b) => (b === openBreak ? { ...b, endAt: at } : b)) } };
    case 'switch_job': {
      const next = ev.job_id ?? null;
      if ((openSeg?.jobId ?? null) === next) return { ok: false, code: 'tc_same_job' };
      return {
        ok: true,
        view: { ...view, segments: [...view.segments.map((s) => (s === openSeg ? { ...s, endAt: at } : s)), { jobId: next, startAt: at, endAt: null }] },
      };
    }
    case 'clock_out':
      if (at <= view.clockInAt) return { ok: false, code: 'tc_zero_length' };
      return {
        ok: true,
        view: {
          ...view,
          clockOutAt: at,
          breaks: view.breaks.map((b) => (b.endAt === null ? { ...b, endAt: at } : b)),
          segments: view.segments.map((s) => (s.endAt === null ? { ...s, endAt: at } : s)),
        },
      };
    default:
      return { ok: false, code: 'tc_invalid_event' };
  }
}

/** Folds pending events over the last server snapshot; impossible events are skipped (the server rejects them too). */
export function foldEvents(base: ShiftView | null, events: ClockEvent[]): { view: ShiftView | null; skipped: { event: ClockEvent; code: string }[] } {
  let view = base;
  const skipped: { event: ClockEvent; code: string }[] = [];
  for (const ev of events) {
    const r = applyEvent(view, ev);
    if (r.ok) view = r.view;
    else skipped.push({ event: ev, code: r.code });
  }
  return { view, skipped };
}

export function clockStatus(view: ShiftView | null): ClockStatus {
  if (!view || view.clockOutAt !== null) return 'off';
  return view.breaks.some((b) => b.endAt === null) ? 'on_break' : 'working';
}

export function currentJobId(view: ShiftView | null): string | null {
  if (!view || view.clockOutAt !== null) return null;
  return view.segments.find((s) => s.endAt === null)?.jobId ?? null;
}

// ------------------------------------------------------------------
// Durations
// ------------------------------------------------------------------

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function segmentNetMs(view: ShiftView, seg: { startAt: number; endAt: number | null }, now: number): number {
  const end = seg.endAt ?? view.clockOutAt ?? now;
  const gross = Math.max(0, end - seg.startAt);
  const onBreak = view.breaks.reduce((s, b) => s + overlap(seg.startAt, end, b.startAt, b.endAt ?? view.clockOutAt ?? now), 0);
  return Math.max(0, gross - onBreak);
}

export function netMs(view: ShiftView | null, now: number): number {
  return view ? view.segments.reduce((s, seg) => s + segmentNetMs(view, seg, now), 0) : 0;
}

export function breakMs(view: ShiftView | null, now: number): number {
  return view ? view.breaks.reduce((s, b) => s + Math.max(0, (b.endAt ?? view.clockOutAt ?? now) - b.startAt), 0) : 0;
}

export function jobBreakdown(view: ShiftView | null, now: number): { jobId: string | null; ms: number }[] {
  if (!view) return [];
  const byJob = new Map<string | null, number>();
  for (const seg of view.segments) byJob.set(seg.jobId, (byJob.get(seg.jobId) ?? 0) + segmentNetMs(view, seg, now));
  return [...byJob.entries()].map(([jobId, ms]) => ({ jobId, ms })).filter((r) => r.ms > 0);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatHoursMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// ------------------------------------------------------------------
// Dates (local calendar, never shifted by the UTC offset)
// ------------------------------------------------------------------

export function localDateIso(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday of the week containing the given YYYY-MM-DD (matches the database's overtime week). */
export function weekStartIso(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export interface ClosedShiftLite {
  work_date: string;
  net_minutes: number | null;
}

export function weekMinutes(shifts: ClosedShiftLite[], todayIso: string): number {
  const start = weekStartIso(todayIso);
  return shifts.filter((s) => weekStartIso(s.work_date) === start).reduce((sum, s) => sum + (s.net_minutes ?? 0), 0);
}

// ------------------------------------------------------------------
// GPS
// ------------------------------------------------------------------

export type GpsError = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export type GpsFix = { ok: true; lat: number; lng: number; accuracy: number } | { ok: false; error: GpsError };

export type FixQuality = 'good' | 'fair' | 'poor';

export function fixQuality(accuracyMeters: number): FixQuality {
  return accuracyMeters <= 50 ? 'good' : accuracyMeters <= 150 ? 'fair' : 'poor';
}

interface GeolocationLike {
  getCurrentPosition(ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void, err: (e: { code: number }) => void, opts?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number }): void;
}

/** One fix, never throws. Clocking is never blocked by GPS — a failure is recorded on the event instead. */
export function getCurrentFix(geo: GeolocationLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.geolocation, timeoutMs = 10_000): Promise<GpsFix> {
  if (!geo) return Promise.resolve({ ok: false, error: 'unsupported' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (fix: GpsFix) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(fix);
    };
    // Some browsers never call back (permission prompt ignored) — the guard keeps the UI moving.
    const guard = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs + 2_000);
    try {
      geo.getCurrentPosition(
        (p) => done({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => done({ ok: false, error: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
      );
    } catch {
      done({ ok: false, error: 'unavailable' });
    }
  });
}

export const GPS_ERROR_COPY: Record<GpsError, string> = {
  denied: 'Location permission is off, so this was saved without GPS. Turn it on in your browser or phone settings.',
  unavailable: 'No GPS signal — saved without a location.',
  timeout: 'GPS took too long — saved without a location.',
  unsupported: 'This device does not support location — saved without GPS.',
};

// ------------------------------------------------------------------
// Event construction
// ------------------------------------------------------------------

export function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && 'randomUUID' in c) return c.randomUUID();
  const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function buildEvent(
  type: ClockEventType,
  shiftId: string,
  nowMs: number,
  extra: { jobId?: string | null; fix?: GpsFix } = {},
): ClockEvent {
  const ev: ClockEvent = { id: newId(), type, at: new Date(nowMs).toISOString(), shift_id: shiftId };
  if (type === 'clock_in') ev.work_date = localDateIso(nowMs);
  if (type === 'clock_in' || type === 'switch_job') ev.job_id = extra.jobId ?? null;
  if (extra.fix) {
    if (extra.fix.ok) {
      ev.lat = extra.fix.lat;
      ev.lng = extra.fix.lng;
      ev.accuracy = Math.round(extra.fix.accuracy);
    } else {
      ev.gps_error = extra.fix.error;
    }
  }
  return ev;
}
