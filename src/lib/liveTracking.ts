import { supabase } from '@/lib/supabase';
import { liveEtaMinutes } from '@/lib/dispatchIntelligence';

/**
 * Live ETA / Technician Tracking — client library.
 *
 * Same token-gated SECURITY DEFINER pattern as lib/reschedule.ts and
 * lib/customerPortal.ts: reads go through get_job_tracking(), which
 * validates the token server-side (see
 * supabase/migrations/20261107000000_live_eta_tracking.sql). Writes
 * (ETA, live position) come from the already-authenticated staff
 * dashboard via plain `supabase.from('jobs').update(...)`, the same
 * pattern JobsPage.tsx already uses for job_status/invoice/technician.
 */

export interface JobTracking {
  business_name: string | null;
  customer_name: string;
  service_type: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  scheduled_datetime: string | null;
  technician_name: string | null;
  technician_photo_url: string | null;
  eta_minutes: number | null;
  eta_set_at: string | null;
  technician_lat: number | null;
  technician_lng: number | null;
  location_updated_at: string | null;
  position_source: 'telematics' | 'technician' | null;
  site_lat: number | null;
  site_lng: number | null;
  arrival_window_start: string | null;
  arrival_window_end: string | null;
  arrived_at: string | null;
  can_reschedule: boolean;
  review_token: string | null;
  review_status: 'sent' | 'completed' | 'declined' | null;
  server_time: string | null;
}

export function getTrackingLink(token: string): string {
  return `${window.location.origin}/track/${token}`;
}

export async function fetchJobTracking(token: string): Promise<JobTracking | null> {
  const { data, error } = await supabase.rpc('get_job_tracking', { p_token: token });
  if (error || !data) return null;
  return data as JobTracking;
}

/** Minutes left in a technician-set ETA, counting down from when it was set. Null once expired. */
/** Minutes left in a technician-set ETA, counting down from when it was set (0 once elapsed). */
export function minutesRemaining(
  etaMinutes: number | null,
  etaSetAt: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (etaMinutes === null || !etaSetAt) return null;
  const setAt = new Date(etaSetAt).getTime();
  if (Number.isNaN(setAt)) return null;
  const remaining = etaMinutes - Math.floor((nowMs - setAt) / 60000);
  return remaining > 0 ? remaining : 0;
}

export const QUICK_ETA_OPTIONS = [5, 15, 30, 45, 60];

/** Staff-side: set/update the ETA shown to the customer for this job. */
export async function setJobEta(jobId: string, minutes: number): Promise<boolean> {
  const { error } = await supabase
    .from('jobs')
    .update({ eta_minutes: minutes, eta_set_at: new Date().toISOString() })
    .eq('id', jobId);
  return !error;
}

/** Staff-side: push the technician's current browser location onto the job. */
export async function pushTechnicianLocation(jobId: string, lat: number, lng: number): Promise<boolean> {
// ---------------------------------------------------------------------------
// "On my way" experience helpers (pure — unit-tested in liveTracking.test.ts)
// ---------------------------------------------------------------------------

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export type EtaSource = 'live' | 'technician';
export interface ResolvedEta {
  minutes: number;
  source: EtaSource;
}

/** Live GPS ETA when a fresh fix + site coordinates exist, else the technician-set countdown. */
export function resolveEta(t: JobTracking, nowMs: number = Date.now()): ResolvedEta | null {
  if (t.job_status !== 'en_route') return null;
  if (isNum(t.technician_lat) && isNum(t.technician_lng) && isNum(t.site_lat) && isNum(t.site_lng)) {
    const live = liveEtaMinutes(
      { lat: t.technician_lat, lng: t.technician_lng },
      { lat: t.site_lat, lng: t.site_lng },
      t.location_updated_at ?? null,
      nowMs,
    );
    if (live) return { minutes: live.minutes, source: 'live' };
  }
  const manual = minutesRemaining(t.eta_minutes ?? null, t.eta_set_at ?? null, nowMs);
  return manual === null ? null : { minutes: manual, source: 'technician' };
}

/** "Today, 9:00 AM – 10:00 AM" / "Wed, Mar 3, 9:00 AM – 10:00 AM". */
export function formatArrivalWindow(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  opts: { nowMs?: number; timeZone?: string; locale?: string } = {},
): string | null {
  if (!startIso) return null;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = endIso ? new Date(endIso) : null;
  const validEnd = end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime() ? end : null;
  const { nowMs = Date.now(), timeZone, locale } = opts;
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone });
  const day =
    dayKey.format(start) === dayKey.format(new Date(nowMs))
      ? 'Today'
      : new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(start);
  const range = validEnd ? `${time.format(start)} – ${time.format(validEnd)}` : time.format(start);
  return `${day}, ${range}`;
}

/** Human freshness of the last GPS fix; `stale` once older than 5 minutes. */
export function freshness(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): { label: string; stale: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 45) return { label: 'Updated just now', stale: false };
  if (sec < 3600) return { label: `Updated ${Math.max(1, Math.floor(sec / 60))} min ago`, stale: sec > 300 };
  return { label: 'Updated over an hour ago', stale: true };
}

/** OpenStreetMap embed centred on the technician; widens to include the job site when known. */
export function osmEmbedUrl(
  tech: { lat: number; lng: number },
  site?: { lat: number; lng: number } | null,
): string {
  const pts = site ? [tech, site] : [tech];
  const pad = site ? 0.01 : 0.02;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const bbox = [
    Math.min(...lngs) - pad,
    Math.min(...lats) - pad,
    Math.max(...lngs) + pad,
    Math.max(...lats) + pad,
  ]
    .map((n) => n.toFixed(5))
    .join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${tech.lat},${tech.lng}`)}`;
}

/** Token-gated + idempotent: returns the review token for a completed job, or null. */
export async function ensureReviewRequest(token: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('ensure_job_review_request', { p_token: token });
  if (error || typeof data !== 'string') return null;
  return data;
}
  const { error } = await supabase
    .from('jobs')
    .update({ technician_lat: lat, technician_lng: lng, location_updated_at: new Date().toISOString() })
    .eq('id', jobId);
  return !error;
}
