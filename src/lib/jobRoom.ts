import { supabase } from '@/lib/supabase';

/**
 * Live Service Room — client library.
 *
 * Same token-gated SECURITY DEFINER pattern as lib/customerPortal.ts and
 * lib/liveTracking.ts: reads go through get_job_room(), which validates the
 * token server-side (see supabase/migrations/20261210000000_customer_job_room.sql).
 * Reuses jobs.reschedule_token — the same secret already used for
 * /reschedule/:token and /track/:token — as the room's own token, so no
 * extra link has to be issued or copied.
 *
 * Staff-side writes (diagnosis, work performed, photos, quality check, next
 * maintenance, documents) go through the already-authenticated dashboard
 * using the same `supabase.from('jobs').update(...)` pattern JobsPage.tsx
 * already uses for job_status/invoice/technician — covered by jobs' existing
 * RLS, no new write policy needed.
 */

export type JobRoomStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';

export interface JobRoomQuoteLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface JobRoomQuote {
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  line_items: JobRoomQuoteLineItem[];
  tax_percent: number;
  valid_until: string | null;
  quote_token: string;
}

export interface JobRoomWarranty {
  equipment_type: string;
  make: string | null;
  model: string | null;
  warranty_expires_at: string | null;
  warranty_alert_stage: 'expiring_soon' | 'expired' | null;
}

export interface JobRoomDocument {
  name: string;
  url: string;
}

export interface JobRoom {
  business_name: string | null;
  customer_name: string;
  service_type: string | null;
  job_status: JobRoomStatus;
  scheduled_datetime: string | null;
  created_at: string;
  completed_at: string | null;

  technician_name: string | null;
  technician_role: string | null;
  eta_minutes: number | null;
  eta_set_at: string | null;
  technician_lat: number | null;
  technician_lng: number | null;

  diagnosis_notes: string | null;
  work_performed_notes: string | null;
  before_photos: string[];
  after_photos: string[];
  quality_check_passed: boolean | null;
  next_maintenance_date: string | null;
  documents: JobRoomDocument[];

  quote: JobRoomQuote | null;
  invoice_amount: number | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  payment_link_url: string | null;

  warranty: JobRoomWarranty | null;
}

export function getJobRoomLink(token: string): string {
  return `${window.location.origin}/service/${token}`;
}

export async function fetchJobRoom(token: string): Promise<JobRoom | null> {
  const { data, error } = await supabase.rpc('get_job_room', { p_token: token });
  if (error || !data) return null;
  return data as JobRoom;
}

/** Public storage path -> displayable URL for the job-room-photos bucket. */
export function jobRoomPhotoUrl(path: string): string {
  return supabase.storage.from('job-room-photos').getPublicUrl(path).data.publicUrl;
}

// ============================================================
// STAFF-SIDE WRITES (authenticated dashboard only)
// ============================================================

export interface JobRoomStaffPatch {
  diagnosis_notes?: string | null;
  work_performed_notes?: string | null;
  quality_check_passed?: boolean | null;
  next_maintenance_date?: string | null;
  documents?: JobRoomDocument[];
  quote_id?: string | null;
}

export async function updateJobRoomDetails(jobId: string, patch: JobRoomStaffPatch): Promise<boolean> {
  const { error } = await supabase.from('jobs').update(patch).eq('id', jobId);
  return !error;
}

/** Uploads one before/after photo to the caller's own folder in the public job-room-photos bucket. */
export async function uploadJobRoomPhoto(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('job-room-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function addJobRoomPhoto(jobId: string, slot: 'before' | 'after', currentPaths: string[], path: string): Promise<boolean> {
  const column = slot === 'before' ? 'before_photos' : 'after_photos';
  const { error } = await supabase.from('jobs').update({ [column]: [...currentPaths, path] }).eq('id', jobId);
  return !error;
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export type JobRoomStepState = 'done' | 'active' | 'pending';

export interface JobRoomStep {
  label: string;
  state: JobRoomStepState;
}

/** Builds the 9-step timeline shown at the top of the room, in order. */
export function buildJobRoomTimeline(room: JobRoom): JobRoomStep[] {
  const status = room.job_status;
  const cancelledOrNoShow = status === 'cancelled' || status === 'no_show';
  const step = (done: boolean, active: boolean): JobRoomStepState => (done ? 'done' : active ? 'active' : 'pending');

  const assigned = Boolean(room.technician_name);
  const enRouteOrLater = status === 'en_route' || status === 'in_progress' || status === 'completed';
  const workingOrLater = status === 'in_progress' || status === 'completed';
  const diagnosisDone = Boolean(room.diagnosis_notes);
  const quoteStatus = room.quote?.status;
  const approved = quoteStatus === 'accepted';
  const awaitingApproval = quoteStatus === 'sent';
  const qualityDone = room.quality_check_passed === true;
  const paid = room.invoice_status === 'paid';
  const invoiced = room.invoice_status === 'sent' || paid;

  return [
    { label: 'Request received', state: 'done' },
    { label: 'Technician assigned', state: step(assigned, false) },
    { label: 'Technician on the way', state: step(enRouteOrLater, status === 'en_route') },
    { label: 'Diagnosis completed', state: step(diagnosisDone, false) },
    { label: 'Awaiting approval', state: step(approved, awaitingApproval) },
    { label: 'Work in progress', state: step(status === 'completed', workingOrLater && status !== 'completed') },
    { label: 'Quality check', state: step(qualityDone, status === 'completed' && !qualityDone) },
    { label: 'Payment', state: step(paid, invoiced && !paid) },
    { label: 'Warranty', state: step(Boolean(room.warranty), false) },
  ].map((s) => (cancelledOrNoShow && s.state !== 'done' ? { ...s, state: 'pending' as const } : s));
}

export function quoteTotalCents(quote: JobRoomQuote): number {
  const subtotal = quote.line_items.reduce((sum, li) => sum + Math.max(0, li.quantity || 0) * Math.max(0, li.unit_price_cents || 0), 0);
  return Math.round(subtotal * (1 + (quote.tax_percent || 0) / 100));
}
