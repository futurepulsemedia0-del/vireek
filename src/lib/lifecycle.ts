// src/lib/lifecycle.ts
//
// Pure (no network) helpers for Customer Lifecycle Touches: types, calendar maths, form validation.
// Message rendering / validation is imported from the SAME module the edge function sends with, so the
// preview an owner sees is produced by the code that sends the message.

import {
  MAX_LEAD_DAYS,
  TOUCH_META,
  TOUCH_TYPES,
  addDays,
  daysBetween,
  isIsoDate,
  type Channel,
  type OfferType,
  type Occurrence,
  type TouchType,
} from '../../supabase/functions/_shared/lifecycle/lifecycleCore';

export {
  TOUCH_META,
  TOUCH_TYPES,
  TEMPLATE_VARIABLES,
  MAX_LEAD_DAYS,
  defaultSetupTemplates,
  formatOffer,
  normalizeOfferCode,
  renderTemplate,
  sampleVars,
  smsSegments,
  validateTemplate,
  zonedNow,
} from '../../supabase/functions/_shared/lifecycle/lifecycleCore';
export type { Channel, OfferType, TouchType } from '../../supabase/functions/_shared/lifecycle/lifecycleCore';

export interface DeliveryInfo {
  status: 'claimed' | 'sent' | 'deferred' | 'failed' | 'skipped';
  reason: string | null;
}

export interface CalendarRow extends Occurrence {
  delivery: Partial<Record<Channel, DeliveryInfo>>;
}

export interface TouchSettings {
  id: string;
  touch_type: TouchType;
  campaign_id: string | null;
  lead_days: number;
  send_hour: number;
  min_years: number;
  max_years: number;
  equipment_types: string[];
  offer_enabled: boolean;
  offer_type: OfferType;
  offer_value: number | null;
  offer_title: string | null;
  offer_terms: string | null;
  offer_valid_days: number;
}

export interface LifecycleProfile {
  customer_id: string;
  birth_month: number | null;
  birth_day: number | null;
  home_purchase_date: string | null;
  opted_in_touches: TouchType[];
  email_consent: boolean;
  sms_consent: boolean;
  consent_source: ConsentSource | null;
  consent_at: string | null;
  consent_withdrawn_at: string | null;
}

export type ConsentSource = 'verbal' | 'written' | 'booking_form' | 'customer_portal';

export const CONSENT_SOURCES: { value: ConsentSource; label: string }[] = [
  { value: 'verbal', label: 'Customer agreed verbally' },
  { value: 'written', label: 'Signed / written consent' },
  { value: 'booking_form', label: 'Online booking form' },
  { value: 'customer_portal', label: 'Customer portal' },
];

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Longest valid day for a month (Feb allows 29: a Feb-29 birthday is celebrated on Feb 28 in common years). */
export function maxDayOfMonth(month: number): number {
  return month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface GridCell {
  iso: string;
  day: number;
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Always 6 weeks (42 cells), weeks start on Sunday. `month` is 1-12. */
export function buildMonthGrid(year: number, month: number): GridCell[] {
  const firstIso = `${year}-${pad(month)}-01`;
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const start = addDays(firstIso, -weekday);
  return Array.from({ length: 42 }, (_, i) => {
    const iso = addDays(start, i);
    return { iso, day: Number(iso.slice(8)), inMonth: Number(iso.slice(5, 7)) === month };
  });
}

export function gridRange(grid: GridCell[]): { from: string; to: string } {
  return { from: grid[0].iso, to: grid[grid.length - 1].iso };
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function groupByDate(rows: CalendarRow[]): Map<string, CalendarRow[]> {
  const out = new Map<string, CalendarRow[]>();
  for (const r of rows) out.set(r.occurrence_date, [...(out.get(r.occurrence_date) ?? []), r]);
  return out;
}

export type DeliveryState = 'sent' | 'failed' | 'pending' | 'skipped' | 'scheduled' | 'not_opted_in';

export function deliveryState(row: Pick<CalendarRow, 'delivery' | 'opted_in'>): DeliveryState {
  const items = Object.values(row.delivery ?? {}) as DeliveryInfo[];
  if (items.some((d) => d.status === 'sent')) return 'sent';
  if (items.some((d) => d.status === 'failed')) return 'failed';
  if (items.some((d) => d.status === 'deferred' || d.status === 'claimed')) return 'pending';
  if (items.length > 0) return 'skipped';
  return row.opted_in ? 'scheduled' : 'not_opted_in';
}

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  sent: 'Sent',
  failed: 'Failed',
  pending: 'Sending soon',
  skipped: 'Not sent',
  scheduled: 'Scheduled',
  not_opted_in: 'No opt-in',
};

export function relativeDayLabel(todayIso: string, iso: string): string {
  const d = daysBetween(todayIso, iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return d > 0 ? `In ${d} days` : `${-d} days ago`;
}

export function rowKey(r: Pick<CalendarRow, 'touch_type' | 'customer_id' | 'equipment_id' | 'occurrence_year'>): string {
  return `${r.touch_type}|${r.customer_id}|${r.equipment_id ?? '-'}|${r.occurrence_year}`;
}

export function touchTitle(r: Pick<CalendarRow, 'touch_type' | 'years_count' | 'equipment_label'>): string {
  const meta = TOUCH_META[r.touch_type];
  if (!meta.hasYears || r.years_count == null) return meta.label;
  const base = r.touch_type === 'equipment_install_anniversary' && r.equipment_label ? `${r.equipment_label} · ` : '';
  return `${base}${meta.label} · ${r.years_count} yr`;
}

// ---------------------------------------------------------------------------
// Customer consent form
// ---------------------------------------------------------------------------

export interface ProfileForm {
  birthMonth: string; // '' or 1-12
  birthDay: string;
  homePurchaseDate: string; // '' or YYYY-MM-DD
  touches: TouchType[];
  email: boolean;
  sms: boolean;
  source: ConsentSource | '';
}

export function emptyProfileForm(): ProfileForm {
  return { birthMonth: '', birthDay: '', homePurchaseDate: '', touches: [], email: false, sms: false, source: '' };
}

export function profileToForm(p: LifecycleProfile | null): ProfileForm {
  if (!p) return emptyProfileForm();
  return {
    birthMonth: p.birth_month ? String(p.birth_month) : '',
    birthDay: p.birth_day ? String(p.birth_day) : '',
    homePurchaseDate: p.home_purchase_date ?? '',
    touches: [...p.opted_in_touches],
    email: p.email_consent,
    sms: p.sms_consent,
    source: p.consent_source ?? '',
  };
}

export function validateProfileForm(f: ProfileForm, todayIso: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const hasM = f.birthMonth !== '';
  const hasD = f.birthDay !== '';
  if (hasM !== hasD) errors.birthday = 'Choose both the month and the day (or leave both empty).';
  else if (hasM && hasD) {
    const m = Number(f.birthMonth);
    const d = Number(f.birthDay);
    if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > maxDayOfMonth(m)) errors.birthday = 'That is not a valid month/day.';
  }
  if (f.homePurchaseDate) {
    if (!isIsoDate(f.homePurchaseDate)) errors.homePurchaseDate = 'Enter a valid date.';
    else if (f.homePurchaseDate > todayIso) errors.homePurchaseDate = 'The purchase date must be in the past.';
    else if (f.homePurchaseDate < '1900-01-01') errors.homePurchaseDate = 'Enter a date after 1900.';
  }
  if (f.touches.length > 0) {
    if (!f.email && !f.sms) errors.channels = 'Select at least one channel the customer agreed to.';
    if (!f.source) errors.source = 'Record how the customer gave consent.';
  }
  return errors;
}

/** Warnings (not blockers): the customer opted in to a touch we have no date for. */
export function missingDataWarnings(f: ProfileForm, hasEquipmentWithInstallDate: boolean): string[] {
  const out: string[] = [];
  if (f.touches.includes('birthday') && !(f.birthMonth && f.birthDay)) out.push('Birthday is selected but no birthday is recorded.');
  if (f.touches.includes('home_purchase_anniversary') && !f.homePurchaseDate) out.push('Home anniversary is selected but no purchase date is recorded.');
  if (f.touches.includes('equipment_install_anniversary') && !hasEquipmentWithInstallDate) out.push('No active equipment with an install date yet.');
  return out;
}

export function toggleTouch(list: TouchType[], t: TouchType): TouchType[] {
  const next = list.includes(t) ? list.filter((x) => x !== t) : [...list, t];
  return TOUCH_TYPES.filter((x) => next.includes(x)); // stable order
}

export const TOUCH_DOT: Record<TouchType, string> = {
  birthday: 'bg-pink-500',
  home_purchase_anniversary: 'bg-emerald-500',
  equipment_install_anniversary: 'bg-sky-500',
  first_service_anniversary: 'bg-amber-500',
};

// ---------------------------------------------------------------------------
// Touch settings draft validation (mirrors the database CHECK constraints so errors show before saving)
// ---------------------------------------------------------------------------

export type SettingsDraft = Pick<
  TouchSettings,
  'lead_days' | 'send_hour' | 'min_years' | 'max_years' | 'offer_enabled' | 'offer_type' | 'offer_value' | 'offer_title' | 'offer_valid_days'
>;

export function validateSettingsDraft(d: SettingsDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: number) => Number.isInteger(v);
  if (!int(d.lead_days) || d.lead_days < 0 || d.lead_days > MAX_LEAD_DAYS) e.lead_days = `Choose 0–${MAX_LEAD_DAYS} days.`;
  if (!int(d.send_hour) || d.send_hour < 0 || d.send_hour > 23) e.send_hour = 'Choose an hour between 0 and 23.';
  if (!int(d.min_years) || d.min_years < 1 || d.min_years > 100) e.min_years = 'Minimum is 1 year.';
  if (!int(d.max_years) || d.max_years < 1 || d.max_years > 100) e.max_years = 'Maximum is 100 years.';
  else if (d.min_years > d.max_years) e.max_years = 'Must be at least the minimum.';
  if (d.offer_enabled) {
    if (!(d.offer_title ?? '').trim()) e.offer_title = 'Describe what the offer applies to.';
    else if ((d.offer_title ?? '').length > 120) e.offer_title = 'Keep it under 120 characters.';
    if (d.offer_type === 'percent_off' && !(d.offer_value != null && d.offer_value > 0 && d.offer_value <= 100)) e.offer_value = 'Enter a percentage between 1 and 100.';
    if (d.offer_type === 'amount_off' && !(d.offer_value != null && d.offer_value > 0)) e.offer_value = 'Enter an amount above 0.';
    if (!int(d.offer_valid_days) || d.offer_valid_days < 1 || d.offer_valid_days > 365) e.offer_valid_days = 'Choose 1–365 days.';
  }
  return e;
}

export function parseEquipmentTypes(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(',')) {
    const t = part.trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen];
}
