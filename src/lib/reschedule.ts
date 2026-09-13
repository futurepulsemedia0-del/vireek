import { supabase } from '@/lib/supabase';

export interface RescheduleJobInfo {
  job_id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  job_status: string;
  business_name: string | null;
  allow_reschedule: boolean;
}

export function getRescheduleLink(token: string): string {
  return `${window.location.origin}/reschedule/${token}`;
}

export async function fetchJobForReschedule(token: string): Promise<RescheduleJobInfo | null> {
  const { data, error } = await supabase.rpc('get_job_for_reschedule', { p_token: token });
  if (error || !data || data.length === 0) return null;
  return data[0] as RescheduleJobInfo;
}

export async function fetchBookedSlots(token: string, start: Date, end: Date): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_business_booked_slots', {
    p_token: token,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error || !data) return [];
  return (data as { scheduled_datetime: string }[]).map((r) => r.scheduled_datetime);
}

export async function submitReschedule(token: string, newDatetime: Date): Promise<boolean> {
  const { data, error } = await supabase.rpc('reschedule_job_by_token', {
    p_token: token,
    p_new_datetime: newDatetime.toISOString(),
  });
  if (error) return false;
  return Boolean(data);
}

const SLOT_HOURS = [9, 11, 13, 15];

/** Simple candidate slots for the next N weekdays (skips Sunday), minus already-booked times. */
export function generateCandidateSlots(daysAhead: number, bookedIso: string[]): Date[] {
  const booked = new Set(bookedIso.map((iso) => new Date(iso).getTime()));
  const slots: Date[] = [];

  for (let d = 1; d <= daysAhead && slots.length < 12; d++) {
    const day = new Date();
    day.setDate(day.getDate() + d);
    if (day.getDay() === 0) continue;

    for (const hour of SLOT_HOURS) {
      const slot = new Date(day);
      slot.setHours(hour, 0, 0, 0);
      if (slot.getTime() > Date.now() && !booked.has(slot.getTime())) {
        slots.push(slot);
      }
    }
  }
  return slots;
}
