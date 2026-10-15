import { supabase } from '@/lib/supabase';

// ============================================================
// Scheduled reports — types, validation, formatting, data access
//
// Pure helpers (parseRecipients, validateScheduleInput, describeCadence,
// statusMeta…) are unit-tested. The "when does it run next" maths is NOT
// here on purpose: next_run_at is computed by the database
// (scheduled_report_next_run) in the schedule's own timezone, so the UI
// can never disagree with what the cron actually does.
//
// Every query is scoped to the ACCOUNT OWNER id, on top of table RLS.
// ============================================================

export type ScheduleFrequency = 'weekly' | 'monthly';
export type DeliveryStatus = 'pending' | 'sent' | 'partial' | 'failed' | 'skipped';

export interface ScheduledReport {
  id: string;
  user_id: string;
  created_by: string;
  report_id: string;
  frequency: ScheduleFrequency;
  weekday: number;
  month_day: number;
  send_hour: number;
  timezone: string;
  recipients: string[];
  include_csv: boolean;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: Exclude<DeliveryStatus, 'pending'> | null;
  consecutive_failures: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryResult {
  email: string;
  ok: boolean;
  error?: string;
}

export interface Delivery {
  id: string;
  user_id: string;
  schedule_id: string | null;
  report_name: string;
  trigger: 'schedule' | 'manual';
  status: DeliveryStatus;
  scheduled_for: string | null;
  recipients_total: number;
  recipients_sent: number;
  row_count: number | null;
  results: DeliveryResult[];
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ScheduleInput {
  reportId: string;
  frequency: ScheduleFrequency;
  weekday: number;
  monthDay: number;
  sendHour: number;
  timezone: string;
  recipients: string[];
  includeCsv: boolean;
  isActive: boolean;
}

export const MAX_RECIPIENTS = 10;
export const MAX_SCHEDULES = 25;
export const DELIVERY_PAGE_SIZE = 25;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// Same shape the database trigger enforces.
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// ============================================================
// Pure helpers
// ============================================================

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Splits free text on commas / semicolons / whitespace; lower-cases and de-duplicates. */
export function parseRecipients(text: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    (isValidEmail(v) ? emails : invalid).push(v);
  }
  return { emails, invalid };
}

export function validateScheduleInput(input: ScheduleInput): string | null {
  if (!input.reportId) return 'Choose a report to send.';
  if (!Number.isInteger(input.sendHour) || input.sendHour < 0 || input.sendHour > 23) return 'Pick a valid send time.';
  if (input.frequency === 'weekly' && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) return 'Pick a day of the week.';
  if (input.frequency === 'monthly' && (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 28)) return 'Pick a day of the month (1–28).';
  if (!input.timezone.trim()) return 'Pick a timezone.';
  if (input.recipients.length === 0) return 'Add at least one recipient email.';
  if (input.recipients.length > MAX_RECIPIENTS) return `You can add up to ${MAX_RECIPIENTS} recipients.`;
  const bad = input.recipients.find((r) => !isValidEmail(r));
  if (bad) return `"${bad}" is not a valid email address.`;
  return null;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function formatHour(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}

export function describeCadence(s: Pick<ScheduledReport, 'frequency' | 'weekday' | 'month_day' | 'send_hour' | 'timezone'>): string {
  const when = s.frequency === 'weekly' ? `Every ${WEEKDAYS[s.weekday] ?? 'week'}` : `Monthly on the ${ordinal(s.month_day)}`;
  return `${when} at ${formatHour(s.send_hour)} (${s.timezone})`;
}

export function formatInTimeZone(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
}

export interface StatusMeta {
  label: string;
  tone: string;
}

const STATUS_META: Record<DeliveryStatus, StatusMeta> = {
  pending: { label: 'Sending…', tone: 'bg-bg-tertiary text-text-secondary' },
  sent: { label: 'Delivered', tone: 'bg-success/10 text-success-500' },
  partial: { label: 'Partly delivered', tone: 'bg-warning-500/10 text-warning-500' },
  failed: { label: 'Failed', tone: 'bg-danger/10 text-danger' },
  skipped: { label: 'Skipped', tone: 'bg-bg-tertiary text-text-secondary' },
};

export function statusMeta(status: DeliveryStatus | null): StatusMeta {
  return status ? STATUS_META[status] : { label: 'Not run yet', tone: 'bg-bg-tertiary text-text-secondary' };
}

const FALLBACK_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
  'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul',
  'Asia/Dubai', 'Asia/Baku', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function listTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const all = new Set([...(zones.length ? zones : FALLBACK_TIMEZONES), 'UTC', browserTimezone()]);
  return Array.from(all).sort();
}

export function defaultScheduleInput(reportId = ''): ScheduleInput {
  return {
    reportId,
    frequency: 'weekly',
    weekday: 1,
    monthDay: 1,
    sendHour: 8,
    timezone: browserTimezone(),
    recipients: [],
    includeCsv: true,
    isActive: true,
  };
}

export function toScheduleInput(s: ScheduledReport): ScheduleInput {
  return {
    reportId: s.report_id,
    frequency: s.frequency,
    weekday: s.weekday,
    monthDay: s.month_day,
    sendHour: s.send_hour,
    timezone: s.timezone,
    recipients: [...s.recipients],
    includeCsv: s.include_csv,
    isActive: s.is_active,
  };
}

// ============================================================
// Data access — scoped to the ACCOUNT OWNER
// ============================================================

export function toScheduleError(err: unknown, fallback: string): Error {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '54000') return new Error(`You've reached the limit of ${MAX_SCHEDULES} schedules. Delete one to add another.`);
  if (e?.code === '23503') return new Error('That report no longer exists. Refresh and pick another.');
  if (e?.code === '42501') return new Error('You do not have permission to manage scheduled reports.');
  if (e?.code === '22023' && e.message) return new Error(e.message);
  return new Error(e?.message || fallback);
}

const rowFrom = (accountOwnerId: string, input: ScheduleInput) => ({
  user_id: accountOwnerId,
  report_id: input.reportId,
  frequency: input.frequency,
  weekday: input.weekday,
  month_day: input.monthDay,
  send_hour: input.sendHour,
  timezone: input.timezone,
  recipients: input.recipients,
  include_csv: input.includeCsv,
  is_active: input.isActive,
});

export async function listSchedules(accountOwnerId: string): Promise<ScheduledReport[]> {
  const { data, error } = await supabase
    .from('scheduled_reports')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(MAX_SCHEDULES);
  if (error) throw toScheduleError(error, 'Could not load schedules.');
  return (data ?? []) as unknown as ScheduledReport[];
}

export async function createSchedule(accountOwnerId: string, input: ScheduleInput): Promise<ScheduledReport> {
  const { data, error } = await supabase.from('scheduled_reports').insert(rowFrom(accountOwnerId, input)).select('*').single();
  if (error) throw toScheduleError(error, 'Could not create the schedule.');
  return data as unknown as ScheduledReport;
}

export async function updateSchedule(accountOwnerId: string, id: string, input: ScheduleInput): Promise<ScheduledReport> {
  // user_id is immutable (trigger + column grants); only the editable columns are sent.
  const { user_id: _owner, ...patch } = rowFrom(accountOwnerId, input);
  void _owner;
  const { data, error } = await supabase.from('scheduled_reports').update(patch).eq('id', id).eq('user_id', accountOwnerId).select('*').single();
  if (error) throw toScheduleError(error, 'Could not update the schedule.');
  return data as unknown as ScheduledReport;
}

export async function setScheduleActive(accountOwnerId: string, id: string, isActive: boolean): Promise<ScheduledReport> {
  const { data, error } = await supabase
    .from('scheduled_reports')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .select('*')
    .single();
  if (error) throw toScheduleError(error, 'Could not update the schedule.');
  return data as unknown as ScheduledReport;
}

export async function deleteSchedule(accountOwnerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('scheduled_reports').delete().eq('id', id).eq('user_id', accountOwnerId);
  if (error) throw toScheduleError(error, 'Could not delete the schedule.');
}

export interface DeliveryQuery {
  scheduleId?: string;
  status?: DeliveryStatus;
  /** Keyset cursor: only rows created before this ISO timestamp. */
  before?: string;
  limit?: number;
}

export async function listDeliveries(accountOwnerId: string, query: DeliveryQuery = {}): Promise<Delivery[]> {
  let q = supabase.from('scheduled_report_deliveries').select('*').eq('user_id', accountOwnerId);
  if (query.scheduleId) q = q.eq('schedule_id', query.scheduleId);
  if (query.status) q = q.eq('status', query.status);
  if (query.before) q = q.lt('created_at', query.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(query.limit ?? DELIVERY_PAGE_SIZE);
  if (error) throw toScheduleError(error, 'Could not load the delivery log.');
  return (data ?? []) as unknown as Delivery[];
}

/** Sends one schedule immediately via the edge function (it re-checks permission + rate-limits server-side). */
export async function sendScheduleNow(scheduleId: string): Promise<Delivery | null> {
  const { data, error } = await supabase.functions.invoke('scheduled-reports-run', {
    body: { action: 'send_now', scheduleId },
  });
  if (error) {
    let detail = error.message || 'Could not send the report.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = (await ctx.json()) as { detail?: string; error?: string };
        detail = body.detail || body.error || detail;
      } catch {
        /* keep the generic message */
      }
    }
    throw new Error(detail);
  }
  return ((data as { delivery?: Delivery } | null)?.delivery ?? null) as Delivery | null;
}
