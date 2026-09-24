/**
 * Missed-Revenue Recovery Ledger — client library.
 *
 * Every row here is created by a database trigger the moment a call goes
 * unbooked, a quote is declined/expires, or a job is cancelled (see
 * supabase/migrations/20260922000000_missed_revenue_recovery_ledger.sql).
 * This file only reads that ledger and calls the small set of RPCs that
 * move an entry through its lifecycle — it never computes a "missed
 * revenue" number of its own, so it can't drift from what the database
 * actually recorded.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type RecoverySourceType =
  | 'missed_call'
  | 'voicemail'
  | 'not_booked'
  | 'declined_quote'
  | 'expired_quote'
  | 'cancelled_job'
  | 'quote_financing_stalled'
  | 'quote_accepted_unbooked'
  | 'job_completed_unbilled'
  | 'invoice_overdue'
  | 'membership_cancelled'
  | 'membership_churned'
  | 'job_parts_unbilled'
  | 'payment_failed';
export type RecoveryStatus = 'open' | 'contacted' | 'recovered' | 'written_off';

export type RecoveryMethod = 'callback' | 'sms' | 'quote_resent' | 'rebooked' | 'manual' | 'other';

export type ValueBasis = 'quote_amount' | 'job_invoice' | 'price_book_match' | 'avg_job_value' | 'membership_plan' | 'manual' | 'none';

export interface RevenueRecoveryEvent {
  id: string;
  source_type: RecoverySourceType;
  source_table: 'calls' | 'quotes' | 'jobs' | 'payment_requests' | 'memberships';
  source_id: string;
  lead_id: string | null;
  call_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  occurred_at: string;
  estimated_value_cents: number;
  estimated_value_basis: ValueBasis;
  status: RecoveryStatus;
  recovery_method: RecoveryMethod | null;
  recovered_job_id: string | null;
  recovered_amount_cents: number | null;
  assigned_to: string | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  next_follow_up_at: string | null;
  notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// LABELS
// ============================================================

export const SOURCE_TYPE_LABELS: Record<RecoverySourceType, string> = {
  missed_call: 'Missed call',
  voicemail: 'Went to voicemail',
  not_booked: 'Answered, not booked',
  declined_quote: 'Quote declined',
  expired_quote: 'Quote expired',
  cancelled_job: 'Job cancelled',
  quote_financing_stalled: 'Quote stalled — offer financing',
  quote_accepted_unbooked: 'Accepted, not yet booked',
  job_completed_unbilled: 'Completed, not yet invoiced',
  invoice_overdue: 'Invoice overdue',
  membership_cancelled: 'Membership cancelled',
  membership_churned: 'Membership churned',
  job_parts_unbilled: 'Parts installed, not fully billed',
  payment_failed: 'Payment failed',
};

export const SOURCE_TYPE_COLORS: Record<RecoverySourceType, string> = {
  missed_call: 'bg-danger/10 text-danger',
  voicemail: 'bg-warning-500/10 text-warning-500',
  not_booked: 'bg-warning-500/10 text-warning-500',
  declined_quote: 'bg-danger/10 text-danger',
  expired_quote: 'bg-bg-tertiary text-text-secondary',
  cancelled_job: 'bg-danger/10 text-danger',
  quote_financing_stalled: 'bg-warning-500/10 text-warning-500',
  quote_accepted_unbooked: 'bg-warning-500/10 text-warning-500',
  job_completed_unbilled: 'bg-danger/10 text-danger',
  invoice_overdue: 'bg-danger/10 text-danger',
  membership_cancelled: 'bg-bg-tertiary text-text-secondary',
  membership_churned: 'bg-danger/10 text-danger',
  job_parts_unbilled: 'bg-warning-500/10 text-warning-500',
  payment_failed: 'bg-danger/10 text-danger',
};

export const STATUS_LABELS: Record<RecoveryStatus, string> = {
  open: 'Needs follow-up',
  contacted: 'Contacted',
  recovered: 'Recovered',
  written_off: 'Written off',
};

export const STATUS_COLORS: Record<RecoveryStatus, string> = {
  open: 'bg-danger/10 text-danger',
  contacted: 'bg-warning-500/10 text-warning-500',
  recovered: 'bg-success-500/10 text-success-500',
  written_off: 'bg-bg-tertiary text-text-secondary',
};

export const METHOD_LABELS: Record<RecoveryMethod, string> = {
  callback: 'Called back',
  sms: 'Texted',
  quote_resent: 'Quote resent',
  rebooked: 'Rebooked',
  manual: 'Recovered manually',
  other: 'Other',
};

export const VALUE_BASIS_LABELS: Record<ValueBasis, string> = {
  quote_amount: 'From the quote',
  job_invoice: 'From the invoice',
  price_book_match: 'Estimated from your price book',
  avg_job_value: 'Estimated from your average job value',
  manual: 'Entered manually',
  none: 'No estimate available',
};

// ============================================================
// FORMATTING
// ============================================================

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** True once an open entry has gone quiet long enough to need attention. */
export function isOverdue(event: RevenueRecoveryEvent): boolean {
  if (event.status !== 'open' && event.status !== 'contacted') return false;
  if (event.next_follow_up_at) return new Date(event.next_follow_up_at) <= new Date();
  const days = daysSince(event.occurred_at);
  return days !== null && days >= 1;
}

// ============================================================
// QUERIES
// ============================================================

export interface LedgerFilters {
  status?: RecoveryStatus | 'active' | 'all';
  sourceType?: RecoverySourceType | 'all';
  since?: Date;
}

export async function fetchLedger(filters: LedgerFilters = {}): Promise<RevenueRecoveryEvent[]> {
  let query = supabase.from('revenue_recovery_events').select('*').order('occurred_at', { ascending: false }).limit(300);

  if (filters.status === 'active') {
    query = query.in('status', ['open', 'contacted']);
  } else if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }
  if (filters.sourceType && filters.sourceType !== 'all') {
    query = query.eq('source_type', filters.sourceType);
  }
  if (filters.since) {
    query = query.gte('occurred_at', filters.since.toISOString());
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data as RevenueRecoveryEvent[]) ?? [];
}

export interface LedgerStats {
  openCount: number;
  openValueCents: number;
  overdueCount: number;
  recoveredThisMonthCents: number;
  recoveredThisMonthCount: number;
  writtenOffThisMonthCents: number;
  recoveryRatePercent: number | null;
}

export function computeStats(events: RevenueRecoveryEvent[]): LedgerStats {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const active = events.filter((e) => e.status === 'open' || e.status === 'contacted');
  const openValueCents = active.reduce((sum, e) => sum + e.estimated_value_cents, 0);
  const overdueCount = active.filter(isOverdue).length;

  const resolvedThisMonth = events.filter((e) => e.resolved_at && new Date(e.resolved_at) >= monthStart);
  const recoveredThisMonth = resolvedThisMonth.filter((e) => e.status === 'recovered');
  const writtenOffThisMonth = resolvedThisMonth.filter((e) => e.status === 'written_off');

  const recoveredThisMonthCents = recoveredThisMonth.reduce((sum, e) => sum + (e.recovered_amount_cents ?? 0), 0);
  const totalResolved = resolvedThisMonth.length;

  return {
    openCount: active.length,
    openValueCents,
    overdueCount,
    recoveredThisMonthCents,
    recoveredThisMonthCount: recoveredThisMonth.length,
    writtenOffThisMonthCents: writtenOffThisMonth.reduce((sum, e) => sum + e.estimated_value_cents, 0),
    recoveryRatePercent: totalResolved > 0 ? Math.round((recoveredThisMonth.length / totalResolved) * 100) : null,
  };
}

// ============================================================
// ACTIONS
// ============================================================

export async function logFollowUp(eventId: string, method: RecoveryMethod, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('log_recovery_follow_up', {
    p_event_id: eventId,
    p_method: method,
    p_note: note ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

export async function writeOff(eventId: string, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('write_off_revenue_recovery', {
    p_event_id: eventId,
    p_note: note ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

export async function markRecoveredManually(
  eventId: string,
  amountCents: number,
  method: RecoveryMethod = 'manual',
  note?: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('mark_revenue_recovered_manually', {
    p_event_id: eventId,
    p_amount_cents: amountCents,
    p_method: method,
    p_note: note ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

/** Runs the one-time historical sweep. Safe to call more than once. */
export async function backfillLedger(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('backfill_revenue_recovery_events', { p_user_id: userId });
  if (error) throw error;
  return (data as number) ?? 0;
}
