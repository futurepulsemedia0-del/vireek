import { supabase } from '@/lib/supabase';
import { exportToCsv } from '@/lib/csvExport';

/**
 * Cancellation flow — client library for /dashboard/billing/cancel.
 *
 * All subscription changes go through ONE edge function
 * (`manage-subscription-cancellation`) that talks to Stripe and records the
 * outcome. Nothing here mutates billing state directly.
 */

// ============================================================
// REASONS
// ============================================================

export type CancelReason =
  | 'too_expensive'
  | 'missing_features'
  | 'not_using'
  | 'switching'
  | 'closing_business'
  | 'technical_issues'
  | 'other';

export const MAX_DETAIL_LENGTH = 1000;
export const PAUSE_MONTH_OPTIONS = [1, 2, 3] as const;
export type PauseMonths = (typeof PAUSE_MONTH_OPTIONS)[number];

export const CANCEL_REASON_OPTIONS: { value: CancelReason; label: string; hint: string; skipsAlternatives?: boolean }[] = [
  { value: 'too_expensive', label: 'It’s too expensive', hint: 'The price doesn’t fit my budget right now' },
  { value: 'not_using', label: 'I’m not using it enough', hint: 'Fewer calls than I expected' },
  { value: 'missing_features', label: 'It’s missing something I need', hint: 'A feature or integration I rely on' },
  { value: 'technical_issues', label: 'I ran into problems', hint: 'Quality, accuracy or reliability issues' },
  { value: 'switching', label: 'I’m switching to another service', hint: 'Another tool or answering service' },
  { value: 'closing_business', label: 'I’m closing or selling my business', hint: 'No longer need a receptionist', skipsAlternatives: true },
  { value: 'other', label: 'Something else', hint: 'Tell us below' },
];

export function reasonSkipsAlternatives(reason: CancelReason | null): boolean {
  return CANCEL_REASON_OPTIONS.find((o) => o.value === reason)?.skipsAlternatives === true;
}

// ============================================================
// CONTEXT (live from Stripe via the edge function)
// ============================================================

export interface CancellationContext {
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  paused_until: string | null;
  price_cents: number | null;
  currency: string;
  offer: { percent_off: number; months: number } | null;
}

export type FlowResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

/** supabase-js hides the JSON body of non-2xx responses inside `error.context`. */
export async function extractFunctionError(error: unknown): Promise<{ message: string; code: string }> {
  const fallback = { message: 'Something went wrong. Please try again.', code: 'unknown' };
  if (!error || typeof error !== 'object') return fallback;
  const ctx = (error as { context?: unknown }).context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).json()) as { error?: string; code?: string };
      if (body?.error) return { message: body.error, code: body.code ?? 'unknown' };
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

type Request =
  | { action: 'context' }
  | { action: 'cancel'; reason: CancelReason; detail: string }
  | { action: 'pause'; months: PauseMonths; reason: CancelReason | null; detail: string }
  | { action: 'accept_offer'; reason: CancelReason | null; detail: string }
  | { action: 'resume' };

async function callFunction(body: Request): Promise<FlowResult<CancellationContext>> {
  try {
    const { data, error } = await supabase.functions.invoke<CancellationContext & { error?: string; code?: string }>(
      'manage-subscription-cancellation',
      { body },
    );
    if (error) {
      const e = await extractFunctionError(error);
      return { ok: false, error: e.message, code: e.code };
    }
    if (!data || data.error) return { ok: false, error: data?.error ?? 'Something went wrong. Please try again.', code: data?.code ?? 'unknown' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'We couldn’t reach the server. Check your connection and try again.', code: 'network' };
  }
}

export const fetchCancellationContext = () => callFunction({ action: 'context' });
export const scheduleCancellation = (reason: CancelReason, detail: string) => callFunction({ action: 'cancel', reason, detail });
export const pauseSubscription = (months: PauseMonths, reason: CancelReason | null, detail: string) =>
  callFunction({ action: 'pause', months, reason, detail });
export const acceptWinBackOffer = (reason: CancelReason | null, detail: string) =>
  callFunction({ action: 'accept_offer', reason, detail });
export const resumeSubscription = () => callFunction({ action: 'resume' });

// ============================================================
// REAL USAGE — "what you'd be leaving behind" (RLS-scoped, last 90 days)
// ============================================================

export interface UsageStats {
  callsAnswered: number;
  appointmentsBooked: number;
  jobsCompleted: number;
}

export const USAGE_WINDOW_DAYS = 90;

export async function fetchUsageStats(now: Date = new Date()): Promise<UsageStats | null> {
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 86400000).toISOString();
  try {
    const [calls, booked, jobs] = await Promise.all([
      supabase.from('calls').select('id', { count: 'exact', head: true }).gte('call_datetime', since),
      supabase.from('calls').select('id', { count: 'exact', head: true }).gte('call_datetime', since).eq('status', 'booked'),
      supabase.from('jobs').select('id', { count: 'exact', head: true }).gte('created_at', since).eq('job_status', 'completed'),
    ]);
    if (calls.error || booked.error || jobs.error) return null;
    return { callsAnswered: calls.count ?? 0, appointmentsBooked: booked.count ?? 0, jobsCompleted: jobs.count ?? 0 };
  } catch {
    return null;
  }
}

export function hasMeaningfulUsage(stats: UsageStats | null): stats is UsageStats {
  return !!stats && (stats.callsAnswered > 0 || stats.appointmentsBooked > 0 || stats.jobsCompleted > 0);
}

// ============================================================
// DATA EXPORT (CSV, RLS-scoped — a person can only ever export their own data)
// ============================================================

export type ExportKind = 'customers' | 'jobs' | 'calls';

const PAGE = 1000;
const MAX_ROWS = 20000;

async function fetchAllRows(table: ExportKind, orderBy: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

const col = (header: string, key: string) => ({ header, accessor: (r: Record<string, unknown>) => r[key] as string | number | boolean | null | undefined });

const EXPORT_CONFIG: Record<ExportKind, { orderBy: string; filename: string; columns: ReturnType<typeof col>[] }> = {
  customers: {
    orderBy: 'created_at',
    filename: 'vireek-customers',
    columns: [col('Name', 'name'), col('Phone', 'phone'), col('Email', 'email'), col('Address', 'address'), col('Type', 'customer_type'), col('Stage', 'lifecycle_stage'), col('Notes', 'notes'), col('Created', 'created_at')],
  },
  jobs: {
    orderBy: 'created_at',
    filename: 'vireek-jobs',
    columns: [col('Customer', 'customer_name'), col('Phone', 'customer_phone'), col('Service', 'service_type'), col('Address', 'address'), col('Status', 'job_status'), col('Scheduled', 'scheduled_datetime'), col('Invoice amount', 'invoice_amount'), col('Invoice status', 'invoice_status'), col('Created', 'created_at')],
  },
  calls: {
    orderBy: 'call_datetime',
    filename: 'vireek-calls',
    columns: [col('Date', 'call_datetime'), col('Caller', 'caller_name'), col('Phone', 'caller_phone'), col('Status', 'status'), col('Duration (s)', 'duration_seconds'), col('Emergency', 'is_emergency'), col('Summary', 'summary'), col('Transcript', 'transcript')],
  },
};

/** Downloads the CSV and returns how many rows it contained. */
export async function exportAccountData(kind: ExportKind): Promise<number> {
  const cfg = EXPORT_CONFIG[kind];
  const rows = await fetchAllRows(kind, cfg.orderBy);
  if (rows.length === 0) return 0;
  exportToCsv(rows, cfg.columns, cfg.filename);
  return rows.length;
}

// ============================================================
// FORMATTING / DATES
// ============================================================

export function formatLongDate(iso: string | null | undefined, fallback = 'the end of your billing period'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 86400000));
}

export function formatPrice(cents: number | null, currency: string): string | null {
  if (cents === null || cents === undefined) return null;
  try {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency });
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Same calendar-month math as the server (UTC, clamped), used for the "around" preview. */
export function previewResumeDate(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), lastDay)));
}
