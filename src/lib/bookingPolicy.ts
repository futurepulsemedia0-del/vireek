import type { CSSProperties } from 'react';

// ============================================================
// Booking policy — everything about /dashboard/booking-settings that is
// pure logic: types, limits, validation, row <-> settings mapping, the
// slot engine (with buffers) and branding helpers. Deliberately has NO
// Supabase import so it can be unit-tested without a client/env.
// Data access lives in src/lib/bookingSettings.ts.
// ============================================================

export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_ORDER)[number];
export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
export type HoursMap = Partial<Record<DayKey, { open: string; close: string }>>;

export type IntakeQuestionType = 'text' | 'longtext' | 'select' | 'yesno';
export const INTAKE_TYPE_LABELS: Record<IntakeQuestionType, string> = {
  text: 'Short answer', longtext: 'Long answer', select: 'Pick one', yesno: 'Yes / No',
};

export interface IntakeQuestion {
  id: string;
  label: string;
  type: IntakeQuestionType;
  required: boolean;
  options: string[];
}

export interface BookingBranding {
  accent_color: string | null;
  logo_url: string | null;
  headline: string;
  intro: string;
  confirmation_message: string;
}

export const EMPTY_BRANDING: BookingBranding = {
  accent_color: null, logo_url: null, headline: '', intro: '', confirmation_message: '',
};

// Must stay in sync with the CHECK constraints in
// supabase/migrations/20270410000000_booking_settings.sql
export const BOOKING_LIMITS = {
  slugMin: 3, slugMax: 60,
  durationMin: 15, durationMax: 480,
  leadTimeMaxHours: 720,
  windowMinDays: 1, windowMaxDays: 365,
  bufferMax: 240,
  depositMaxCents: 1_000_000,
  intakeMax: 8, labelMax: 120, optionsMin: 2, optionsMax: 10, optionLenMax: 60,
  headlineMax: 80, introMax: 400, confirmationMax: 400, policyMax: 400, answerMax: 1000,
  minContrastWithWhite: 3,
} as const;

export interface BookingSettings {
  enabled: boolean;
  slug: string;
  durationMinutes: number;
  leadTimeHours: number;
  windowDays: number;
  bufferBefore: number;
  bufferAfter: number;
  useBusinessHours: boolean;
  hours: HoursMap;
  hiddenServices: string[];
  depositCents: number;
  depositPolicy: string;
  intake: IntakeQuestion[];
  branding: BookingBranding;
}

export const DEFAULT_SETTINGS: BookingSettings = {
  enabled: false, slug: '', durationMinutes: 60, leadTimeHours: 2, windowDays: 14,
  bufferBefore: 0, bufferAfter: 0, useBusinessHours: true, hours: {}, hiddenServices: [],
  depositCents: 0, depositPolicy: '', intake: [], branding: EMPTY_BRANDING,
};

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9-]{3,60}$/;

export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function newQuestionId(): string {
  return `q_${Math.random().toString(36).slice(2, 10)}`;
}

export function newIntakeQuestion(): IntakeQuestion {
  return { id: newQuestionId(), label: '', type: 'text', required: false, options: [] };
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    const o = raw.trim();
    if (o && !seen.has(o.toLowerCase())) { seen.add(o.toLowerCase()); out.push(o); }
  }
  return out;
}

export function parseHexRgb(hex: string | null | undefined): [number, number, number] | null {
  if (!hex || !HEX_RE.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** WCAG contrast ratio of white text on this colour (1–21). */
export function contrastWithWhite(hex: string): number {
  const rgb = parseHexRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

export function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/** Defence in depth: the public page injects this into inline CSS, so it is
 *  re-validated here even though the DB value was validated on save. */
export function brandingStyle(branding: BookingBranding | null | undefined): CSSProperties | undefined {
  const rgb = parseHexRgb(branding?.accent_color);
  if (!rgb || contrastWithWhite(branding!.accent_color!) < BOOKING_LIMITS.minContrastWithWhite) return undefined;
  const triplet = rgb.join(' ');
  return { '--accent-primary': triplet, '--accent-secondary': triplet } as CSSProperties;
}

// ------------------------------------------------------------
// Row <-> settings mapping
// ------------------------------------------------------------

export function sanitizeIntake(raw: unknown): IntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const types: IntakeQuestionType[] = ['text', 'longtext', 'select', 'yesno'];
  const out: IntakeQuestion[] = [];
  for (const item of raw.slice(0, BOOKING_LIMITS.intakeMax)) {
    const q = item as Partial<IntakeQuestion> | null;
    if (!q || typeof q.id !== 'string' || typeof q.label !== 'string') continue;
    out.push({
      id: q.id,
      label: q.label,
      type: types.includes(q.type as IntakeQuestionType) ? (q.type as IntakeQuestionType) : 'text',
      required: q.required === true,
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : [],
    });
  }
  return out;
}

export function sanitizeBranding(raw: unknown): BookingBranding {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const color = str(b.accent_color);
  const logo = str(b.logo_url);
  return {
    accent_color: HEX_RE.test(color) ? color.toLowerCase() : null,
    logo_url: logo && isHttpsUrl(logo) ? logo : null,
    headline: str(b.headline), intro: str(b.intro), confirmation_message: str(b.confirmation_message),
  };
}

export function sanitizeHours(raw: unknown): HoursMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: HoursMap = {};
  for (const day of DAY_ORDER) {
    const e = (raw as Record<string, { open?: unknown; close?: unknown } | undefined>)[day];
    if (e && typeof e.open === 'string' && typeof e.close === 'string') out[day] = { open: e.open, close: e.close };
  }
  return out;
}

export interface BookingProfileRow {
  booking_slug?: string | null;
  booking_enabled?: boolean | null;
  booking_default_duration_minutes?: number | null;
  booking_lead_time_hours?: number | null;
  booking_window_days?: number | null;
  booking_buffer_before_minutes?: number | null;
  booking_buffer_after_minutes?: number | null;
  booking_hours?: unknown;
  booking_hidden_services?: string[] | null;
  booking_deposit_cents?: number | null;
  booking_deposit_policy?: string | null;
  booking_intake_questions?: unknown;
  booking_branding?: unknown;
  business_hours?: unknown;
}

export function settingsFromRow(row: BookingProfileRow | null): BookingSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  const custom = row.booking_hours != null;
  return {
    enabled: row.booking_enabled === true,
    slug: row.booking_slug ?? '',
    durationMinutes: toInt(row.booking_default_duration_minutes, DEFAULT_SETTINGS.durationMinutes),
    leadTimeHours: toInt(row.booking_lead_time_hours, DEFAULT_SETTINGS.leadTimeHours),
    windowDays: toInt(row.booking_window_days, DEFAULT_SETTINGS.windowDays),
    bufferBefore: toInt(row.booking_buffer_before_minutes, 0),
    bufferAfter: toInt(row.booking_buffer_after_minutes, 0),
    useBusinessHours: !custom,
    hours: sanitizeHours(custom ? row.booking_hours : row.business_hours),
    hiddenServices: row.booking_hidden_services ?? [],
    depositCents: toInt(row.booking_deposit_cents, 0),
    depositPolicy: row.booking_deposit_policy ?? '',
    intake: sanitizeIntake(row.booking_intake_questions),
    branding: sanitizeBranding(row.booking_branding),
  };
}

/** Columns written to business_profile. Prunes hidden services that no
 *  longer exist and cleans intake options so the DB never holds junk. */
export function settingsToPayload(s: BookingSettings, knownServices: string[]) {
  return {
    booking_slug: s.slug.trim() || null,
    booking_enabled: s.enabled,
    booking_default_duration_minutes: s.durationMinutes,
    booking_lead_time_hours: s.leadTimeHours,
    booking_window_days: s.windowDays,
    booking_buffer_before_minutes: s.bufferBefore,
    booking_buffer_after_minutes: s.bufferAfter,
    booking_hours: s.useBusinessHours ? null : s.hours,
    booking_hidden_services: s.hiddenServices.filter((h) => knownServices.includes(h)),
    booking_deposit_cents: s.depositCents,
    booking_deposit_policy: s.depositPolicy.trim() || null,
    booking_intake_questions: s.intake.map((q) => ({
      id: q.id,
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      options: q.type === 'select' ? cleanOptions(q.options) : [],
    })),
    booking_branding: {
      accent_color: s.branding.accent_color,
      logo_url: s.branding.logo_url?.trim() || null,
      headline: s.branding.headline.trim(),
      intro: s.branding.intro.trim(),
      confirmation_message: s.branding.confirmation_message.trim(),
    },
  };
}

// ------------------------------------------------------------
// Validation (mirrors the DB constraints + RPC checks)
// ------------------------------------------------------------

export type SettingsErrors = Record<string, string>;

function inRange(n: number, min: number, max: number) { return Number.isInteger(n) && n >= min && n <= max; }

export function validateSettings(s: BookingSettings): SettingsErrors {
  const L = BOOKING_LIMITS;
  const e: SettingsErrors = {};

  if (s.slug && !SLUG_RE.test(s.slug)) e.slug = `Use ${L.slugMin}–${L.slugMax} lowercase letters, numbers or dashes.`;
  else if (s.enabled && !s.slug) e.slug = 'Choose a booking link before turning online booking on.';

  if (!inRange(s.durationMinutes, L.durationMin, L.durationMax)) e.duration = `Between ${L.durationMin} and ${L.durationMax} minutes.`;
  if (!inRange(s.leadTimeHours, 0, L.leadTimeMaxHours)) e.leadTime = `Between 0 and ${L.leadTimeMaxHours} hours.`;
  if (!inRange(s.windowDays, L.windowMinDays, L.windowMaxDays)) e.window = `Between ${L.windowMinDays} and ${L.windowMaxDays} days.`;
  if (!inRange(s.bufferBefore, 0, L.bufferMax)) e.bufferBefore = `Between 0 and ${L.bufferMax} minutes.`;
  if (!inRange(s.bufferAfter, 0, L.bufferMax)) e.bufferAfter = `Between 0 and ${L.bufferMax} minutes.`;

  if (!s.useBusinessHours) {
    const open = DAY_ORDER.filter((d) => s.hours[d]);
    if (open.length === 0) e.hours = 'Open at least one day, or switch back to your business hours.';
    for (const d of open) {
      const h = s.hours[d]!;
      if (!TIME_RE.test(h.open) || !TIME_RE.test(h.close)) e[`hours.${d}`] = 'Enter a valid time.';
      else if (h.open >= h.close) e[`hours.${d}`] = 'Closing time must be after opening time.';
      else if (minutes(h.close) - minutes(h.open) < s.durationMinutes) e[`hours.${d}`] = 'Shorter than one appointment.';
    }
  }

  if (!inRange(s.depositCents, 0, L.depositMaxCents)) e.deposit = `Between $0 and ${formatCents(L.depositMaxCents)}.`;
  if (s.depositPolicy.length > L.policyMax) e.depositPolicy = `Keep it under ${L.policyMax} characters.`;

  if (s.intake.length > L.intakeMax) e.intake = `At most ${L.intakeMax} questions.`;
  const ids = new Set<string>();
  for (const q of s.intake) {
    const key = `intake.${q.id}`;
    if (!q.label.trim()) e[key] = 'Write the question customers will see.';
    else if (q.label.trim().length > L.labelMax) e[key] = `Keep it under ${L.labelMax} characters.`;
    else if (ids.has(q.id)) e[key] = 'Duplicate question.';
    else if (q.type === 'select') {
      const opts = cleanOptions(q.options);
      if (opts.length < L.optionsMin || opts.length > L.optionsMax) e[key] = `Give ${L.optionsMin}–${L.optionsMax} different options, one per line.`;
      else if (opts.some((o) => o.length > L.optionLenMax)) e[key] = `Options must be under ${L.optionLenMax} characters.`;
    }
    ids.add(q.id);
  }

  const b = s.branding;
  if (b.accent_color) {
    if (!HEX_RE.test(b.accent_color)) e.accent = 'Use a 6-digit hex colour like #1f3ad8.';
    else if (contrastWithWhite(b.accent_color) < L.minContrastWithWhite) e.accent = 'Too light — white button text would be hard to read. Pick a darker colour.';
  }
  if (b.logo_url && (!isHttpsUrl(b.logo_url) || b.logo_url.length > 500)) e.logo = 'Use a secure https:// image link.';
  if (b.headline.length > L.headlineMax) e.headline = `Keep it under ${L.headlineMax} characters.`;
  if (b.intro.length > L.introMax) e.intro = `Keep it under ${L.introMax} characters.`;
  if (b.confirmation_message.length > L.confirmationMax) e.confirmation = `Keep it under ${L.confirmationMax} characters.`;

  return e;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Client-side check of a customer's intake answers (the RPC re-checks). */
export function validateIntakeAnswers(questions: IntakeQuestion[], answers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = (answers[q.id] ?? '').trim();
    if (!a) { if (q.required) out[q.id] = 'This question is required.'; continue; }
    if (a.length > BOOKING_LIMITS.answerMax) out[q.id] = `Keep it under ${BOOKING_LIMITS.answerMax} characters.`;
    else if (q.type === 'select' && !q.options.includes(a)) out[q.id] = 'Choose one of the options.';
    else if (q.type === 'yesno' && a !== 'yes' && a !== 'no') out[q.id] = 'Choose yes or no.';
  }
  return out;
}

// ------------------------------------------------------------
// Slot engine — duration grid, lead time, window, holidays, and buffers
// ------------------------------------------------------------

export interface BusyInterval { start: Date; durationMinutes: number }

export interface SlotPolicy {
  hours: HoursMap | null;
  holidays: string[]; // 'YYYY-MM-DD' in local time
  durationMinutes: number;
  leadTimeHours: number;
  windowDays: number;
  bufferBefore: number; // quiet time required before a new booking starts
  bufferAfter: number;  // quiet time required after a new booking ends
}

const JS_DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN = 60_000;

function localDateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function parseTime(value: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
}

/** A candidate [start, start+duration) conflicts with an existing job if it
 *  starts less than `bufferAfter` before it begins, or ends less than
 *  `bufferBefore` after it finishes. (Same rule the RPC enforces in SQL.) */
export function isSlotFree(start: Date, policy: Pick<SlotPolicy, 'durationMinutes' | 'bufferBefore' | 'bufferAfter'>, busy: BusyInterval[]): boolean {
  const s = start.getTime();
  const end = s + policy.durationMinutes * MIN;
  return !busy.some((b) => {
    const bs = b.start.getTime();
    const be = bs + b.durationMinutes * MIN;
    return bs < end + policy.bufferAfter * MIN && be > s - policy.bufferBefore * MIN;
  });
}

export function generateSlots(policy: SlotPolicy, busy: BusyInterval[], now: Date = new Date(), maxSlots = 40): Date[] {
  if (!policy.hours) return [];
  const duration = policy.durationMinutes > 0 ? policy.durationMinutes : 60;
  const effective = { ...policy, durationMinutes: duration };
  const earliest = now.getTime() + policy.leadTimeHours * 60 * MIN;
  const latest = now.getTime() + policy.windowDays * 24 * 60 * MIN;
  const holidays = new Set(policy.holidays);
  const slots: Date[] = [];

  for (let d = 0; d <= policy.windowDays && slots.length < maxSlots; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const window = policy.hours[JS_DAY_KEYS[day.getDay()]];
    if (!window || holidays.has(localDateKey(day))) continue;
    const open = parseTime(window.open);
    const close = parseTime(window.close);
    if (!open || !close) continue;

    const cursor = new Date(day);
    cursor.setHours(open[0], open[1], 0, 0);
    const closeAt = new Date(day);
    closeAt.setHours(close[0], close[1], 0, 0);

    while (cursor.getTime() + duration * MIN <= closeAt.getTime() && slots.length < maxSlots) {
      const t = cursor.getTime();
      if (t >= earliest && t <= latest && isSlotFree(cursor, effective, busy)) slots.push(new Date(cursor));
      cursor.setMinutes(cursor.getMinutes() + duration);
    }
  }
  return slots;
}
