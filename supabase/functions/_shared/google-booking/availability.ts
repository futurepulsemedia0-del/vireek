// Google feed availability engine — pure, no imports, runs in Deno and Vitest.
//
// It mirrors the public booking engine (src/lib/bookingPolicy.ts generateSlots / isSlotFree: hours,
// holidays, lead time, window, duration grid, buffers, busy jobs) but evaluates every wall-clock time in
// the BUSINESS timezone (the browser engine uses the visitor's local zone) and then applies the capacity
// rules on top. It can only REMOVE slots relative to the booking engine, never add one, so the feed never
// promises something the booking engine would refuse.

export type BlockReason =
  | 'feed_disabled'
  | 'booking_disabled'
  | 'timezone_missing'
  | 'timezone_invalid'
  | 'hours_missing'
  | 'no_services';

export interface FeedSnapshot {
  generated_at: string;
  slug: string | null;
  business: { name: string | null; timezone: string | null; timezone_set: boolean; services: string[] };
  settings: {
    enabled: boolean;
    hours: Record<string, { open: string; close: string }> | null;
    holidays: string[];
    duration_minutes: number;
    lead_time_hours: number;
    window_days: number;
    buffer_before: number;
    buffer_after: number;
  };
  capacity: { technician_capacity: number; emergency_reserve: number; full_threshold_pct: number };
  google: { feed_enabled: boolean; structured_data_enabled: boolean; partner_status: string; horizon_days: number };
  busy: { start: string; duration_minutes: number }[];
  load_by_day: Record<string, number>;
}

export interface FeedSlot {
  start: string; // ISO-8601 UTC
  start_sec: number;
  duration_sec: number;
  local_date: string; // YYYY-MM-DD in the business timezone
  local_time: string; // HH:MM in the business timezone
}

export interface DaySummary { published: number; load: number; capacity_left: number | null }

export interface AvailabilityResult {
  blocked: BlockReason | null;
  timezone: string | null;
  capacity_mode: 'technician_capacity' | 'business_wide';
  slots: FeedSlot[];
  days: Record<string, DaySummary>;
}

const MIN = 60_000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try { fmt(tz); return true; } catch { return false; }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

function wallParts(ms: number, tz: string): Wall {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

function offsetAt(ms: number, tz: string): number {
  const base = Math.floor(ms / 1000) * 1000;
  const w = wallParts(base, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - base;
}

/** Wall-clock time in `tz` -> UTC ms. Returns null when that wall time does not exist (DST gap). */
export function zonedWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t1 = guess - offsetAt(guess, tz);
  const t2 = guess - offsetAt(t1, tz);
  for (const t of [t2, t1]) {
    const w = wallParts(t, tz);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi) return t;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

export function computeFeedAvailability(
  snap: FeedSnapshot,
  now: Date = new Date(),
  opts: { requirePublished?: boolean; maxSlots?: number } = {},
): AvailabilityResult {
  const s = snap.settings;
  const tz = snap.business.timezone;
  const capacity = snap.capacity.technician_capacity > 0 ? snap.capacity.technician_capacity : 0;
  const result: AvailabilityResult = {
    blocked: null, timezone: isValidTimeZone(tz) ? tz : null,
    capacity_mode: capacity > 0 ? 'technician_capacity' : 'business_wide', slots: [], days: {},
  };

  const hours = s.hours && typeof s.hours === 'object' ? s.hours : null;
  if (opts.requirePublished && !snap.google.feed_enabled) result.blocked = 'feed_disabled';
  else if (!s.enabled) result.blocked = 'booking_disabled';
  else if (!snap.business.timezone_set) result.blocked = 'timezone_missing';
  else if (!result.timezone) result.blocked = 'timezone_invalid';
  else if (!hours || Object.keys(hours).length === 0) result.blocked = 'hours_missing';
  else if (!snap.business.services || snap.business.services.length === 0) result.blocked = 'no_services';
  if (result.blocked || !result.timezone || !hours) return result;

  const zone = result.timezone;
  const duration = s.duration_minutes > 0 ? s.duration_minutes : 60;
  const nowMs = now.getTime();
  const earliest = nowMs + s.lead_time_hours * 60 * MIN;
  const horizonDays = Math.max(0, Math.min(s.window_days, snap.google.horizon_days));
  const latest = nowMs + horizonDays * 24 * 60 * MIN;
  const maxSlots = opts.maxSlots ?? 400;
  const holidays = new Set(s.holidays);
  const busy = snap.busy
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.start).getTime() + (b.duration_minutes || 60) * MIN }))
    .filter((b) => Number.isFinite(b.start));

  const free = (t: number) => {
    const end = t + duration * MIN;
    return !busy.some((b) => b.start < end + s.buffer_after * MIN && b.end > t - s.buffer_before * MIN);
  };

  const today = wallParts(nowMs, zone);
  for (let i = 0; i <= horizonDays && result.slots.length < maxSlots; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const key = dateKey(y, mo, d);
    const window = (hours as Record<string, { open: string; close: string } | undefined>)[DAY_KEYS[day.getUTCDay()]];
    if (!window || holidays.has(key)) continue;
    const openMin = parseTime(window.open);
    const closeMin = parseTime(window.close);
    if (openMin === null || closeMin === null) continue;

    const load = snap.load_by_day[key] ?? 0;
    let allowed = Number.POSITIVE_INFINITY;
    if (capacity > 0) {
      const normalLeft = Math.max(0, capacity - load - snap.capacity.emergency_reserve);
      const full = (load / capacity) * 100 >= snap.capacity.full_threshold_pct;
      allowed = full ? 0 : normalLeft;
    }

    let published = 0;
    for (let startMin = openMin; startMin + duration <= closeMin; startMin += duration) {
      if (published >= allowed || result.slots.length >= maxSlots) break;
      const t = zonedWallToUtcMs(y, mo, d, Math.floor(startMin / 60), startMin % 60, zone);
      if (t === null || t < earliest || t > latest || !free(t)) continue;
      result.slots.push({
        start: new Date(t).toISOString(), start_sec: Math.floor(t / 1000), duration_sec: duration * 60,
        local_date: key, local_time: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`,
      });
      published++;
    }
    result.days[key] = {
      published, load, capacity_left: capacity > 0 ? Math.max(0, capacity - load - snap.capacity.emergency_reserve) : null,
    };
  }
  return result;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
