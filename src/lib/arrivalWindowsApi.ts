// Network layer for arrival windows. Pure logic lives in arrivalWindows.ts.
// Every call degrades gracefully when the migration has not been applied yet (PGRST202 / 42883 / 42P01):
// the public booking page falls back to exact-time booking and staff screens simply render nothing.

import { supabase } from '@/lib/supabase';
import { fetchBookedWindow, type BookingBusinessInfo } from '@/lib/onlineBooking';
import { generateSlots, sanitizeHours, type BusyInterval } from '@/lib/bookingPolicy';
import { submitBookingWithSettings, type SubmitBookingInput, type SubmitBookingResult } from '@/lib/bookingSettings';
import {
  DEFAULT_ARRIVAL_WINDOW_CONFIG,
  buildOfferedWindows,
  normalizeOnTimeRow,
  sanitizeGraceMinutes,
  sanitizeNarrowMinutes,
  sanitizeWindowOptions,
  type ArrivalWindow,
  type ArrivalWindowConfig,
  type OfferedWindow,
  type OnTimeRow,
} from '@/lib/arrivalWindows';

const MISSING_OBJECT_CODES = new Set(['PGRST202', '42883', '42P01', '42703']);
const isMissing = (e: { code?: string } | null | undefined) => !!e?.code && MISSING_OBJECT_CODES.has(e.code);

// ------------------------------------------------------------------ public booking

export interface ArrivalWindowOffers {
  optionsMinutes: number[];
  narrowMinutes: number;
  offers: Record<number, OfferedWindow[]>;
}

/** null = this business does not use arrival windows (or the migration is not applied): keep the exact-time flow. */
export async function loadArrivalWindowOffers(
  slug: string,
  info: BookingBusinessInfo,
  now: Date = new Date(),
): Promise<ArrivalWindowOffers | null> {
  const { data: cfg, error } = await supabase.rpc('get_arrival_window_public_config', { p_slug: slug });
  if (error || !cfg) return null;
  const optionsMinutes = sanitizeWindowOptions((cfg as { options_minutes?: unknown }).options_minutes);
  const narrowMinutes = sanitizeNarrowMinutes((cfg as { narrow_minutes?: unknown }).narrow_minutes);

  const { data: settings } = await supabase.rpc('get_booking_public_settings', { p_slug: slug });
  const s = (settings ?? {}) as { hours?: unknown; buffer_before?: number; buffer_after?: number };

  const end = new Date(now.getTime() + (info.window_days + 1) * 86_400_000);
  const from = new Date(now.getTime() - 86_400_000);
  const { data: busyRows, error: busyError } = await supabase.rpc('get_booking_busy_window', {
    p_slug: slug, p_start: from.toISOString(), p_end: end.toISOString(),
  });
  let busy: BusyInterval[];
  if (busyError || !busyRows) {
    busy = (await fetchBookedWindow(slug, from, end)).map((iso) => ({ start: new Date(iso), durationMinutes: 60 }));
  } else {
    busy = (busyRows as { scheduled_datetime: string; duration_minutes: number | null }[]).map((r) => ({
      start: new Date(r.scheduled_datetime), durationMinutes: r.duration_minutes ?? 60,
    }));
  }

  const hours = sanitizeHours(s.hours ?? info.business_hours);
  const holidays = (info.holidays ?? []).map((h) => h.date);
  const slots = generateSlots(
    {
      hours, holidays,
      durationMinutes: info.default_duration_minutes,
      leadTimeHours: info.lead_time_hours,
      windowDays: info.window_days,
      bufferBefore: s.buffer_before ?? 0,
      bufferAfter: s.buffer_after ?? 0,
    },
    busy, now, 1000, // default cap is 40 slots: far too few to tile 14 days into windows
  );

  const offers: Record<number, OfferedWindow[]> = {};
  for (const lengthMinutes of optionsMinutes) {
    offers[lengthMinutes] = buildOfferedWindows({
      slots, hours, holidays, lengthMinutes,
      leadTimeHours: info.lead_time_hours, windowDays: info.window_days, now,
    });
  }
  return { optionsMinutes, narrowMinutes, offers };
}

export type WindowBookingInput = Omit<SubmitBookingInput, 'scheduledDatetime'> & { window: OfferedWindow };
export type WindowBookingResult = SubmitBookingResult | { ok: false; reason: 'window_invalid' };

export async function submitBookingWithArrivalWindow(input: WindowBookingInput): Promise<WindowBookingResult> {
  const { window: w, ...rest } = input;
  const exactTime = () => submitBookingWithSettings({ ...rest, scheduledDatetime: w.anchor });

  const { data, error } = await supabase.rpc('create_public_booking_windowed', {
    p_slug: input.slug,
    p_customer_name: input.customerName.trim(),
    p_customer_phone: input.customerPhone.trim() || null,
    p_customer_email: input.customerEmail.trim() || null,
    p_service_type: input.serviceType || null,
    p_window_start: w.start.toISOString(),
    p_window_end: w.end.toISOString(),
    p_anchor: w.anchor.toISOString(),
    p_notes: input.notes.trim() || null,
    p_channel: input.channel,
    p_ref_code: input.refCode?.trim() || null,
    p_intake_answers: input.intakeAnswers,
  });

  if (error) {
    const m = error.message ?? '';
    // Migration not applied, or the owner switched windows off after the page loaded: book the exact time instead.
    if (isMissing(error) || m.includes('arrival_windows_disabled')) return exactTime();
    if (m.includes('window_invalid')) return { ok: false, reason: 'window_invalid' };
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

// ------------------------------------------------------------------ customer view

export interface CustomerArrivalWindow {
  window: ArrivalWindow;
  original: ArrivalWindow | null;
  narrowed: boolean;
  jobStatus: string;
}

export async function fetchJobArrivalWindow(token: string): Promise<CustomerArrivalWindow | null> {
  const { data, error } = await supabase.rpc('get_job_arrival_window', { p_token: token });
  if (error || !data) return null;
  const d = data as {
    window_start: string; window_end: string; original_start: string | null; original_end: string | null;
    narrowed: boolean; job_status: string;
  };
  return {
    window: { start: new Date(d.window_start), end: new Date(d.window_end) },
    original: d.original_start && d.original_end ? { start: new Date(d.original_start), end: new Date(d.original_end) } : null,
    narrowed: !!d.narrowed,
    jobStatus: d.job_status,
  };
}

// ------------------------------------------------------------------ staff

export type SetWindowStatus = 'ok' | 'unchanged' | 'not_found' | 'no_window' | 'not_editable' | 'invalid_window' | 'anchor_outside_window' | 'error';

export async function setJobArrivalWindow(jobId: string, w: ArrivalWindow): Promise<SetWindowStatus> {
  const { data, error } = await supabase.rpc('set_job_arrival_window', {
    p_job_id: jobId, p_start: w.start.toISOString(), p_end: w.end.toISOString(),
  });
  if (error) return 'error';
  return ((data as { status?: SetWindowStatus } | null)?.status ?? 'error');
}

export interface WindowNotificationRow {
  id: string;
  kind: 'confirmed' | 'narrowed' | 'changed';
  status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed';
  window_start: string;
  window_end: string;
  created_at: string;
  sent_at: string | null;
  error: string | null;
}

export async function fetchWindowNotifications(jobId: string, limit = 5): Promise<WindowNotificationRow[]> {
  const { data, error } = await supabase
    .from('arrival_window_notifications')
    .select('id, kind, status, window_start, window_end, created_at, sent_at, error')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return error || !data ? [] : (data as WindowNotificationRow[]);
}

export async function fetchOnTimeReport(from: Date, to: Date): Promise<OnTimeRow[] | null> {
  const { data, error } = await supabase.rpc('get_technician_on_time_report', {
    p_from: from.toISOString(), p_to: to.toISOString(),
  });
  if (error) return isMissing(error) ? [] : null; // null = real failure, [] = feature not installed yet
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeOnTimeRow);
}

// ------------------------------------------------------------------ settings

interface SettingsRow {
  arrival_windows_enabled: boolean | null;
  arrival_window_options_minutes: number[] | null;
  arrival_window_narrow_minutes: number | null;
  arrival_window_grace_minutes: number | null;
  arrival_window_notify_customer: boolean | null;
}

export async function loadArrivalWindowSettings(ownerId: string): Promise<ArrivalWindowConfig | null> {
  const { data, error } = await supabase
    .from('business_profile')
    .select('arrival_windows_enabled, arrival_window_options_minutes, arrival_window_narrow_minutes, arrival_window_grace_minutes, arrival_window_notify_customer')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) return null;
  const r = (data ?? {}) as Partial<SettingsRow>;
  return {
    enabled: !!r.arrival_windows_enabled,
    optionsMinutes: sanitizeWindowOptions(r.arrival_window_options_minutes),
    narrowMinutes: sanitizeNarrowMinutes(r.arrival_window_narrow_minutes ?? DEFAULT_ARRIVAL_WINDOW_CONFIG.narrowMinutes),
    graceMinutes: sanitizeGraceMinutes(r.arrival_window_grace_minutes),
    notifyCustomer: r.arrival_window_notify_customer ?? true,
  };
}

export async function saveArrivalWindowSettings(ownerId: string, c: ArrivalWindowConfig): Promise<boolean> {
  const { error } = await supabase
    .from('business_profile')
    .update({
      arrival_windows_enabled: c.enabled,
      arrival_window_options_minutes: sanitizeWindowOptions(c.optionsMinutes),
      arrival_window_narrow_minutes: sanitizeNarrowMinutes(c.narrowMinutes),
      arrival_window_grace_minutes: sanitizeGraceMinutes(c.graceMinutes),
      arrival_window_notify_customer: c.notifyCustomer,
    })
    .eq('user_id', ownerId);
  return !error;
}
