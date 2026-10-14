import { supabase } from '@/lib/supabase';
import type { JobStatus } from '@/lib/technicianOS';

export interface ScheduleJob {
  id: string;
  customer_name: string;
  address: string | null;
  service_type: string | null;
  scheduled_datetime: string;
  job_status: JobStatus;
  expected_duration_minutes: number | null;
  safety_flag: boolean;
  latitude: number | null;
  longitude: number | null;
  route_sequence: number | null;
}

// ------------------------------------------------------------
// Week / day math (all in the device's local timezone, DST-safe)
// ------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday 00:00 (local) of the week containing `anchor`, shifted by `offsetWeeks`. */
export function weekStart(anchor: Date, offsetWeeks = 0): Date {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday + offsetWeeks * 7);
  return d;
}

export function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function weekRange(start: Date): { from: Date; to: Date } {
  return { from: start, to: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
}

// ------------------------------------------------------------
// Route order
// ------------------------------------------------------------

/** Persisted route_sequence first (nulls last), then scheduled time, then id for stability. */
export function orderStops(jobs: ScheduleJob[]): ScheduleJob[] {
  return [...jobs].sort((a, b) => {
    const sa = a.route_sequence ?? Number.POSITIVE_INFINITY;
    const sb = b.route_sequence ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ta = Date.parse(a.scheduled_datetime);
    const tb = Date.parse(b.scheduled_datetime);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

export function groupByDay(jobs: ScheduleJob[], days: Date[]): Map<string, ScheduleJob[]> {
  const map = new Map<string, ScheduleJob[]>(days.map((d) => [dayKey(d), []]));
  for (const job of jobs) {
    const bucket = map.get(dayKey(new Date(job.scheduled_datetime)));
    if (bucket) bucket.push(job);
  }
  for (const [key, list] of map) map.set(key, orderStops(list));
  return map;
}

export interface DaySummary {
  total: number;
  remaining: number;
  plannedMinutes: number;
}

export function summarizeDay(jobs: ScheduleJob[]): DaySummary {
  const open = jobs.filter((j) => j.job_status !== 'completed');
  return {
    total: jobs.length,
    remaining: open.length,
    plannedMinutes: open.reduce((sum, j) => sum + (j.expected_duration_minutes ?? 0), 0),
  };
}

// ------------------------------------------------------------
// Navigation links (coordinates preferred, address as fallback)
// ------------------------------------------------------------

export type MapProvider = 'google' | 'apple' | 'waze';

const isCoord = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n);

function destination(job: Pick<ScheduleJob, 'address' | 'latitude' | 'longitude'>): string | null {
  if (isCoord(job.latitude) && isCoord(job.longitude)) return `${job.latitude},${job.longitude}`;
  const addr = job.address?.trim();
  return addr ? addr : null;
}

export function stopNavUrl(
  job: Pick<ScheduleJob, 'address' | 'latitude' | 'longitude'>,
  provider: MapProvider = 'google',
): string | null {
  if (provider === 'waze') {
    return isCoord(job.latitude) && isCoord(job.longitude)
      ? `https://waze.com/ul?ll=${job.latitude},${job.longitude}&navigate=yes`
      : null;
  }
  const dest = destination(job);
  if (!dest) return null;
  const q = encodeURIComponent(dest);
  return provider === 'apple'
    ? `https://maps.apple.com/?daddr=${q}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
}

/** Google Maps allows an origin + destination + up to 9 waypoints. */
export const MAX_ROUTE_STOPS = 10;

export interface RouteNav {
  url: string;
  stops: number;
  truncated: boolean;
}

/** One multi-stop route over the remaining (not completed) stops, starting from the device location. */
export function routeNavUrl(orderedJobs: ScheduleJob[]): RouteNav | null {
  const points = orderedJobs
    .filter((j) => j.job_status !== 'completed')
    .map((j) => destination(j))
    .filter((p): p is string => p !== null);
  if (points.length === 0) return null;
  const used = points.slice(0, MAX_ROUTE_STOPS);
  const last = used[used.length - 1];
  const waypoints = used.slice(0, -1);
  let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(last)}&travelmode=driving`;
  if (waypoints.length > 0) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
  return { url, stops: used.length, truncated: points.length > used.length };
}

// ------------------------------------------------------------
// Data
// ------------------------------------------------------------

const STATUSES: JobStatus[] = ['scheduled', 'en_route', 'in_progress', 'completed'];

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Defensive normalisation: drop malformed rows rather than crash the screen. */
export function normalizeJobs(raw: unknown): ScheduleJob[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleJob[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r.id !== 'string' || typeof r.scheduled_datetime !== 'string') continue;
    if (Number.isNaN(Date.parse(r.scheduled_datetime))) continue;
    const status = STATUSES.includes(r.job_status as JobStatus) ? (r.job_status as JobStatus) : 'scheduled';
    out.push({
      id: r.id,
      customer_name: typeof r.customer_name === 'string' && r.customer_name ? r.customer_name : 'Customer',
      address: typeof r.address === 'string' && r.address.trim() ? r.address : null,
      service_type: typeof r.service_type === 'string' && r.service_type ? r.service_type : null,
      scheduled_datetime: r.scheduled_datetime,
      job_status: status,
      expected_duration_minutes: num(r.expected_duration_minutes),
      safety_flag: r.safety_flag === true,
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      route_sequence: num(r.route_sequence),
    });
  }
  return out;
}

export async function fetchWeekSchedule(start: Date): Promise<ScheduleJob[]> {
  const { from, to } = weekRange(start);
  const { data, error } = await supabase.rpc('get_technician_week_schedule', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return normalizeJobs(data);
}

// ------------------------------------------------------------
// Offline cache (per user + week; wiped on sign-out)
// ------------------------------------------------------------

const CACHE_PREFIX = 'vireek.tech.schedule.v1:';
const MAX_CACHED_WEEKS = 6;

export interface ScheduleCacheEntry {
  userId: string;
  fetchedAt: number;
  jobs: ScheduleJob[];
}

const cacheKey = (userId: string, start: Date) => `${CACHE_PREFIX}${userId}:${dayKey(start)}`;

export function readScheduleCache(userId: string, start: Date): ScheduleCacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId, start));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ScheduleCacheEntry>;
    if (parsed.userId !== userId || typeof parsed.fetchedAt !== 'number') return null;
    return { userId, fetchedAt: parsed.fetchedAt, jobs: normalizeJobs(parsed.jobs) };
  } catch {
    return null;
  }
}

export function writeScheduleCache(userId: string, start: Date, jobs: ScheduleJob[]): void {
  try {
    const entry: ScheduleCacheEntry = { userId, fetchedAt: Date.now(), jobs };
    localStorage.setItem(cacheKey(userId, start), JSON.stringify(entry));
    pruneScheduleCache();
  } catch {
    /* storage full or unavailable — the screen still works online */
  }
}

function pruneScheduleCache(): void {
  const keys: Array<{ key: string; at: number }> = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CACHE_PREFIX)) continue;
    let at = 0;
    try {
      at = (JSON.parse(localStorage.getItem(key) ?? '{}') as { fetchedAt?: number }).fetchedAt ?? 0;
    } catch {
      /* corrupt entry sorts oldest and is removed first */
    }
    keys.push({ key, at });
  }
  keys.sort((a, b) => b.at - a.at);
  for (const stale of keys.slice(MAX_CACHED_WEEKS)) localStorage.removeItem(stale.key);
}

/** Customer names and addresses are PII: call on sign-out. */
export function clearScheduleCache(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) doomed.push(key);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
