import { supabase } from '@/lib/supabase';
import type { BookingBusinessInfo } from '@/lib/onlineBooking';
import { submitPublicBooking } from '@/lib/onlineBooking';
import {
  EMPTY_BRANDING,
  generateSlots,
  sanitizeBranding,
  sanitizeHours,
  sanitizeIntake,
  settingsFromRow,
  settingsToPayload,
  type BookingBranding,
  type BookingProfileRow,
  type BookingSettings,
  type BusyInterval,
  type HoursMap,
  type IntakeQuestion,
} from '@/lib/bookingPolicy';

// ============================================================
// Dashboard side — every query is scoped to the ACCOUNT OWNER's id
// (business_profile.user_id), never the logged-in user's own id, so team
// members read and write the same row the owner does. RLS
// (get_account_owner_id()) enforces this again in Postgres.
// ============================================================

const PROFILE_COLUMNS = [
  'id', 'booking_slug', 'booking_enabled', 'booking_default_duration_minutes', 'booking_lead_time_hours',
  'booking_window_days', 'booking_buffer_before_minutes', 'booking_buffer_after_minutes', 'booking_hours',
  'booking_hidden_services', 'booking_deposit_cents', 'booking_deposit_policy', 'booking_intake_questions',
  'booking_branding', 'business_hours', 'services_offered', 'holidays',
].join(', ');

export interface LoadedBookingSettings {
  settings: BookingSettings;
  services: string[];
  holidays: string[];
  businessHours: HoursMap;
  hasProfile: boolean;
}

export async function loadBookingSettings(ownerId: string): Promise<LoadedBookingSettings> {
  const { data, error } = await supabase
    .from('business_profile')
    .select(PROFILE_COLUMNS)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as
    | (BookingProfileRow & { services_offered?: string[] | null; holidays?: { date?: string }[] | null })
    | null;
  return {
    settings: settingsFromRow(row),
    services: row?.services_offered ?? [],
    holidays: (row?.holidays ?? []).map((h) => h.date).filter((d): d is string => typeof d === 'string'),
    businessHours: sanitizeHours(row?.business_hours),
    hasProfile: Boolean(row),
  };
}

export type SaveResult = { ok: true } | { ok: false; reason: 'slug_taken' | 'unknown' };

export async function saveBookingSettings(
  ownerId: string,
  settings: BookingSettings,
  services: string[],
  hasProfile: boolean,
): Promise<SaveResult> {
  const payload = settingsToPayload(settings, services);
  const { error } = hasProfile
    ? await supabase.from('business_profile').update(payload).eq('user_id', ownerId)
    : await supabase.from('business_profile').insert({ user_id: ownerId, ...payload });
  if (!error) return { ok: true };
  if (error.code === '23505' || error.message?.includes('booking_slug')) return { ok: false, reason: 'slug_taken' };
  return { ok: false, reason: 'unknown' };
}

/** Real upcoming jobs for the account — feeds the "next open times" preview. */
export async function loadUpcomingBusy(ownerId: string, windowDays: number): Promise<BusyInterval[]> {
  const from = new Date();
  const to = new Date(from.getTime() + (windowDays + 1) * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('jobs')
    .select('scheduled_datetime, duration_minutes')
    .eq('user_id', ownerId)
    .in('job_status', ['scheduled', 'en_route', 'in_progress'])
    .gte('scheduled_datetime', new Date(from.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .lt('scheduled_datetime', to.toISOString());
  if (error) throw error;
  return ((data ?? []) as { scheduled_datetime: string; duration_minutes: number | null }[]).map((j) => ({
    start: new Date(j.scheduled_datetime),
    durationMinutes: j.duration_minutes ?? 60,
  }));
}

// ============================================================
// Public side — anonymous visitors on /book/:slug. Everything goes through
// SECURITY DEFINER RPCs (RLS stays closed to anon), same as the original
// booking engine.
// ============================================================

export interface PublicBookingSettings {
  hours: HoursMap | null;
  bufferBefore: number;
  bufferAfter: number;
  hiddenServices: string[];
  depositCents: number;
  depositPolicy: string;
  intake: IntakeQuestion[];
  branding: BookingBranding;
}

export const DEFAULT_PUBLIC_SETTINGS: PublicBookingSettings = {
  hours: null, bufferBefore: 0, bufferAfter: 0, hiddenServices: [], depositCents: 0, depositPolicy: '',
  intake: [], branding: EMPTY_BRANDING,
};

async function fetchPublicBookingSettings(slug: string): Promise<PublicBookingSettings | null> {
  const { data, error } = await supabase.rpc('get_booking_public_settings', { p_slug: slug });
  if (error || !data || typeof data !== 'object') return null; // migration not applied yet → legacy behaviour
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    hours: d.hours ? sanitizeHours(d.hours) : null,
    bufferBefore: num(d.buffer_before),
    bufferAfter: num(d.buffer_after),
    hiddenServices: Array.isArray(d.hidden_services) ? d.hidden_services.filter((s): s is string => typeof s === 'string') : [],
    depositCents: num(d.deposit_cents),
    depositPolicy: typeof d.deposit_policy === 'string' ? d.deposit_policy : '',
    intake: sanitizeIntake(d.intake_questions),
    branding: sanitizeBranding(d.branding),
  };
}

async function fetchBusyWindow(slug: string, start: Date, end: Date): Promise<BusyInterval[]> {
  const { data, error } = await supabase.rpc('get_booking_busy_window', {
    p_slug: slug, p_start: start.toISOString(), p_end: end.toISOString(),
  });
  if (error || !data) return [];
  return (data as { scheduled_datetime: string; duration_minutes: number | null }[]).map((r) => ({
    start: new Date(r.scheduled_datetime),
    durationMinutes: r.duration_minutes ?? 60,
  }));
}

export interface PublicBookingContext {
  settings: PublicBookingSettings;
  slots: Date[];
  services: string[];
}

/** One call for the public page: settings + real busy times -> bookable slots. */
export async function loadPublicBookingContext(slug: string, info: BookingBusinessInfo, now: Date = new Date()): Promise<PublicBookingContext> {
  const fetched = await fetchPublicBookingSettings(slug);
  const settings = fetched ?? DEFAULT_PUBLIC_SETTINGS;
  const end = new Date(now.getTime() + (info.window_days + 1) * 24 * 60 * 60 * 1000);
  const busy = await fetchBusyWindow(slug, new Date(now.getTime() - 24 * 60 * 60 * 1000), end);
  const slots = generateSlots(
    {
      hours: settings.hours ?? info.business_hours,
      holidays: (info.holidays ?? []).map((h) => h.date),
      durationMinutes: info.default_duration_minutes,
      leadTimeHours: info.lead_time_hours,
      windowDays: info.window_days,
      bufferBefore: settings.bufferBefore,
      bufferAfter: settings.bufferAfter,
    },
    busy,
    now,
  );
  const services = (info.services_offered ?? []).filter((s) => !settings.hiddenServices.includes(s));
  return { settings, slots, services };
}

export interface SubmitBookingInput {
  slug: string; customerName: string; customerPhone: string; customerEmail: string;
  serviceType: string; scheduledDatetime: Date; notes: string; channel: string; refCode?: string;
  intakeAnswers: Record<string, string>;
}

export type SubmitBookingResult =
  | { ok: true; depositDueCents: number }
  | { ok: false; reason: 'slot_taken' | 'too_soon' | 'unavailable' | 'service_unavailable' | 'intake_invalid' | 'unknown' };

export async function submitBookingWithSettings(input: SubmitBookingInput): Promise<SubmitBookingResult> {
  const { data, error } = await supabase.rpc('create_public_booking_with_settings', {
    p_slug: input.slug,
    p_customer_name: input.customerName.trim(),
    p_customer_phone: input.customerPhone.trim() || null,
    p_customer_email: input.customerEmail.trim() || null,
    p_service_type: input.serviceType || null,
    p_scheduled_datetime: input.scheduledDatetime.toISOString(),
    p_notes: input.notes.trim() || null,
    p_channel: input.channel,
    p_ref_code: input.refCode?.trim() || null,
    p_intake_answers: input.intakeAnswers,
  });

  if (error) {
    // Frontend deployed before the migration: fall back to the original flow.
    if (error.code === 'PGRST202' || error.code === '42883') {
      const legacy = await submitPublicBooking(input);
      return legacy.ok ? { ok: true, depositDueCents: 0 } : { ok: false, reason: legacy.reason as 'unknown' };
    }
    const m = error.message ?? '';
    if (m.includes('slot_taken')) return { ok: false, reason: 'slot_taken' };
    if (m.includes('too_soon')) return { ok: false, reason: 'too_soon' };
    if (m.includes('booking_not_available')) return { ok: false, reason: 'unavailable' };
    if (m.includes('service_unavailable')) return { ok: false, reason: 'service_unavailable' };
    if (m.includes('intake_')) return { ok: false, reason: 'intake_invalid' };
    return { ok: false, reason: 'unknown' };
  }
  const due = (data as { deposit_due_cents?: number } | null)?.deposit_due_cents;
  return { ok: true, depositDueCents: typeof due === 'number' ? due : 0 };
}
