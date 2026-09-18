import { supabase } from '@/lib/supabase';

/**
 * Event-Sourced Business Activity Ledger — dashboard client library.
 *
 * Rows in `business_activity_events` are append-only (see
 * supabase/migrations/20260928000000_business_activity_ledger.sql): most
 * of them are written automatically by database triggers the moment a
 * call, lead, job, quote, payment, or review changes state. This module
 * reads that feed and exposes `logActivityEvent` for the one thing that
 * has no dedicated trigger — logging a custom, hand-triggered moment
 * (a note, a manual override) against an aggregate.
 *
 * Every row belongs to one aggregate (aggregateType + aggregateId) and
 * carries an `aggregate_version` that is 1, 2, 3... for THAT aggregate —
 * fetchAggregateHistory() replays them in order to reconstruct exactly
 * what happened to one call/job/quote/etc. over its lifetime.
 */

export type AggregateType = 'call' | 'lead' | 'job' | 'quote' | 'payment' | 'review';

export type ActivityEventType =
  | 'call.created'
  | 'lead.created'
  | 'job.created'
  | 'job.completed'
  | 'quote.sent'
  | 'quote.accepted'
  | 'payment.received'
  | 'review.completed'
  | (string & {}); // custom events logged via logActivityEvent aren't restricted to the catalog above

export type ActorType = 'user' | 'system' | 'customer' | 'ai';

export interface ActivityEvent {
  id: number;
  user_id: string;
  aggregate_type: AggregateType | string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: ActivityEventType;
  event_data: Record<string, unknown>;
  actor_id: string | null;
  actor_type: ActorType;
  correlation_id: string | null;
  causation_id: number | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export const AGGREGATE_LABELS: Record<AggregateType, string> = {
  call: 'Call',
  lead: 'Lead',
  job: 'Job',
  quote: 'Quote',
  payment: 'Payment',
  review: 'Review',
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  'call.created': 'Call received',
  'lead.created': 'Lead created',
  'job.created': 'Job scheduled',
  'job.completed': 'Job completed',
  'quote.sent': 'Quote sent',
  'quote.accepted': 'Quote accepted',
  'payment.received': 'Payment received',
  'review.completed': 'Review submitted',
};

export function activityEventLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

/**
 * Paginated global activity feed, newest first. Pass the `id` of the
 * oldest row you already have as `before` to load the next page —
 * cheap keyset pagination on the primary key, which doubles as this
 * table's global ordering.
 */
export async function fetchActivityFeed(options?: {
  limit?: number;
  before?: number;
  aggregateType?: AggregateType;
}): Promise<ActivityEvent[]> {
  const { limit = 50, before, aggregateType } = options ?? {};

  let query = supabase.from('business_activity_events').select('*').order('id', { ascending: false }).limit(limit);

  if (before !== undefined) query = query.lt('id', before);
  if (aggregateType) query = query.eq('aggregate_type', aggregateType);

  const { data, error } = await query;
  if (error) throw error;
  return (data as ActivityEvent[]) ?? [];
}

/**
 * Full replay history for one aggregate (e.g. every event a single job
 * has ever produced), oldest first — reconstructs its lifecycle.
 */
export async function fetchAggregateHistory(
  aggregateType: AggregateType,
  aggregateId: string
): Promise<ActivityEvent[]> {
  const { data, error } = await supabase.rpc('get_aggregate_history', {
    p_aggregate_type: aggregateType,
    p_aggregate_id: aggregateId,
  });
  if (error) throw error;
  return (data as ActivityEvent[]) ?? [];
}

/**
 * Append a custom event to the ledger. Use this only for moments that
 * have no automatic trigger yet (see the migration for the covered
 * list) — anything already auto-logged should NOT also be logged by
 * hand, or the aggregate's history will double up.
 */
export async function logActivityEvent(params: {
  aggregateType: AggregateType | string;
  aggregateId: string;
  eventType: ActivityEventType;
  eventData?: Record<string, unknown>;
  actorType?: ActorType;
  correlationId?: string;
  causationId?: number;
  metadata?: Record<string, unknown>;
}): Promise<ActivityEvent> {
  const { data, error } = await supabase.rpc('append_activity_event', {
    p_aggregate_type: params.aggregateType,
    p_aggregate_id: params.aggregateId,
    p_event_type: params.eventType,
    p_event_data: params.eventData ?? {},
    p_actor_type: params.actorType ?? 'user',
    p_correlation_id: params.correlationId ?? null,
    p_causation_id: params.causationId ?? null,
    p_metadata: params.metadata ?? {},
  });
  if (error) throw error;
  return data as ActivityEvent;
}
