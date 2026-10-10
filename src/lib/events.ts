/**
 * Public events & webinars calendar — /events
 *
 * Client side of the calendar: read published sessions, format them for the
 * visitor's timezone, build calendar links/files, and register through the
 * event-register edge function. Pure helpers are exported so they can be
 * unit-tested without a browser.
 *
 * Server counterparts:
 *  - supabase/migrations/20270412000000_public_events.sql
 *  - supabase/functions/event-register
 */

import { supabase } from './supabase';

export const SITE_URL = 'https://vireek.com';

// ============================================================
// TYPES
// ============================================================

export type EventKind = 'webinar' | 'demo' | 'workshop' | 'office_hours' | 'conference';
export type EventFormat = 'online' | 'in_person' | 'hybrid';
export type RegistrationStatus = 'open' | 'full' | 'closed' | 'ended';

export interface PublicEvent {
  slug: string;
  title: string;
  description: string;
  kind: EventKind;
  starts_at: string;
  ends_at: string;
  timezone: string;
  format: EventFormat;
  location_label: string | null;
  host_name: string | null;
  recording_url: string | null;
  registration_status: RegistrationStatus;
  spots_left: number | null;
}

export type EventsResult = { state: 'ok'; events: PublicEvent[] } | { state: 'error' };

export interface RegistrationValues {
  name: string;
  email: string;
  marketingOptIn: boolean;
}

export type RegistrationErrors = Partial<Record<'name' | 'email', string>>;

export type RegisterFailureReason = 'invalid' | 'not_found' | 'closed' | 'full' | 'rate_limited' | 'error';

export type RegisterResult =
  | { ok: true; alreadyRegistered: boolean; joinUrl: string | null; emailSent: boolean }
  | { ok: false; reason: RegisterFailureReason };

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  webinar: 'Webinar',
  demo: 'Live demo',
  workshop: 'Workshop',
  office_hours: 'Office hours',
  conference: 'Conference',
};

export const REGISTER_FAILURE_MESSAGES: Record<RegisterFailureReason, string> = {
  invalid: 'Please check your details and try again.',
  not_found: "This event isn't available anymore.",
  closed: 'Registration for this event is closed.',
  full: 'This event is full.',
  rate_limited: 'Too many attempts right now. Please try again in a little while.',
  error: "We couldn't complete your registration. Please try again in a moment.",
};

// ============================================================
// PURE HELPERS
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const KNOWN_REASONS: RegisterFailureReason[] = ['invalid', 'not_found', 'closed', 'full', 'rate_limited'];

export function isSafeHttpsUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function time(iso: string): number {
  return new Date(iso).getTime();
}

function dateParts(iso: string, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(new Date(iso));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function validateRegistration(values: RegistrationValues): RegistrationErrors {
  const errors: RegistrationErrors = {};
  const name = values.name.trim();
  if (name.length < 2) errors.name = 'Please enter your full name.';
  else if (name.length > 100) errors.name = 'That name is too long.';
  const email = values.email.trim();
  if (!email) errors.email = 'Please enter your email.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  return errors;
}

export function splitEvents(events: PublicEvent[]): { upcoming: PublicEvent[]; past: PublicEvent[] } {
  // The server decides what has ended, so a visitor's wrong clock can't move events around.
  const upcoming = events.filter((e) => e.registration_status !== 'ended').sort((a, b) => time(a.starts_at) - time(b.starts_at));
  const past = events.filter((e) => e.registration_status === 'ended').sort((a, b) => time(b.starts_at) - time(a.starts_at));
  return { upcoming, past };
}

export function filterByKind(events: PublicEvent[], kind: EventKind | 'all'): PublicEvent[] {
  return kind === 'all' ? events : events.filter((e) => e.kind === kind);
}

export interface EventMonthGroup {
  key: string;
  label: string;
  events: PublicEvent[];
}

/** Groups already-sorted events by calendar month, in the given timezone (default: the visitor's). */
export function groupEventsByMonth(events: PublicEvent[], timeZone?: string): EventMonthGroup[] {
  const groups: EventMonthGroup[] = [];
  for (const event of events) {
    const parts = dateParts(event.starts_at, timeZone, { year: 'numeric', month: 'long' });
    const numeric = dateParts(event.starts_at, timeZone, { year: 'numeric', month: '2-digit' });
    const key = `${numeric.year}-${numeric.month}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, label: `${parts.month} ${parts.year}`, events: [event] });
  }
  return groups;
}

export function getEventDayBadge(iso: string, timeZone?: string): { month: string; day: string } {
  const parts = dateParts(iso, timeZone, { month: 'short', day: 'numeric' });
  return { month: parts.month.toUpperCase(), day: parts.day };
}

function clock(iso: string, timeZone: string | undefined): string {
  const p = dateParts(iso, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** "Wed, Oct 14 · 1:00 PM – 1:45 PM EDT" in the given timezone (default: the visitor's). */
export function formatEventWhen(startsAt: string, endsAt: string, timeZone?: string): string {
  const day = (iso: string) => {
    const p = dateParts(iso, timeZone, { weekday: 'short', month: 'short', day: 'numeric' });
    return `${p.weekday}, ${p.month} ${p.day}`;
  };
  const dayKey = (iso: string) => {
    const p = dateParts(iso, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${p.year}-${p.month}-${p.day}`;
  };
  const zone = dateParts(startsAt, timeZone, { timeZoneName: 'short' }).timeZoneName;
  const startDay = day(startsAt);
  const end = dayKey(startsAt) === dayKey(endsAt) ? clock(endsAt, timeZone) : `${day(endsAt)}, ${clock(endsAt, timeZone)}`;
  return `${startDay} · ${clock(startsAt, timeZone)} – ${end} ${zone}`;
}

export function eventLocationLabel(event: Pick<PublicEvent, 'format' | 'location_label'>): string {
  if (event.format === 'online') return 'Online';
  if (event.format === 'in_person') return event.location_label || 'In person';
  return `${event.location_label || 'In person'} + online`;
}

/** Short status chip text, or null when there is nothing worth saying. */
export function spotsLabel(status: RegistrationStatus, spotsLeft: number | null): string | null {
  if (status === 'full') return 'Full';
  if (status === 'closed') return 'Registration closed';
  if (status === 'ended') return 'Ended';
  if (spotsLeft !== null && spotsLeft > 0 && spotsLeft <= 10) return spotsLeft === 1 ? '1 spot left' : `${spotsLeft} spots left`;
  return null;
}

export function getEventPageUrl(slug: string): string {
  return `${SITE_URL}/events?event=${encodeURIComponent(slug)}`;
}

// ---------- calendar links / files ----------

function calendarStamp(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildGoogleCalendarUrl(event: PublicEvent, pageUrl: string, joinUrl: string | null = null): string {
  const details = joinUrl ? `Join: ${joinUrl}\n\nEvent page: ${pageUrl}` : `Event page: ${pageUrl}`;
  return (
    'https://calendar.google.com/calendar/render?' +
    new URLSearchParams({
      action: 'TEMPLATE',
      text: event.title,
      dates: `${calendarStamp(event.starts_at)}/${calendarStamp(event.ends_at)}`,
      details,
      location: eventLocationLabel(event),
    }).toString()
  );
}

export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

function utf8Length(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** RFC 5545 line folding: lines may not exceed 75 octets; continuations start with one space. */
export function foldIcsLine(line: string): string {
  let total = 0;
  for (const ch of line) total += utf8Length(ch);
  if (total <= 75) return line;

  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = utf8Length(ch);
    if (bytes + size > limit) {
      chunks.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += size;
  }
  chunks.push(current);
  return chunks.join('\r\n ');
}

export function buildEventIcs(event: PublicEvent, pageUrl: string, now: Date = new Date(), joinUrl: string | null = null): string {
  const description = [event.description, joinUrl ? `Join: ${joinUrl}` : '', `Event page: ${pageUrl}`].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vireek//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.slug}@vireek.com`,
    `DTSTAMP:${calendarStamp(now)}`,
    `DTSTART:${calendarStamp(event.starts_at)}`,
    `DTEND:${calendarStamp(event.ends_at)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(eventLocationLabel(event))}`,
    `URL:${pageUrl}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ---------- structured data ----------

/** schema.org Event objects for sessions that haven't ended. Only real, published sessions ever reach this. */
export function buildEventsJsonLd(events: PublicEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.registration_status !== 'ended')
    .map((e) => {
      const pageUrl = getEventPageUrl(e.slug);
      const virtual = { '@type': 'VirtualLocation', url: pageUrl };
      const place = { '@type': 'Place', name: e.location_label || 'In person', address: e.location_label || 'In person' };
      const attendanceMode =
        e.format === 'online'
          ? 'https://schema.org/OnlineEventAttendanceMode'
          : e.format === 'in_person'
            ? 'https://schema.org/OfflineEventAttendanceMode'
            : 'https://schema.org/MixedEventAttendanceMode';
      const location = e.format === 'online' ? virtual : e.format === 'in_person' ? place : [virtual, place];

      const schema: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: e.title,
        description: e.description || e.title,
        startDate: new Date(e.starts_at).toISOString(),
        endDate: new Date(e.ends_at).toISOString(),
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: attendanceMode,
        location,
        url: pageUrl,
        organizer: { '@type': 'Organization', name: 'Vireek', url: SITE_URL },
      };
      if (e.host_name) schema.performer = { '@type': 'Person', name: e.host_name };
      if (e.registration_status === 'open' || e.registration_status === 'full') {
        schema.offers = {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          url: pageUrl,
          availability: e.registration_status === 'full' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
        };
      }
      return schema;
    });
}

// ============================================================
// DATA LAYER
// ============================================================

export async function fetchPublicEvents(): Promise<EventsResult> {
  const { data, error } = await supabase.rpc('list_public_events');
  if (error) return { state: 'error' };
  const rows = Array.isArray(data) ? (data as PublicEvent[]) : [];
  const events = rows
    .filter((e) => e && typeof e.slug === 'string' && typeof e.title === 'string' && e.kind in EVENT_KIND_LABELS && isValidDate(e.starts_at) && isValidDate(e.ends_at))
    .map((e) => ({
      ...e,
      description: typeof e.description === 'string' ? e.description : '',
      location_label: e.location_label ?? null,
      host_name: e.host_name ?? null,
      recording_url: isSafeHttpsUrl(e.recording_url) ? e.recording_url : null,
      spots_left: typeof e.spots_left === 'number' ? e.spots_left : null,
    }));
  return { state: 'ok', events };
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function reasonFromError(error: unknown): Promise<RegisterFailureReason> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { reason?: string } | null;
      const reason = body?.reason as RegisterFailureReason | undefined;
      if (reason && KNOWN_REASONS.includes(reason)) return reason;
    } catch {
      // fall through to the generic error
    }
  }
  return 'error';
}

export async function registerForEvent(slug: string, values: RegistrationValues, honeypot = ''): Promise<RegisterResult> {
  if (Object.keys(validateRegistration(values)).length > 0) return { ok: false, reason: 'invalid' };

  const { data, error } = await supabase.functions.invoke('event-register', {
    body: {
      event_slug: slug,
      name: values.name.trim(),
      email: values.email.trim(),
      marketing_opt_in: values.marketingOptIn,
      website: honeypot,
    },
  });
  if (error) return { ok: false, reason: await reasonFromError(error) };

  const res = data as { status?: string; join_url?: string | null; email_sent?: boolean } | null;
  if (res?.status !== 'registered' && res?.status !== 'already_registered') return { ok: false, reason: 'error' };
  return {
    ok: true,
    alreadyRegistered: res.status === 'already_registered',
    joinUrl: isSafeHttpsUrl(res.join_url) ? res.join_url : null,
    emailSent: res.email_sent === true,
  };
}

/** "Notify me" list for when nothing is scheduled — same table as the footer signup, source 'events'. */
export async function subscribeToEventUpdates(email: string): Promise<'ok' | 'invalid' | 'error'> {
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !EMAIL_RE.test(value)) return 'invalid';
  const { error } = await supabase.from('newsletter_subscribers').insert({ email: value, source: 'events' });
  // 23505 = already subscribed, which is the outcome the visitor wanted.
  if (error && error.code !== '23505') return 'error';
  return 'ok';
}
