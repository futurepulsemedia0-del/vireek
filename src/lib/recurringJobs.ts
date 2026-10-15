/**
 * Recurring Jobs — client library.
 *
 * Maintenance agreements that auto-generate jobs. Generation, skipping,
 * rescheduling and cancelling all happen in Postgres (see
 * supabase/migrations/20270403000000_recurring_jobs.sql) so a visit, its job
 * and its invoice state always change together; this module is the typed,
 * tested wrapper plus the pure date math used for previews.
 *
 * Every query is scoped by `accountOwnerId` (never the signed-in user's own
 * id — for a team member those differ). RLS is the real wall.
 *
 * KEEP IN SYNC: occurrenceDate() mirrors public.recurring_occurrence_date().
 * recurringJobs.test.ts pins both to the same values (generated from Postgres).
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type IntervalUnit = 'week' | 'month' | 'year';
export type AgreementStatus = 'active' | 'paused' | 'cancelled' | 'completed';
export type OccurrenceStatus = 'generated' | 'skipped' | 'needs_attention';
export type InvoiceState = 'not_applicable' | 'pending' | 'sending' | 'sent' | 'blocked' | 'failed';

export interface RecurringAgreement {
  id: string;
  user_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  address: string;
  title: string;
  service_type: string | null;
  notes: string | null;
  interval_unit: IntervalUnit;
  interval_count: number;
  start_date: string; // YYYY-MM-DD
  end_date: string | null;
  preferred_time: string; // HH:MM[:SS]
  timezone: string;
  duration_minutes: number;
  preferred_technician_id: string | null;
  price_amount: number | null;
  auto_invoice: boolean;
  lead_time_days: number;
  status: AgreementStatus;
  next_occurrence_n: number;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringOccurrence {
  id: string;
  user_id: string;
  agreement_id: string;
  occurrence_n: number;
  occurrence_date: string;
  scheduled_datetime: string;
  status: OccurrenceStatus;
  job_id: string | null;
  skip_reason: string | null;
  attention_reason: string | null;
  invoice_state: InvoiceState;
  invoice_error: string | null;
  invoiced_at: string | null;
  job: { id: string; job_status: string; invoice_status: string } | null;
}

export interface AgreementInput {
  id?: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  address: string;
  title: string;
  serviceType: string;
  notes: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  preferredTime: string;
  timezone: string;
  durationMinutes: number;
  preferredTechnicianId: string | null;
  priceAmount: number | null;
  autoInvoice: boolean;
  leadTimeDays: number;
}

export interface FrequencyPreset {
  key: string;
  label: string;
  unit: IntervalUnit;
  count: number;
}

export const FREQUENCY_PRESETS: FrequencyPreset[] = [
  { key: 'weekly', label: 'Weekly', unit: 'week', count: 1 },
  { key: 'biweekly', label: 'Every 2 weeks', unit: 'week', count: 2 },
  { key: 'monthly', label: 'Monthly', unit: 'month', count: 1 },
  { key: 'quarterly', label: 'Quarterly', unit: 'month', count: 3 },
  { key: 'semiannual', label: 'Every 6 months', unit: 'month', count: 6 },
  { key: 'annual', label: 'Annually', unit: 'year', count: 1 },
];

export const MAX_LOOKAHEAD_PREVIEW = 6;

// ============================================================
// DATE MATH (pure; mirrors public.recurring_occurrence_date)
// ============================================================

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toISO(y: number, m0: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad(m0 + 1)}-${pad(d)}`;
}

/**
 * Occurrence N is always computed from the anchor (start + N·interval), never
 * "previous + interval", so month-end agreements don't drift: Jan 31 monthly
 * is Jan 31, Feb 28, Mar 31. Month/year steps clamp to the last valid day.
 */
export function occurrenceDate(
  start: string,
  unit: IntervalUnit,
  count: number,
  n: number,
): string {
  const m = ISO_DATE.exec(start);
  if (!m) throw new Error(`Invalid date: ${start}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  if (unit === 'week') {
    const dt = new Date(Date.UTC(y, mo, d + n * count * 7));
    return toISO(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  }
  const months = unit === 'month' ? n * count : n * count * 12;
  const total = y * 12 + mo + months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return toISO(ty, tm, Math.min(d, lastDay));
}

export interface PreviewOccurrence {
  n: number;
  date: string;
}

/** Next `limit` occurrence dates from index `fromN`, stopping at end_date. */
export function previewOccurrences(
  agreement: Pick<
    RecurringAgreement,
    'start_date' | 'end_date' | 'interval_unit' | 'interval_count'
  >,
  fromN: number,
  limit: number = MAX_LOOKAHEAD_PREVIEW,
): PreviewOccurrence[] {
  const out: PreviewOccurrence[] = [];
  for (let n = fromN; out.length < limit && n < fromN + 5000; n += 1) {
    const date = occurrenceDate(
      agreement.start_date,
      agreement.interval_unit,
      agreement.interval_count,
      n,
    );
    if (agreement.end_date && date > agreement.end_date) break;
    out.push({ n, date });
  }
  return out;
}

// ============================================================
// TIMEZONE CONVERSION (pure, Intl-based — no dependency)
// ============================================================

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock date+time in `timeZone` → UTC ISO string (DST-aware). */
export function zonedToUtcISO(date: string, time: string, timeZone: string): string {
  const dm = ISO_DATE.exec(date);
  const tm = /^(\d{2}):(\d{2})/.exec(time);
  if (!dm || !tm) throw new Error('Invalid date or time.');
  const wall = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
  );
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone); // second pass settles DST boundaries
  return new Date(utc).toISOString();
}

/** UTC ISO string → wall-clock { date, time } in `timeZone`. */
export function utcToZonedParts(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export function describeFrequency(unit: IntervalUnit, count: number): string {
  const preset = FREQUENCY_PRESETS.find((p) => p.unit === unit && p.count === count);
  if (preset) return preset.label;
  const noun = unit === 'week' ? 'week' : unit === 'month' ? 'month' : 'year';
  return `Every ${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function presetKeyFor(unit: IntervalUnit, count: number): string {
  return FREQUENCY_PRESETS.find((p) => p.unit === unit && p.count === count)?.key ?? 'custom';
}

/** Approximate monthly value of an agreement (for the revenue stat only). */
export function monthlyValue(
  agreement: Pick<RecurringAgreement, 'price_amount' | 'interval_unit' | 'interval_count'>,
): number {
  const price = agreement.price_amount ?? 0;
  if (price <= 0 || agreement.interval_count <= 0) return 0;
  const visitsPerMonth =
    agreement.interval_unit === 'week'
      ? 52 / 12 / agreement.interval_count
      : agreement.interval_unit === 'month'
        ? 1 / agreement.interval_count
        : 1 / (12 * agreement.interval_count);
  return price * visitsPerMonth;
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function formatDateLabel(isoDate: string): string {
  const m = ISO_DATE.exec(isoDate);
  if (!m) return isoDate;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
    'en-US',
    {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    },
  );
}

export function formatTimeLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function todayISO(date: Date = new Date()): string {
  return toISO(date.getFullYear(), date.getMonth(), date.getDate());
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface AutoInvoiceReadiness {
  ok: boolean;
  problem: string | null;
}

/** Auto-invoicing needs a price and a way to reach the customer. */
export function autoInvoiceReadiness(
  input: Pick<AgreementInput, 'priceAmount' | 'customerEmail' | 'customerPhone'>,
): AutoInvoiceReadiness {
  if (!input.priceAmount || input.priceAmount <= 0)
    return { ok: false, problem: 'Set a price greater than $0 to auto-invoice.' };
  if (!input.customerEmail.trim() && !input.customerPhone.trim()) {
    return { ok: false, problem: 'Add the customer’s email or phone so the invoice can be sent.' };
  }
  return { ok: true, problem: null };
}

// ============================================================
// VALIDATION
// ============================================================

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAgreementInput(
  input: AgreementInput,
  today: string = todayISO(),
): string | null {
  if (!input.customerName.trim()) return 'Enter the customer’s name.';
  if (input.customerName.trim().length > 120)
    return 'Customer name must be 120 characters or fewer.';
  if (!input.address.trim()) return 'Enter the service address.';
  if (!input.title.trim()) return 'Give this agreement a title.';
  if (input.title.trim().length > 120) return 'Title must be 120 characters or fewer.';
  if (input.customerEmail.trim() && !EMAIL.test(input.customerEmail.trim()))
    return 'That email address doesn’t look right.';
  if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1 || input.intervalCount > 52)
    return 'Repeat interval must be a whole number from 1 to 52.';
  if (!isValidISODate(input.startDate)) return 'Choose a valid start date.';
  if (!input.id && input.startDate < today) return 'The first visit can’t be in the past.';
  if (input.endDate !== null) {
    if (!isValidISODate(input.endDate)) return 'Choose a valid end date.';
    if (input.endDate < input.startDate) return 'The end date must be on or after the start date.';
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(input.preferredTime)) return 'Choose a valid visit time.';
  if (!isValidTimeZone(input.timezone)) return 'Choose a valid timezone.';
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 15 ||
    input.durationMinutes > 1440
  )
    return 'Duration must be between 15 and 1440 minutes.';
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 1 || input.leadTimeDays > 90)
    return 'Create jobs ahead by 1 to 90 days.';
  if (
    input.priceAmount !== null &&
    (!Number.isFinite(input.priceAmount) || input.priceAmount < 0 || input.priceAmount > 99_999_999)
  )
    return 'Enter a valid price.';
  if (input.autoInvoice) {
    const readiness = autoInvoiceReadiness(input);
    if (!readiness.ok) return readiness.problem;
  }
  return null;
}

// ============================================================
// ERRORS (Postgres RPC → human message)
// ============================================================

export function friendlyRpcError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : '';
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === '23P01' || /slot_conflict/.test(text))
    return 'That time is already booked for this technician. Pick another time.';
  if (/job_already_started/.test(text))
    return 'That visit has already started, so it can’t be changed.';
  if (/datetime_in_past/.test(text)) return 'Choose a time in the future.';
  if (/occurrence_skipped/.test(text)) return 'This visit was skipped, so it can’t be rescheduled.';
  if (/not_authorized/.test(text) || code === '42501')
    return 'You don’t have permission to change recurring jobs.';
  if (/agreement_not_found|occurrence_not_found/.test(text))
    return 'That visit no longer exists. Refresh and try again.';
  if (/schedule_locked/.test(text))
    return 'The start date and frequency can’t change once visits exist. Create a new agreement instead.';
  if (/invalid_timezone/.test(text)) return 'That timezone isn’t recognized.';
  if (/uq_|duplicate key/.test(text)) return 'That already exists.';
  return 'Something went wrong. Please try again.';
}

// ============================================================
// DATA ACCESS (scoped by accountOwnerId)
// ============================================================

function requireOwner(accountOwnerId: string | null | undefined): string {
  if (!accountOwnerId) throw new Error('No account context available.');
  return accountOwnerId;
}

export interface RecurringBundle {
  agreements: RecurringAgreement[];
  occurrences: RecurringOccurrence[];
}

/** Occurrences from 45 days back through everything upcoming — enough to show history, bounded for large accounts. */
export async function fetchRecurringBundle(
  accountOwnerId: string | null | undefined,
): Promise<RecurringBundle> {
  const owner = requireOwner(accountOwnerId);
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [agRes, occRes] = await Promise.all([
    supabase
      .from('recurring_agreements')
      .select('*')
      .eq('user_id', owner)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('recurring_occurrences')
      .select('*, job:jobs(id, job_status, invoice_status)')
      .eq('user_id', owner)
      .gte('scheduled_datetime', since)
      .order('scheduled_datetime', { ascending: true })
      .limit(2000),
  ]);
  if (agRes.error) throw agRes.error;
  if (occRes.error) throw occRes.error;
  return {
    agreements: (agRes.data as RecurringAgreement[]) ?? [],
    occurrences: (occRes.data as RecurringOccurrence[]) ?? [],
  };
}

export interface CustomerOption {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}

export async function fetchCustomerOptions(
  accountOwnerId: string | null | undefined,
): Promise<CustomerOption[]> {
  const owner = requireOwner(accountOwnerId);
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, address')
    .eq('user_id', owner)
    .order('name')
    .limit(500);
  if (error) throw error;
  return (data as CustomerOption[]) ?? [];
}

export async function saveAgreement(
  accountOwnerId: string | null | undefined,
  input: AgreementInput,
): Promise<string> {
  const owner = requireOwner(accountOwnerId);
  const invalid = validateAgreementInput(input);
  if (invalid) throw new Error(invalid);

  const payload = {
    customer_id: input.customerId,
    customer_name: input.customerName.trim(),
    customer_phone: input.customerPhone.trim() || null,
    customer_email: input.customerEmail.trim() || null,
    address: input.address.trim(),
    title: input.title.trim(),
    service_type: input.serviceType.trim() || null,
    notes: input.notes.trim() || null,
    interval_unit: input.intervalUnit,
    interval_count: input.intervalCount,
    start_date: input.startDate,
    end_date: input.endDate,
    preferred_time: input.preferredTime,
    timezone: input.timezone,
    duration_minutes: input.durationMinutes,
    preferred_technician_id: input.preferredTechnicianId,
    price_amount: input.priceAmount,
    auto_invoice: input.autoInvoice,
    lead_time_days: input.leadTimeDays,
  };

  if (input.id) {
    const { error } = await supabase
      .from('recurring_agreements')
      .update(payload)
      .eq('id', input.id)
      .eq('user_id', owner);
    if (error) throw error;
    return input.id;
  }
  const { data, error } = await supabase
    .from('recurring_agreements')
    .insert({ ...payload, user_id: owner })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function setAgreementStatus(
  accountOwnerId: string | null | undefined,
  id: string,
  status: 'active' | 'paused',
): Promise<void> {
  const owner = requireOwner(accountOwnerId);
  const { error } = await supabase
    .from('recurring_agreements')
    .update({ status })
    .eq('id', id)
    .eq('user_id', owner);
  if (error) throw error;
}

export async function cancelAgreement(id: string): Promise<{ jobs_cancelled: number }> {
  const { data, error } = await supabase.rpc('cancel_recurring_agreement', { p_agreement_id: id });
  if (error) throw error;
  return data as { jobs_cancelled: number };
}

export async function skipOccurrence(
  agreementId: string,
  occurrenceN: number,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('skip_recurring_occurrence', {
    p_agreement_id: agreementId,
    p_occurrence_n: occurrenceN,
    p_reason: reason.trim() || null,
  });
  if (error) throw error;
}

export async function rescheduleOccurrence(
  occurrenceId: string,
  newDateTimeISO: string,
): Promise<void> {
  const { error } = await supabase.rpc('reschedule_recurring_occurrence', {
    p_occurrence_id: occurrenceId,
    p_new_datetime: newDateTimeISO,
  });
  if (error) throw error;
}
