import { supabase } from '@/lib/supabase';
import { NEGATIVE_LEARNING, deriveRules, type NegativeEvent, type NegativeRule } from '@/lib/negativeKnowledge';

const DAY_MS = 86_400_000;

/** Append-only: every failure is stored once and never rewritten. */
export async function recordNegativeEvent(ownerId: string, event: NegativeEvent): Promise<void> {
  const { error } = await supabase.from('negative_events').insert({
    user_id: ownerId,
    action_kind: event.action_kind,
    subject_key: event.subject_key,
    outcome: event.outcome,
    context: event.context,
    recorded_at: event.recorded_at,
  });
  if (error) throw error;
}

export async function fetchActiveNegativeRules(ownerId: string): Promise<NegativeRule[]> {
  const { data, error } = await supabase
    .from('negative_rules')
    .select('id, facet, action_kind, subject_key, scope, severity, title, rationale, evidence, status')
    .eq('user_id', ownerId)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as NegativeRule[];
}

/**
 * Recomputes rules from stored events and reconciles them:
 *  - new or changed rules are upserted;
 *  - rules the owner dismissed stay dismissed;
 *  - rules the data no longer supports are removed.
 */
export async function refreshNegativeRules(ownerId: string): Promise<number> {
  const since = new Date(Date.now() - NEGATIVE_LEARNING.windowDays * DAY_MS).toISOString();

  const { data: events, error: readError } = await supabase
    .from('negative_events')
    .select('action_kind, subject_key, outcome, context, recorded_at')
    .eq('user_id', ownerId)
    .gte('recorded_at', since)
    .limit(5000);
  if (readError) throw readError;

  const drafts = deriveRules((events ?? []) as NegativeEvent[]);

  const { data: existing, error: existingError } = await supabase
    .from('negative_rules')
    .select('id, facet, status')
    .eq('user_id', ownerId);
  if (existingError) throw existingError;

  const current = (existing ?? []) as { id: string; facet: string; status: string }[];
  const dismissed = new Set(current.filter((r) => r.status === 'dismissed').map((r) => r.facet));
  const supported = new Set(drafts.map((d) => d.facet));
  const staleIds = current.filter((r) => !supported.has(r.facet)).map((r) => r.id);

  if (drafts.length > 0) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('negative_rules').upsert(
      drafts.map((d) => ({
        ...d,
        user_id: ownerId,
        status: dismissed.has(d.facet) ? 'dismissed' : 'active',
        updated_at: now,
      })),
      { onConflict: 'user_id,facet' },
    );
    if (error) throw error;
  }

  if (staleIds.length > 0) {
    const { error } = await supabase.from('negative_rules').delete().in('id', staleIds);
    if (error) throw error;
  }

  return drafts.length;
}

export async function dismissNegativeRule(id: string): Promise<void> {
  const { error } = await supabase
    .from('negative_rules')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
