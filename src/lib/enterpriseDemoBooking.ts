import { supabase } from '@/lib/supabase';

/**
 * Backs `@/components/EnterpriseDemoBookingCalendar.tsx` (used on
 * /contact and /demo). This file did not exist yet — the component
 * imported it, but nothing ever implemented it, so the app failed to
 * build wherever that component was reachable.
 *
 * Requires the `demo_bookings` table + `get_booked_demo_slot_starts()`
 * function — see
 * supabase/migrations/20260911090000_create_demo_bookings.sql.
 * Without that migration, `getEnterpriseDemoOpenSlots` will still return
 * slots (it degrades to "no bookings on record yet" instead of throwing),
 * but `bookEnterpriseDemoSlot` will fail because the table won't exist.
 */

export interface DemoSlot {
  start: Date;
  end: Date;
}

export interface BookEnterpriseDemoSlotParams {
  fullName: string;
  workEmail: string;
  companyName: string;
  phone?: string;
  teamSize?: string;
  message?: string;
  slotStart: Date;
}

export type BookEnterpriseDemoSlotResult =
  | { ok: true }
  | { ok: false; reason: 'SLOT_NOT_AVAILABLE' | 'INVALID_EMAIL' | 'UNKNOWN' };

const SLOT_MINUTES = 30;
const BUSINESS_START_HOUR = 9; // 9:00 AM, visitor's local time
const BUSINESS_END_HOUR = 17; // last slot starts 4:30 PM, ends 5:00 PM
const MIN_LEAD_TIME_HOURS = 4; // don't offer a slot less than 4h from now

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every candidate weekday, business-hours, 30-minute slot in [rangeStart,
 * rangeEnd) — before filtering out ones that are already booked or too
 * soon. Pure/local: no network call, matches whatever timezone the
 * Date objects were constructed in (the component passes local time).
 */
function generateCandidateSlots(rangeStart: Date, rangeEnd: Date): DemoSlot[] {
  const slots: DemoSlot[] = [];
  const day = new Date(rangeStart);
  day.setHours(0, 0, 0, 0);

  while (day < rangeEnd) {
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) {
      for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
        for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
          const start = new Date(day);
          start.setHours(hour, minute, 0, 0);
          if (start < rangeStart || start >= rangeEnd) continue;
          const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
          slots.push({ start, end });
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }

  return slots;
}

/**
 * Fetches every open (weekday, business-hours, not-already-booked,
 * not-too-soon) 30-minute slot in the given window. Reads only booked
 * *times* via a PII-free RPC (`get_booked_demo_slot_starts`) — never the
 * underlying leads table directly, since that's not something an
 * anonymous visitor should be able to query.
 */
export async function getEnterpriseDemoOpenSlots(rangeStart: Date, rangeEnd: Date): Promise<DemoSlot[]> {
  const candidates = generateCandidateSlots(rangeStart, rangeEnd);
  const earliestAllowed = Date.now() + MIN_LEAD_TIME_HOURS * 60 * 60 * 1000;

  const { data: booked, error } = await supabase.rpc('get_booked_demo_slot_starts', {
    p_start: rangeStart.toISOString(),
    p_end: rangeEnd.toISOString(),
  });

  if (error) {
    // If the RPC/table genuinely doesn't exist yet (migration not applied),
    // fail loudly rather than silently showing slots that can never
    // actually be booked.
    throw error;
  }

  const bookedTimes = new Set((booked ?? []).map((row: { slot_start: string }) => new Date(row.slot_start).getTime()));

  return candidates.filter((slot) => slot.start.getTime() >= earliestAllowed && !bookedTimes.has(slot.start.getTime()));
}

/**
 * Books a slot. Relies on the `slot_start UNIQUE` constraint on
 * `demo_bookings` for the actual double-booking guarantee (a race between
 * two visitors picking the same slot resolves via that DB constraint, not
 * a client-side check, which could never be race-safe on its own).
 */
export async function bookEnterpriseDemoSlot(
  params: BookEnterpriseDemoSlotParams,
): Promise<BookEnterpriseDemoSlotResult> {
  if (!EMAIL_RE.test(params.workEmail.trim())) {
    return { ok: false, reason: 'INVALID_EMAIL' };
  }

  const slotEnd = new Date(params.slotStart.getTime() + SLOT_MINUTES * 60_000);

  const { error } = await supabase.from('demo_bookings').insert({
    full_name: params.fullName.trim(),
    work_email: params.workEmail.trim(),
    company_name: params.companyName.trim(),
    phone: params.phone?.trim() || null,
    team_size: params.teamSize || null,
    message: params.message?.trim() || null,
    slot_start: params.slotStart.toISOString(),
    slot_end: slotEnd.toISOString(),
  });

  if (!error) return { ok: true };

  // Postgres unique_violation on slot_start — someone else booked this
  // exact time between page load and submit.
  if (error.code === '23505') {
    return { ok: false, reason: 'SLOT_NOT_AVAILABLE' };
  }

  console.error('bookEnterpriseDemoSlot failed:', error);
  return { ok: false, reason: 'UNKNOWN' };
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * Builds a real, RFC-5545-valid .ics file as a Blob (single VEVENT) —
 * openable by Google Calendar, Apple Calendar, Outlook, etc.
 */
export function buildDemoBookingIcs(params: { start: Date; end: Date; title: string; description: string }): Blob {
  const uid = `${crypto.randomUUID()}@vireek.com`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vireek//Enterprise Demo Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(params.start)}`,
    `DTEND:${icsDate(params.end)}`,
    `SUMMARY:${escapeIcsText(params.title)}`,
    `DESCRIPTION:${escapeIcsText(params.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
}
