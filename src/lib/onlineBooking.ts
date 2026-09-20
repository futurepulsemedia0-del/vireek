import { supabase } from '@/lib/supabase';

export interface BookingBusinessInfo {
  business_name: string | null;
  services_offered: string[] | null;
  business_hours: Record<string, { open: string; close: string }> | null;
  holidays: { id: string; date: string; label?: string }[] | null;
  default_duration_minutes: number;
  lead_time_hours: number;
  window_days: number;
  booking_enabled: boolean;
}

export function getBookingLink(slug: string, channel?: string): string {
  const url = `${window.location.origin}/book/${slug}`;
  return channel ? `${url}?src=${channel}` : url;
}

export async function fetchBookingBusiness(slug: string): Promise<BookingBusinessInfo | null> {
  const { data, error } = await supabase.rpc('get_business_for_booking', { p_slug: slug });
  if (error || !data || data.length === 0) return null;
  return data[0] as BookingBusinessInfo;
}

export async function fetchBookedWindow(slug: string, start: Date, end: Date): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_booking_window_slots', {
    p_slug: slug, p_start: start.toISOString(), p_end: end.toISOString(),
  });
  if (error || !data) return [];
  return (data as { scheduled_datetime: string }[]).map((r) => r.scheduled_datetime);
}

export interface SubmitBookingInput {
  slug: string; customerName: string; customerPhone: string; customerEmail: string;
  serviceType: string; scheduledDatetime: Date; notes: string; channel: string; refCode?: string;
}

export async function submitPublicBooking(input: SubmitBookingInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await supabase.rpc('create_public_booking', {
    p_slug: input.slug,
    p_customer_name: input.customerName.trim(),
    p_customer_phone: input.customerPhone.trim() || null,
    p_customer_email: input.customerEmail.trim() || null,
    p_service_type: input.serviceType || null,
    p_scheduled_datetime: input.scheduledDatetime.toISOString(),
    p_notes: input.notes.trim() || null,
    p_channel: input.channel,
    p_ref_code: input.refCode?.trim() || null,
  });
  if (error) {
    if (error.message.includes('slot_taken')) return { ok: false, reason: 'slot_taken' };
    if (error.message.includes('too_soon')) return { ok: false, reason: 'too_soon' };
    if (error.message.includes('booking_not_available')) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'unknown' };
  }
  return { ok: true };
}

// Real slot engine: uses actual business_hours/holidays/lead-time/duration
// instead of hardcoded hours (unlike src/lib/reschedule.ts's fixed [9,11,13,15] —
// worth porting that file to this same engine later, not touched here).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function generateAvailableSlots(business: BookingBusinessInfo, bookedIso: string[], now: Date = new Date()): Date[] {
  const booked = new Set(bookedIso.map((iso) => new Date(iso).getTime()));
  const earliestBookable = new Date(now.getTime() + business.lead_time_hours * 60 * 60 * 1000);
  const holidaySet = new Set((business.holidays ?? []).map((h) => h.date));
  const duration = business.default_duration_minutes || 60;
  const slots: Date[] = [];

  for (let d = 0; d <= business.window_days && slots.length < 40; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const hours = business.business_hours?.[DAY_KEYS[day.getDay()]];
    if (!hours) continue;
    if (holidaySet.has(day.toISOString().slice(0, 10))) continue;

    const [openH, openM] = hours.open.split(':').map(Number);
    const [closeH, closeM] = hours.close.split(':').map(Number);
    const cursor = new Date(day);
    cursor.setHours(openH, openM, 0, 0);
    const closeAt = new Date(day);
    closeAt.setHours(closeH, closeM, 0, 0);

    while (cursor.getTime() + duration * 60 * 1000 <= closeAt.getTime()) {
      if (cursor.getTime() >= earliestBookable.getTime() && !booked.has(cursor.getTime())) {
        slots.push(new Date(cursor));
      }
      cursor.setMinutes(cursor.getMinutes() + duration);
    }
  }
  return slots;
}
