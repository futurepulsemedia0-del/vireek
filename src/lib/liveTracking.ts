import { supabase } from '@/lib/supabase';

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
  eta_minutes: number | null;
  eta_set_at: string | null;
  technician_lat: number | null;
  technician_lng: number | null;
  location_updated_at: string | null;
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
export function minutesRemaining(etaMinutes: number | null, etaSetAt: string | null): number | null {
  if (etaMinutes === null || !etaSetAt) return null;
  const elapsedMs = Date.now() - new Date(etaSetAt).getTime();
  const remaining = etaMinutes - Math.floor(elapsedMs / 60000);
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
  const { error } = await supabase
    .from('jobs')
    .update({ technician_lat: lat, technician_lng: lng, location_updated_at: new Date().toISOString() })
    .eq('id', jobId);
  return !error;
}
