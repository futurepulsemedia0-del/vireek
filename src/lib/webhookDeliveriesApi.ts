/**
 * Webhook delivery console — API layer. Reads are scoped to the account owner (RLS enforces it again);
 * replay goes through the existing replay_webhook_delivery RPC, which re-checks owner/admin rights server-side
 * and writes an append-only audit row (webhook_replay_audit).
 */
import { supabase } from '@/lib/supabase';
import { DELIVERY_COLUMNS, toDeliveries, type Delivery } from '@/lib/webhookDeliveries';

export const DELIVERY_PAGE_SIZE = 100;

export async function fetchDeliveries(ownerId: string): Promise<Delivery[]> {
  const { data, error } = await supabase
    .from('webhook_outbox')
    .select(DELIVERY_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(DELIVERY_PAGE_SIZE);
  if (error) throw error;
  return toDeliveries(data);
}

export async function replayDelivery(outboxId: string): Promise<void> {
  const { error } = await supabase.rpc('replay_webhook_delivery', { p_outbox_id: outboxId });
  if (error) throw error;
}
