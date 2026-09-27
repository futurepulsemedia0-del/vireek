import { supabase } from '@/lib/supabase';

export type JobStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed';

export const STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  en_route: 'En Route',
  in_progress: 'In Progress',
  completed: 'Completed',
};

export const STATUS_ORDER: JobStatus[] = ['scheduled', 'en_route', 'in_progress', 'completed'];

export function nextStatus(current: JobStatus): JobStatus | null {
  const idx = STATUS_ORDER.indexOf(current);
  return idx >= 0 && idx < STATUS_ORDER.length - 1 ? STATUS_ORDER[idx + 1] : null;
}

export interface TechnicianJob {
  id: string;
  customer_name: string;
  address: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: JobStatus;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  expected_duration_minutes: number | null;
  safety_flag: boolean;
}

export interface JobBrief {
  job: TechnicianJob & { notes: string | null; invoice_amount: number | null; safety_flag_note: string | null };
  customer: { id: string; name: string; phone: string | null; address: string | null; lifecycle_stage: string; tags: string[] } | null;
  equipment: Array<{ id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null; install_date: string | null; warranty_expires_at: string | null; warranty_notes: string | null; notes: string | null; status: string }>;
  previous_notes: Array<{ job_id: string; date: string | null; service_type: string | null; notes: string }>;
  warranty_claims: Array<{ id: string; status: string; manufacturer: string | null; model_number: string | null; failure_description: string | null }>;
  likely_diagnosis: { severity: string; confidence: number | null; ai_result: unknown; created_at: string } | null;
  customer_preferences: Array<{ category: string; fact: string }>;
  parts_check: Array<{ part_name: string; required_qty: number; on_hand_qty: number; shortage: number }>;
  error?: 'not_found' | 'forbidden';
}

export async function fetchTodayJobs(date?: string): Promise<TechnicianJob[]> {
  const { data, error } = await supabase.rpc('get_technician_today_jobs', date ? { p_date: date } : {});
  if (error) throw error;
  return (data || []) as TechnicianJob[];
}

export async function fetchJobBrief(jobId: string): Promise<JobBrief> {
  const { data, error } = await supabase.rpc('get_job_brief', { p_job_id: jobId });
  if (error) throw error;
  return data as JobBrief;
}

export async function advanceJobStatus(
  jobId: string,
  newStatus: JobStatus,
  note?: string,
  coords?: { lat: number; lng: number },
) {
  const { data, error } = await supabase.rpc('advance_job_status', {
    p_job_id: jobId,
    p_new_status: newStatus,
    p_note: note ?? null,
    p_lat: coords?.lat ?? null,
    p_lng: coords?.lng ?? null,
  });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

export async function setSafetyFlag(jobId: string, flag: boolean, note?: string) {
  const { data, error } = await supabase.rpc('set_job_safety_flag', { p_job_id: jobId, p_flag: flag, p_note: note ?? null });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

export async function addJobNote(jobId: string, note: string) {
  const { data, error } = await supabase.rpc('add_job_note', { p_job_id: jobId, p_note: note });
  if (error) throw error;
  return data as { success: boolean; error?: string };
}

export function mapsLink(address: string | null): string {
  return address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : '#';
}

export function telLink(phone: string | null): string {
  return phone ? `tel:${phone.replace(/[^0-9+]/g, '')}` : '#';
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
