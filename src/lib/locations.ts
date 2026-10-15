import { INDUSTRIES, type Industry } from '@/lib/industries';
import { CLIMATE_LABELS, TRADE_SIGNALS, type ClimateTag } from '@/lib/locationSignals';

/**
 * Locations — pure domain logic, two parts:
 *
 * 1. Locations & Brands for /dashboard/settings/locations.
 *    No React, no Supabase: everything here is deterministic and unit-tested (locations.test.ts).
 *    Hard rules (one primary location, no archiving the primary, account scoping, who may edit) are
 *    enforced in SQL by supabase/migrations/20270501000000_business_locations.sql — this file only
 *    validates early for fast feedback and normalises every server payload so a missing field can
 *    never crash the UI.
 *
 * 2. Programmatic SEO pages for /locations (city x trade), further below.
 */

export type LocationStatus = 'active' | 'paused' | 'archived';
export type AfterHoursMode = 'ai_answer' | 'voicemail' | 'forward';
export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type LocationFilter = 'all' | LocationStatus;

export const WEEKDAYS: { key: WeekdayKey; label: string; short: string }[] = [
  { key: 'mon', label: 'Monday', short: 'Mon' },
  { key: 'tue', label: 'Tuesday', short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday', short: 'Thu' },
  { key: 'fri', label: 'Friday', short: 'Fri' },
  { key: 'sat', label: 'Saturday', short: 'Sat' },
  { key: 'sun', label: 'Sunday', short: 'Sun' },
];

export const STATUS_LABELS: Record<LocationStatus, string> = { active: 'Active', paused: 'Paused', archived: 'Archived' };
export const FILTER_LABELS: Record<LocationFilter, string> = { all: 'All', active: 'Active', paused: 'Paused', archived: 'Archived' };
export const AFTER_HOURS_LABELS: Record<AfterHoursMode, string> = {
  ai_answer: 'AI assistant answers',
  voicemail: 'Send to voicemail',
  forward: 'Forward to a number',
};

export interface DayHours {
  closed: boolean;
  open: string;
  close: string;
}
export type BusinessHours = Record<WeekdayKey, DayHours>;

export interface Brand {
  id: string;
  name: string;
  website_url: string | null;
  primary_color: string | null;
  location_count: number;
}

export interface BusinessLocation {
  id: string;
  brand_id: string | null;
  brand_name: string | null;
  name: string;
  code: string | null;
  status: LocationStatus;
  is_primary: boolean;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  timezone: string;
  currency: string;
  tax_rate_percent: number;
  service_radius_miles: number | null;
  business_hours: BusinessHours;
  booking_enabled: boolean;
  after_hours_mode: AfterHoursMode;
  forwarding_number: string | null;
  notes: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

/** Everything the form edits, as strings/booleans (what inputs actually hold). */
export interface LocationDraft {
  name: string;
  code: string;
  brand_id: string;
  status: Exclude<LocationStatus, 'archived'>;
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  timezone: string;
  currency: string;
  tax_rate_percent: string;
  service_radius_miles: string;
  business_hours: BusinessHours;
  booking_enabled: boolean;
  after_hours_mode: AfterHoursMode;
  forwarding_number: string;
  notes: string;
}

/** Column-shaped payload sent to Supabase (user_id is filled by the column default). */
export interface LocationPayload {
  name: string;
  code: string | null;
  brand_id: string | null;
  status: Exclude<LocationStatus, 'archived'>;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  timezone: string;
  currency: string;
  tax_rate_percent: number;
  service_radius_miles: number | null;
  business_hours: BusinessHours;
  booking_enabled: boolean;
  after_hours_mode: AfterHoursMode;
  forwarding_number: string | null;
  notes: string | null;
}

export type LocationErrors = Partial<Record<keyof LocationDraft, string>>;

export interface TeamMemberLite {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface LocationSummary {
  total: number;
  active: number;
  paused: number;
  archived: number;
  brands: number;
}

// ------------------------------------------------------------------ constants & helpers

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{7,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const URL_RE = /^https?:\/\/\S+$/i;

export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'MXN'] as const;

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Australia/Sydney',
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};
const emptyToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

export function timezoneOptions(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return Array.from(new Set(['UTC', ...list]));
  } catch {
    /* fall through to the static list */
  }
  return FALLBACK_TIMEZONES;
}

// ------------------------------------------------------------------ business hours

export function defaultHours(): BusinessHours {
  const day = (closed: boolean): DayHours => ({ closed, open: '08:00', close: '17:00' });
  return { mon: day(false), tue: day(false), wed: day(false), thu: day(false), fri: day(false), sat: day(true), sun: day(true) };
}

export function normalizeHours(raw: unknown): BusinessHours {
  const base = defaultHours();
  if (!isRecord(raw)) return base;
  for (const { key } of WEEKDAYS) {
    const d = raw[key];
    if (!isRecord(d)) continue;
    base[key] = {
      closed: typeof d.closed === 'boolean' ? d.closed : base[key].closed,
      open: typeof d.open === 'string' && TIME_RE.test(d.open) ? d.open : base[key].open,
      close: typeof d.close === 'string' && TIME_RE.test(d.close) ? d.close : base[key].close,
    };
  }
  return base;
}

/** First weekday whose open time is not before its close time, or null when every day is valid. */
export function findInvalidHoursDay(hours: BusinessHours): WeekdayKey | null {
  for (const { key } of WEEKDAYS) {
    const d = hours[key];
    if (!d.closed && (!TIME_RE.test(d.open) || !TIME_RE.test(d.close) || d.open >= d.close)) return key;
  }
  return null;
}

/** "Mon–Fri 08:00–17:00 · Sat–Sun closed" — consecutive days with the same schedule are merged. */
export function formatHoursSummary(hours: BusinessHours): string {
  const label = (d: DayHours) => (d.closed ? 'closed' : `${d.open}–${d.close}`);
  const groups: { from: string; to: string; text: string }[] = [];
  for (const { key, short } of WEEKDAYS) {
    const text = label(hours[key]);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = short;
    else groups.push({ from: short, to: short, text });
  }
  if (groups.length === 1) return groups[0].text === 'closed' ? 'Closed all week' : `Every day ${groups[0].text}`;
  return groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.text}`).join(' · ');
}

/** Is the location open at `now` in its own timezone? null when the timezone is invalid. Same-day hours only. */
export function isOpenNow(hours: BusinessHours, timezone: string, now: Date): boolean | null {
  if (!isValidTimezone(timezone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  const day = WEEKDAYS.find((d) => d.short === weekday);
  if (!day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const h = hours[day.key];
  if (h.closed) return false;
  const minutes = (hour % 24) * 60 + minute;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return minutes >= toMin(h.open) && minutes < toMin(h.close);
}

// ------------------------------------------------------------------ normalisation (server → UI)

function normalizeStatus(v: unknown): LocationStatus {
  return v === 'paused' || v === 'archived' ? v : 'active';
}
function normalizeAfterHours(v: unknown): AfterHoursMode {
  return v === 'voicemail' || v === 'forward' ? v : 'ai_answer';
}

export function normalizeLocation(raw: unknown): BusinessLocation | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const brand = isRecord(raw.brand) ? raw.brand : null;
  const members = Array.isArray(raw.members) && isRecord(raw.members[0]) ? raw.members[0] : null;
  return {
    id: raw.id,
    brand_id: str(raw.brand_id),
    brand_name: brand ? str(brand.name) : null,
    name: raw.name,
    code: str(raw.code),
    status: normalizeStatus(raw.status),
    is_primary: raw.is_primary === true,
    phone: str(raw.phone),
    email: str(raw.email),
    address_line1: str(raw.address_line1),
    address_line2: str(raw.address_line2),
    city: str(raw.city),
    state: str(raw.state),
    postal_code: str(raw.postal_code),
    country: str(raw.country) ?? 'US',
    timezone: str(raw.timezone) ?? 'America/New_York',
    currency: str(raw.currency) ?? 'USD',
    tax_rate_percent: num(raw.tax_rate_percent, 0),
    service_radius_miles: raw.service_radius_miles == null ? null : num(raw.service_radius_miles, 0),
    business_hours: normalizeHours(raw.business_hours),
    booking_enabled: raw.booking_enabled !== false,
    after_hours_mode: normalizeAfterHours(raw.after_hours_mode),
    forwarding_number: str(raw.forwarding_number),
    notes: str(raw.notes),
    member_count: members ? num(members.count, 0) : 0,
    created_at: str(raw.created_at) ?? '',
    updated_at: str(raw.updated_at) ?? '',
  };
}

export function normalizeLocations(raw: unknown): BusinessLocation[] {
  return Array.isArray(raw) ? raw.map(normalizeLocation).filter((l): l is BusinessLocation => l !== null) : [];
}

export function normalizeBrands(raw: unknown, locations: BusinessLocation[] = []): Brand[] {
  if (!Array.isArray(raw)) return [];
  const out: Brand[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    out.push({
      id: r.id,
      name: r.name,
      website_url: str(r.website_url),
      primary_color: typeof r.primary_color === 'string' && COLOR_RE.test(r.primary_color) ? r.primary_color : null,
      location_count: locations.filter((l) => l.brand_id === r.id && l.status !== 'archived').length,
    });
  }
  return out;
}

export function normalizeTeamMembers(raw: unknown): TeamMemberLite[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamMemberLite[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.id !== 'string') continue;
    const email = str(r.member_email) ?? '';
    out.push({ id: r.id, name: str(r.member_name) ?? (email || 'Team member'), email, role: str(r.role) ?? 'member' });
  }
  return out;
}

// ------------------------------------------------------------------ form: draft ⇄ payload

export function emptyDraft(defaults: Partial<LocationDraft> = {}): LocationDraft {
  return {
    name: '',
    code: '',
    brand_id: '',
    status: 'active',
    phone: '',
    email: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    country: 'US',
    timezone: browserTimezone(),
    currency: 'USD',
    tax_rate_percent: '0',
    service_radius_miles: '',
    business_hours: defaultHours(),
    booking_enabled: true,
    after_hours_mode: 'ai_answer',
    forwarding_number: '',
    notes: '',
    ...defaults,
  };
}

export function draftFromLocation(l: BusinessLocation): LocationDraft {
  return {
    name: l.name,
    code: l.code ?? '',
    brand_id: l.brand_id ?? '',
    status: l.status === 'paused' ? 'paused' : 'active',
    phone: l.phone ?? '',
    email: l.email ?? '',
    address_line1: l.address_line1 ?? '',
    address_line2: l.address_line2 ?? '',
    city: l.city ?? '',
    state: l.state ?? '',
    postal_code: l.postal_code ?? '',
    country: l.country,
    timezone: l.timezone,
    currency: l.currency,
    tax_rate_percent: String(l.tax_rate_percent),
    service_radius_miles: l.service_radius_miles == null ? '' : String(l.service_radius_miles),
    business_hours: normalizeHours(l.business_hours),
    booking_enabled: l.booking_enabled,
    after_hours_mode: l.after_hours_mode,
    forwarding_number: l.forwarding_number ?? '',
    notes: l.notes ?? '',
  };
}

export function validateDraft(
  d: LocationDraft,
  others: { id: string; code: string | null }[] = [],
  editingId: string | null = null,
): LocationErrors {
  const e: LocationErrors = {};
  const name = d.name.trim();
  if (!name) e.name = 'Give this location a name.';
  else if (name.length > 80) e.name = 'Keep the name under 80 characters.';

  const code = d.code.trim();
  if (code) {
    if (!CODE_RE.test(code)) e.code = 'Use letters, numbers, dashes or underscores (max 20).';
    else if (others.some((o) => o.id !== editingId && o.code && o.code.toLowerCase() === code.toLowerCase()))
      e.code = 'Another location already uses this code.';
  }

  if (d.phone.trim() && !PHONE_RE.test(d.phone.trim())) e.phone = 'Enter a valid phone number.';
  if (d.email.trim() && !EMAIL_RE.test(d.email.trim())) e.email = 'Enter a valid email address.';
  if (!/^[A-Za-z]{2}$/.test(d.country.trim())) e.country = 'Use a 2-letter country code (e.g. US).';
  if (!/^[A-Za-z]{3}$/.test(d.currency.trim())) e.currency = 'Use a 3-letter currency code (e.g. USD).';
  if (!isValidTimezone(d.timezone.trim())) e.timezone = 'Pick a valid timezone.';

  const tax = d.tax_rate_percent.trim() === '' ? 0 : Number(d.tax_rate_percent);
  if (!Number.isFinite(tax) || tax < 0 || tax > 30) e.tax_rate_percent = 'Tax rate must be between 0 and 30%.';

  if (d.service_radius_miles.trim() !== '') {
    const r = Number(d.service_radius_miles);
    if (!Number.isInteger(r) || r < 0 || r > 500) e.service_radius_miles = 'Use a whole number of miles (0–500).';
  }

  const badDay = findInvalidHoursDay(d.business_hours);
  if (badDay) {
    const label = WEEKDAYS.find((w) => w.key === badDay)?.label ?? badDay;
    e.business_hours = `${label}: closing time must be after opening time.`;
  }

  if (d.after_hours_mode === 'forward') {
    if (!d.forwarding_number.trim()) e.forwarding_number = 'Add the number after-hours calls should forward to.';
    else if (!PHONE_RE.test(d.forwarding_number.trim())) e.forwarding_number = 'Enter a valid phone number.';
  } else if (d.forwarding_number.trim() && !PHONE_RE.test(d.forwarding_number.trim())) {
    e.forwarding_number = 'Enter a valid phone number.';
  }
  return e;
}

export function draftToPayload(d: LocationDraft): LocationPayload {
  const tax = d.tax_rate_percent.trim() === '' ? 0 : Number(d.tax_rate_percent);
  return {
    name: d.name.trim(),
    code: emptyToNull(d.code),
    brand_id: d.brand_id || null,
    status: d.status,
    phone: emptyToNull(d.phone),
    email: emptyToNull(d.email),
    address_line1: emptyToNull(d.address_line1),
    address_line2: emptyToNull(d.address_line2),
    city: emptyToNull(d.city),
    state: emptyToNull(d.state),
    postal_code: emptyToNull(d.postal_code),
    country: d.country.trim().toUpperCase(),
    timezone: d.timezone.trim(),
    currency: d.currency.trim().toUpperCase(),
    tax_rate_percent: Math.round(tax * 1000) / 1000,
    service_radius_miles: d.service_radius_miles.trim() === '' ? null : Number(d.service_radius_miles),
    business_hours: d.business_hours,
    booking_enabled: d.booking_enabled,
    after_hours_mode: d.after_hours_mode,
    forwarding_number: emptyToNull(d.forwarding_number),
    notes: emptyToNull(d.notes),
  };
}

export function validateBrand(name: string, website: string, color: string, existing: { id: string; name: string }[], editingId: string | null = null): string | null {
  const n = name.trim();
  if (!n) return 'Give the brand a name.';
  if (n.length > 80) return 'Keep the brand name under 80 characters.';
  if (existing.some((b) => b.id !== editingId && b.name.trim().toLowerCase() === n.toLowerCase())) return 'A brand with this name already exists.';
  if (website.trim() && !URL_RE.test(website.trim())) return 'Website must start with http:// or https://';
  if (color.trim() && !COLOR_RE.test(color.trim())) return 'Color must look like #1A2B3C.';
  return null;
}

// ------------------------------------------------------------------ list helpers

export function sortLocations(list: BusinessLocation[]): BusinessLocation[] {
  const rank = (l: BusinessLocation) => (l.status === 'archived' ? 2 : l.is_primary ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** `all` = every location except archived ones (those live under their own filter). */
export function filterLocations(list: BusinessLocation[], filter: LocationFilter, query: string): BusinessLocation[] {
  const q = query.trim().toLowerCase();
  return list.filter((l) => {
    if (filter === 'all' ? l.status === 'archived' : l.status !== filter) return false;
    if (!q) return true;
    return [l.name, l.code, l.brand_name, l.city, l.state, l.postal_code, l.phone]
      .filter((v): v is string => Boolean(v))
      .some((v) => v.toLowerCase().includes(q));
  });
}

export function summarizeLocations(list: BusinessLocation[], brands: Brand[] = []): LocationSummary {
  return {
    total: list.filter((l) => l.status !== 'archived').length,
    active: list.filter((l) => l.status === 'active').length,
    paused: list.filter((l) => l.status === 'paused').length,
    archived: list.filter((l) => l.status === 'archived').length,
    brands: brands.length,
  };
}

export function formatAddress(l: Pick<BusinessLocation, 'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code'>): string {
  const cityLine = [l.city, [l.state, l.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [l.address_line1, l.address_line2, cityLine].filter(Boolean).join(' · ');
}

/** Which location should be active: the saved one if still usable, else the primary, else the first non-archived. */
export function resolveActiveLocationId(list: BusinessLocation[], preferredId: string | null): string | null {
  const usable = list.filter((l) => l.status !== 'archived');
  if (preferredId && usable.some((l) => l.id === preferredId)) return preferredId;
  return (usable.find((l) => l.is_primary) ?? usable[0])?.id ?? null;
}

/** Map any thrown value to a short, user-safe message (never leaks SQL/RLS internals). */
export function friendlyLocationError(err: unknown, fallback: string): string {
  const e = err as { message?: string; code?: string } | null;
  const m = e?.message ?? '';
  if (e?.code === '23505' || /duplicate key/i.test(m)) {
    if (/code/i.test(m)) return 'Another location already uses this code.';
    if (/brand/i.test(m)) return 'A brand with this name already exists.';
    return 'That already exists.';
  }
  if (e?.code === '42501' || /row-level security|permission denied/i.test(m)) return 'You do not have permission to change locations.';
  return m && m.length < 160 && !/relation|column|function|syntax|violates|constraint/i.test(m) ? m : fallback;
}

// ------------------------------------------------------------------ programmatic SEO pages (city x trade)

export const SITE_URL = 'https://vireek.com';

export interface City {
  slug: string;
  name: string;
  state: string;
  stateCode: string;
  /** Climate patterns that shape call demand here (>= 1). */
  tags: ClimateTag[];
  /** Human-readable peak window, e.g. "May through September". */
  peakSeason: string;
  seasonNote: string;
  housingNote: string;
  /** Real nearby cities/suburbs (>= 5). */
  suburbs: string[];
}

export const CITIES: City[] = [
  {
    slug: 'phoenix', name: 'Phoenix', state: 'Arizona', stateCode: 'AZ',
    tags: ['extreme-heat', 'monsoon'], peakSeason: 'May through September',
    seasonNote: 'Summers here run long and hot, and monsoon storms add sudden spikes on top of the heat.',
    housingNote: 'The metro is mostly sprawling suburban stock with many single-story homes, backyard pools and total reliance on air conditioning.',
    suburbs: ['Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Glendale', 'Gilbert'],
  },
  {
    slug: 'las-vegas', name: 'Las Vegas', state: 'Nevada', stateCode: 'NV',
    tags: ['extreme-heat', 'monsoon'], peakSeason: 'May through September',
    seasonNote: 'Desert summers are punishing, and short monsoon storms can arrive with little warning.',
    housingNote: 'Rapid growth means a large share of homes are newer tract construction, alongside a big base of condos and short-term rentals.',
    suburbs: ['Henderson', 'North Las Vegas', 'Summerlin', 'Spring Valley', 'Paradise', 'Enterprise'],
  },
  {
    slug: 'houston', name: 'Houston', state: 'Texas', stateCode: 'TX',
    tags: ['humid-heat', 'hurricane'], peakSeason: 'June through November',
    seasonNote: 'Heat and humidity dominate the summer, and hurricane season overlaps the busiest months.',
    housingNote: 'Flat, flood-prone terrain, enormous suburban footprints and many slab-on-grade homes shape what breaks and how fast people call.',
    suburbs: ['Sugar Land', 'Katy', 'The Woodlands', 'Pearland', 'Cypress', 'Pasadena'],
  },
  {
    slug: 'dallas', name: 'Dallas', state: 'Texas', stateCode: 'TX',
    tags: ['humid-heat', 'severe-storm', 'hard-freeze'], peakSeason: 'June through September',
    seasonNote: 'Long hot summers, spring hail and the occasional deep winter freeze each create their own surge.',
    housingNote: 'Fast-growing newer suburbs ring older inner neighborhoods, so equipment age varies enormously from one call to the next.',
    suburbs: ['Plano', 'Irving', 'Frisco', 'Garland', 'Arlington', 'McKinney'],
  },
  {
    slug: 'atlanta', name: 'Atlanta', state: 'Georgia', stateCode: 'GA',
    tags: ['humid-heat', 'severe-storm'], peakSeason: 'May through September',
    seasonNote: 'Humid summers and fast-moving thunderstorms keep the phones busy from late spring onward.',
    housingNote: 'A heavily tree-canopied metro mixes older in-town bungalows with newer suburban builds, so storm damage and aging systems both matter.',
    suburbs: ['Marietta', 'Decatur', 'Roswell', 'Alpharetta', 'Sandy Springs', 'Smyrna'],
  },
  {
    slug: 'miami', name: 'Miami', state: 'Florida', stateCode: 'FL',
    tags: ['humid-heat', 'hurricane'], peakSeason: 'June through November',
    seasonNote: 'Heat and humidity never really leave, and hurricane season drives sharp, short bursts of demand.',
    housingNote: 'Concrete-block homes, many condos and low-lying coastal neighborhoods mean salt air, flooding and building rules shape the work.',
    suburbs: ['Hialeah', 'Coral Gables', 'Miami Beach', 'Doral', 'Homestead', 'Kendall'],
  },
  {
    slug: 'tampa', name: 'Tampa', state: 'Florida', stateCode: 'FL',
    tags: ['humid-heat', 'hurricane', 'severe-storm'], peakSeason: 'June through November',
    seasonNote: 'Daily summer thunderstorms and hurricane season make demand spiky and weather-driven.',
    housingNote: 'The Tampa Bay area spans waterfront neighborhoods, older bungalows and fast-growing suburbs, each with different exposure to storms and flooding.',
    suburbs: ['St. Petersburg', 'Clearwater', 'Brandon', 'Riverview', 'Wesley Chapel', 'Largo'],
  },
  {
    slug: 'charlotte', name: 'Charlotte', state: 'North Carolina', stateCode: 'NC',
    tags: ['humid-heat', 'severe-storm'], peakSeason: 'May through September',
    seasonNote: 'Humid summers and strong spring and summer storms create steady, weather-linked surges.',
    housingNote: 'A booming metro with many newer subdivisions around older close-in neighborhoods keeps both new-install and repair demand high.',
    suburbs: ['Concord', 'Matthews', 'Huntersville', 'Gastonia', 'Mint Hill', 'Cornelius'],
  },
  {
    slug: 'denver', name: 'Denver', state: 'Colorado', stateCode: 'CO',
    tags: ['severe-storm', 'hard-freeze'], peakSeason: 'April through September',
    seasonNote: 'Hail season and sudden cold snaps make demand arrive in sharp, unpredictable waves.',
    housingNote: 'Older brick bungalows in the core and newer foothill and suburban builds mean wide variation in roofs, heating systems and wiring.',
    suburbs: ['Aurora', 'Lakewood', 'Arvada', 'Centennial', 'Littleton', 'Westminster'],
  },
  {
    slug: 'chicago', name: 'Chicago', state: 'Illinois', stateCode: 'IL',
    tags: ['hard-freeze', 'severe-storm', 'humid-heat'], peakSeason: 'November through March',
    seasonNote: 'Brutal winter cold, summer thunderstorms and humid heat waves each bring a distinct rush of calls.',
    housingNote: 'Dense two-flats, greystones, older bungalows and high-rises mean aging plumbing, boilers and wiring are an everyday reality.',
    suburbs: ['Evanston', 'Naperville', 'Oak Park', 'Schaumburg', 'Cicero', 'Skokie'],
  },
  {
    slug: 'minneapolis', name: 'Minneapolis', state: 'Minnesota', stateCode: 'MN',
    tags: ['hard-freeze', 'severe-storm'], peakSeason: 'November through March',
    seasonNote: 'Long, cold winters and violent summer storms create two distinct seasons of urgent calls.',
    housingNote: 'Older housing across the Twin Cities, built for cold, puts heavy demands on heating, insulation, roofing and plumbing.',
    suburbs: ['St. Paul', 'Bloomington', 'Plymouth', 'Edina', 'Maple Grove', 'Brooklyn Park'],
  },
  {
    slug: 'seattle', name: 'Seattle', state: 'Washington', stateCode: 'WA',
    tags: ['wet-mild'], peakSeason: 'October through April',
    seasonNote: 'The rainy season runs for months, so moisture-related calls build steadily instead of arriving in one rush.',
    housingNote: 'Older craftsman homes, hillside lots and dense neighborhoods mean aging lines, crawlspaces and roofs see constant moisture.',
    suburbs: ['Bellevue', 'Tacoma', 'Kirkland', 'Redmond', 'Renton', 'Everett'],
  },
];

export function getCityBySlug(slug: string | undefined): City | undefined {
  return CITIES.find((c) => c.slug === slug);
}

export const locationPath = (city?: City, industry?: Industry): string =>
  !city ? '/locations' : industry ? `/locations/${city.slug}/${industry.slug}` : `/locations/${city.slug}`;

/** Every indexable /locations URL path (hub + city hubs + city x trade pages). */
export function allLocationPaths(): string[] {
  return [
    '/locations',
    ...CITIES.flatMap((c) => [locationPath(c), ...INDUSTRIES.map((i) => locationPath(c, i))]),
  ];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const joinList = (items: string[]) =>
  items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

export interface LocalFaq { q: string; a: string }
export interface LocalDriver { tag: ClimateTag; label: string; text: string }

export interface LocalPage {
  path: string;
  canonical: string;
  title: string;
  description: string;
  h1: string;
  intro: string;
  drivers: LocalDriver[];
  coverage: string[];
  faq: LocalFaq[];
}

/** Deterministic, unique-per-pair content for one trade in one city. */
export function buildLocalPage(industry: Industry, city: City): LocalPage {
  const { name, audience, roi } = industry;
  const signals = TRADE_SIGNALS[industry.slug];
  const drivers: LocalDriver[] = city.tags.map((tag) => ({ tag, label: CLIMATE_LABELS[tag], text: signals[tag] }));
  const lead = drivers[0].text;
  const path = locationPath(city, industry);
  const place = `${city.name}, ${city.stateCode}`;

  return {
    path,
    canonical: `${SITE_URL}${path}`,
    title: `${name} AI Receptionist in ${place} | Vireek`,
    description: `Vireek's AI receptionist answers every call for ${name} companies in ${place}: ${roi.emergencyLabel} triaged, jobs booked 24/7. Start free.`,
    h1: `AI Receptionist for ${name} Companies in ${place}`,
    intro:
      `${name} calls in ${place} follow the weather: ${lowerFirst(lead)} ${city.seasonNote} ` +
      `Vireek's AI receptionist, Sarah, answers every call for ${audience} across ${city.name} and nearby ` +
      `${joinList(city.suburbs.slice(0, 3))}, so ${roi.emergencyLabel} are triaged and booked instead of left on voicemail.`,
    drivers,
    coverage: city.suburbs,
    faq: [
      {
        q: `Can Vireek answer ${roi.emergencyLabel} for ${audience} in ${city.name} after hours?`,
        a: `Yes. Vireek answers every call 24/7, asks trade-specific triage questions, and flags urgent ${roi.emergencyLabel} for immediate dispatch. That matters in ${city.name}, where ${lowerFirst(lead)}`,
      },
      {
        q: `Does Vireek work for ${name} companies serving ${city.suburbs[0]} and ${city.suburbs[1]}?`,
        a: `Yes. Vireek answers calls for your business wherever your customers are and collects each caller's location and job details, so your team can see which part of the ${city.name} area a job is in. Common areas include ${joinList(city.suburbs)}.`,
      },
      {
        q: `How does Vireek handle the ${city.peakSeason} rush in ${city.name}?`,
        a: `Vireek answers unlimited simultaneous calls, so there is no hold queue when volume spikes. ${city.seasonNote} ${city.housingNote}`,
      },
    ],
  };
}

/** schema.org markup for a city x trade page. */
export function buildLocalJsonLd(industry: Industry, city: City, page: LocalPage): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Locations', item: `${SITE_URL}/locations` },
        { '@type': 'ListItem', position: 3, name: city.name, item: `${SITE_URL}${locationPath(city)}` },
        { '@type': 'ListItem', position: 4, name: industry.name, item: page.canonical },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: page.h1,
      serviceType: 'AI receptionist and call answering',
      description: page.description,
      url: page.canonical,
      provider: { '@type': 'Organization', name: 'Vireek', url: SITE_URL },
      areaServed: {
        '@type': 'City',
        name: city.name,
        containedInPlace: { '@type': 'State', name: city.state },
      },
      audience: { '@type': 'BusinessAudience', audienceType: industry.audience },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];
}
