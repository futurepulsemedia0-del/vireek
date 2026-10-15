/**
 * VIREEK Physical Economy Network - data access.
 *
 * Every write is a SECURITY DEFINER RPC (see the migration); the browser has read-only access to
 * its own rows through RLS. Errors raised by the database are plain-English and safe to show.
 */

import { supabase } from '@/lib/supabase';
import {
  PEN_TERMS_VERSION,
  type PenEngagement,
  type PenEvent,
  type PenIdentifier,
  type PenLedgerEntry,
  type PenMyRequest,
  type PenNode,
  type PenOffer,
  type PenOpenRequest,
  type PenOverview,
  type PenTrade,
  type PenUrgency,
} from '@/lib/physicalEconomyNetwork';

export function penErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const m = (e as { message: string }).message;
    if (m) return m;
  }
  return fallback;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------- reads

export const fetchOverview = () => rpc<PenOverview>('pen_get_overview');

export async function fetchTrades(): Promise<PenTrade[]> {
  const { data, error } = await supabase
    .from('pen_trades')
    .select('trade_key, label, description, sort_order, protocol_version, categories, required_evidence, outcome_metrics')
    .eq('active', true)
    .order('sort_order');
  if (error) throw error;
  return (data as PenTrade[]) ?? [];
}

export async function fetchIdentifiers(): Promise<PenIdentifier[]> {
  const { data, error } = await supabase
    .from('pen_identifiers')
    .select('network_id, entity_kind, entity_id, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as PenIdentifier[]) ?? [];
}

export async function fetchLedger(limit = 100): Promise<PenLedgerEntry[]> {
  const { data, error } = await supabase
    .from('pen_ledger_entries')
    .select('id, group_id, engagement_id, kind, account, direction, amount_cents, currency, memo, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as PenLedgerEntry[]) ?? [];
}

export async function fetchEvents(limit = 30): Promise<PenEvent[]> {
  const { data, error } = await supabase
    .from('pen_events')
    .select('id, kind, entity_id, meta, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as PenEvent[]) ?? [];
}

export interface PenMyOffer {
  id: string;
  request_id: string;
  price_cents: number;
  currency: string;
  eta_hours: number;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
}

/** The provider's own offers (readable through RLS), so an offer can be revised or withdrawn. */
export async function fetchMyOffers(): Promise<PenMyOffer[]> {
  const { data, error } = await supabase
    .from('pen_offers')
    .select('id, request_id, price_cents, currency, eta_hours, message, status')
    .in('status', ['pending', 'withdrawn'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as PenMyOffer[]) ?? [];
}

export const fetchOpenRequests = () => rpc<PenOpenRequest[]>('pen_list_open_requests', { p_limit: 50 });
export const fetchMyRequests = () => rpc<PenMyRequest[]>('pen_list_my_requests');
export const fetchOffers = (requestId: string) => rpc<PenOffer[]>('pen_list_offers', { p_request_id: requestId });
export const fetchEngagements = () => rpc<PenEngagement[]>('pen_list_engagements');
export const fetchLedgerIntegrity = () =>
  rpc<{ groups: number; unbalanced: number; balanced: boolean }>('pen_ledger_integrity');

// ---------------------------------------------------------------- writes

export interface JoinInput {
  trades: string[];
  regions: string[];
  acceptsReferrals: boolean;
  feeBps: number;
}

export const joinNetwork = (i: JoinInput) =>
  rpc<PenNode>('pen_join_network', {
    p_trades: i.trades,
    p_regions: i.regions,
    p_accepts_referrals: i.acceptsReferrals,
    p_fee_bps: i.feeBps,
    p_consent_version: PEN_TERMS_VERSION,
  });

export const setNodeStatus = (status: 'active' | 'paused') => rpc<void>('pen_set_node_status', { p_status: status });

export const syncIdentifiers = () =>
  rpc<{ business: number; technicians: number; sites: number }>('pen_sync_identifiers');

export interface CreateRequestInput {
  trade: string;
  category: string;
  urgency: PenUrgency;
  region: string;
  summary: string;
  payload?: Record<string, unknown>;
  budgetCents: number | null;
  currency: string;
  jobId?: string | null;
  expiresHours: number;
}

export const createRequest = (i: CreateRequestInput) =>
  rpc<string>('pen_create_request', {
    p_trade: i.trade,
    p_category: i.category,
    p_urgency: i.urgency,
    p_region: i.region.trim().toUpperCase(),
    p_summary: i.summary.trim(),
    p_payload: i.payload ?? {},
    p_budget_cents: i.budgetCents,
    p_currency: i.currency,
    p_job_id: i.jobId ?? null,
    p_expires_hours: i.expiresHours,
  });

export const cancelRequest = (id: string) => rpc<void>('pen_cancel_request', { p_request_id: id });

export const submitOffer = (requestId: string, priceCents: number, etaHours: number, message: string) =>
  rpc<string>('pen_submit_offer', {
    p_request_id: requestId,
    p_price_cents: priceCents,
    p_eta_hours: etaHours,
    p_message: message.trim() || null,
  });

export const withdrawOffer = (offerId: string) => rpc<void>('pen_withdraw_offer', { p_offer_id: offerId });
export const acceptOffer = (offerId: string) => rpc<string>('pen_accept_offer', { p_offer_id: offerId });
export const cancelEngagement = (id: string) => rpc<void>('pen_cancel_engagement', { p_engagement_id: id });

export interface OutcomeInput {
  engagementId: string;
  resolved: boolean;
  rework: boolean;
  satisfaction: number | null;
  notes: string;
  evidenceSha256: string | null;
}

export const recordOutcome = (i: OutcomeInput) =>
  rpc<{ role: string; disputed: boolean }>('pen_record_outcome', {
    p_engagement_id: i.engagementId,
    p_resolved: i.resolved,
    p_rework: i.rework,
    p_satisfaction: i.satisfaction,
    p_notes: i.notes.trim() || null,
    p_evidence_sha256: i.evidenceSha256,
  });

export const settleEngagement = (id: string, reference: string) =>
  rpc<void>('pen_settle_engagement', { p_engagement_id: id, p_reference: reference.trim() });
