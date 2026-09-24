/**
 * Customer Trust Bank — client domain logic.
 *
 * customers.trust_score is a running BALANCE maintained entirely by
 * database triggers (see 20261202000000_customer_trust_bank.sql) — this
 * file never computes a score itself. Manual events go through the
 * log_customer_trust_event RPC, which looks up the point delta server-side,
 * so a client can never post an arbitrary value.
 */

import { supabase } from '@/lib/supabase';

export type ManualTrustEventType =
  | 'on_time_arrival' | 'late_arrival'
  | 'price_transparency' | 'price_change_surprise'
  | 'fast_issue_resolution' | 'slow_issue_resolution'
  | 'went_above_and_beyond';

export type TrustEventType = ManualTrustEventType
  | 'promise_kept' | 'promise_broken' | 'quality_rework' | 'job_cancelled'
  | 'repeat_contact' | 'negative_call_sentiment';

export interface TrustEvent {
  id: string;
  customer_id: string;
  event_type: TrustEventType;
  delta: number;
  reason: string | null;
  source: 'auto' | 'manual';
  created_at: string;
}

export interface CustomerTrustSummary {
  id: string;
  name: string;
  phone: string | null;
  trust_score: number;
}

export interface TrustErosionAlert {
  customer_id: string;
  customer_name: string;
  trust_score: number;
  recent_30d_delta: number;
  event_count_30d: number;
  top_reason: string | null;
  headline: string;
  intervention: string;
}

export const MANUAL_EVENT_META: Record<ManualTrustEventType, { label: string; delta: number }> = {
  on_time_arrival: { label: 'Arrived on time', delta: 5 },
  late_arrival: { label: 'Arrived late', delta: -10 },
  price_transparency: { label: 'Gave clear, upfront pricing', delta: 6 },
  price_change_surprise: { label: 'Price changed on them', delta: -15 },
  fast_issue_resolution: { label: 'Resolved an issue quickly', delta: 12 },
  slow_issue_resolution: { label: 'Slow to resolve an issue', delta: -8 },
  went_above_and_beyond: { label: 'Went above and beyond', delta: 15 },
};

export const EVENT_LABELS: Record<TrustEventType, string> = {
  ...Object.fromEntries(Object.entries(MANUAL_EVENT_META).map(([k, v]) => [k, v.label])),
  promise_kept: 'Promise kept',
  promise_broken: 'Promise broken',
  quality_rework: 'Had to redo the work',
  job_cancelled: 'Job cancelled',
  repeat_contact: 'Called in repeatedly',
  negative_call_sentiment: 'A recent call went badly',
} as Record<TrustEventType, string>;

export function trustTier(score: number): { label: string; className: string } {
  if (score >= 85) return { label: 'High trust', className: 'bg-success-500/10 text-success-500' };
  if (score >= 60) return { label: 'Stable', className: 'bg-accent/10 text-accent' };
  if (score >= 40) return { label: 'Watch', className: 'bg-warning-500/10 text-warning-500' };
  return { label: 'At risk', className: 'bg-danger-500/10 text-danger-500' };
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch { /* fall through */ }
  }
  return fallback;
}

/** Customers ordered lowest trust first — the ones worth checking on. */
export async function fetchCustomersByTrust(limit = 100): Promise<CustomerTrustSummary[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, trust_score')
    .order('trust_score', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as CustomerTrustSummary[]) ?? [];
}

/** Recent ledger entries for one customer, newest first. */
export async function fetchTrustEvents(customerId: string, limit = 20): Promise<TrustEvent[]> {
  const { data, error } = await supabase
    .from('customer_trust_events')
    .select('id, customer_id, event_type, delta, reason, source, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as TrustEvent[]) ?? [];
}

/** Logs a MANUAL event; the point delta is looked up server-side, never sent from here. */
export async function logTrustEvent(customerId: string, eventType: ManualTrustEventType, note?: string): Promise<TrustEvent> {
  const { data, error } = await supabase.rpc('log_customer_trust_event', {
    p_customer_id: customerId,
    p_event_type: eventType,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as TrustEvent;
}

/** Customers whose trust eroded meaningfully in the last 30 days, with a suggested intervention. */
export async function fetchTrustErosionAlerts(): Promise<TrustErosionAlert[]> {
  const { data, error } = await supabase.functions.invoke('trust-bank-alerts', { body: {} });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not load trust erosion alerts.'));
  if (data?.error) throw new Error(String(data.error));
  return (data?.alerts as TrustErosionAlert[]) ?? [];
}
