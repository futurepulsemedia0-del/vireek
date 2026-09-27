// Contractor Network — data access.
//
// Every mutation goes through a SECURITY DEFINER RPC (see migration
// 20261101000000_contractor_network_hub.sql); the tables are read-only for
// clients. Functions throw an Error whose message is the RPC's machine code —
// pass it to describeNetworkError() for user-facing copy.

import { supabase } from '@/lib/supabase';
import type {
  CapacityExchangeSummary,
  HandoffContact,
  HandoffMatch,
  MatchPipeline,
  NetworkHandoff,
  NetworkHubSummary,
  PostHandoffInput,
  SetCapacityProfileInput,
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
      p_smart_match: i.smartMatch ?? false,
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


// ---------------------------------------------------------------------------
// Capacity Exchange — data access
// ---------------------------------------------------------------------------

export const capacityApi = {
  summary: () => rpc<CapacityExchangeSummary>('get_capacity_exchange_summary'),
  advanceExpired: () => rpc<number>('advance_expired_matches'),

  setProfile: (i: SetCapacityProfileInput) =>
    rpc<void>('set_capacity_profile', {
      p_certified_trades: i.certifiedTrades,
      p_weekly_capacity_hours: i.weeklyCapacityHours,
      p_max_concurrent_handoffs: i.maxConcurrentHandoffs,
      p_auto_match_enabled: i.autoMatchEnabled,
    }),

  computeMatches: (handoffId: string) =>
    rpc<number>('compute_handoff_matches', { p_handoff_id: handoffId }),

  respond: (matchId: string, accept: boolean) =>
    rpc<string | null>('respond_to_match', { p_match_id: matchId, p_accept: accept }),

  rate: (handoffId: string, rating: number, notes: string) =>
    rpc<void>('rate_handoff', { p_handoff_id: handoffId, p_rating: rating, p_notes: notes }),

  pipeline: (handoffId: string) =>
    rpc<MatchPipeline>('get_handoff_match_pipeline', { p_handoff_id: handoffId }),

  /** RLS returns only match rows where candidate_id = me. */
  async listMyMatches(): Promise<HandoffMatch[]> {
    const { data, error } = await supabase
      .from('network_handoff_matches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as HandoffMatch[];
  },

  /** Handoff ids I (as poster) have already rated — RLS returns only my own ratings. */
  async listMyRatingsGiven(): Promise<Set<string>> {
    const { data, error } = await supabase.from('network_handoff_ratings').select('handoff_id');
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r) => r.handoff_id as string));
  },
};
