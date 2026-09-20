// Contractor Network — data access.
//
// Every mutation goes through a SECURITY DEFINER RPC (see migration
// 20261101000000_contractor_network_hub.sql); the tables are read-only for
// clients. Functions throw an Error whose message is the RPC's machine code —
// pass it to describeNetworkError() for user-facing copy.

import { supabase } from '@/lib/supabase';
import type {
  HandoffContact,
  NetworkHandoff,
  NetworkHubSummary,
  PostHandoffInput,
} from '@/lib/contractorNetwork';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface JobPrefill {
  customer_name: string | null;
  service_type: string | null;
  address: string | null;
}

export const networkApi = {
  summary: () => rpc<NetworkHubSummary>('get_network_hub_summary'),

  /** Marks stale open handoffs as expired (and notifies posters). Idempotent. */
  expire: () => rpc<number>('expire_network_handoffs'),

  setMembership: (enabled: boolean, contactPhone?: string) =>
    rpc<void>('set_network_membership', {
      p_enabled: enabled,
      p_contact_phone: contactPhone ?? null,
    }),

  post: (i: PostHandoffInput) =>
    rpc<string>('post_network_handoff', {
      p_kind: i.kind,
      p_trade: i.trade,
      p_title: i.title,
      p_summary: i.summary,
      p_location_label: i.locationLabel,
      p_needed_by: i.neededBy,
      p_estimated_value_cents: i.estimatedValueCents,
      p_referral_fee_pct: i.referralFeePct,
      p_customer_name: i.customerName,
      p_customer_phone: i.customerPhone,
      p_customer_address: i.customerAddress,
      p_notes: i.notes,
    }),

  claim: (id: string) => rpc<string>('claim_network_handoff', { p_id: id }),
  release: (id: string) => rpc<void>('release_network_handoff', { p_id: id }),
  complete: (id: string, finalAmountCents: number) =>
    rpc<void>('complete_network_handoff', { p_id: id, p_final_amount_cents: finalAmountCents }),
  cancel: (id: string) => rpc<void>('cancel_network_handoff', { p_id: id }),
  settleFee: (id: string, outcome: 'settled' | 'waived') =>
    rpc<void>('settle_network_handoff_fee', { p_id: id, p_outcome: outcome }),

  /** RLS returns: my posts, handoffs I claimed, and (members only) other members' open cards. */
  async listHandoffs(): Promise<NetworkHandoff[]> {
    const { data, error } = await supabase
      .from('network_handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as NetworkHandoff[];
  },

  /** RLS only ever returns rows the caller may see (own posts, or claimed-by-me after the claim). */
  async listContacts(handoffIds: string[]): Promise<HandoffContact[]> {
    if (handoffIds.length === 0) return [];
    const { data, error } = await supabase
      .from('network_handoff_contacts')
      .select('handoff_id, customer_name, customer_phone, customer_address, notes')
      .in('handoff_id', handoffIds);
    if (error) throw new Error(error.message);
    return (data ?? []) as HandoffContact[];
  },

  /** Lets any page deep-link "Hand off to network" with ?job=<id> to pre-fill the form. Best-effort. */
  async jobPrefill(jobId: string): Promise<JobPrefill | null> {
    const { data, error } = await supabase
      .from('jobs')
      .select('customer_name, service_type, address')
      .eq('id', jobId)
      .maybeSingle();
    if (error || !data) return null;
    return data as JobPrefill;
  },
};
