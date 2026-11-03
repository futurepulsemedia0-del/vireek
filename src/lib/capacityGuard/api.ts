import { supabase } from '@/lib/supabase';

export interface TradeRule { trade: string; hold_share_pct: number }
export interface GuardSettings {
  user_id: string; enabled: boolean; mode: 'shadow' | 'live'; hold_share_pct: number; hold_horizon_days: number; min_release_probability: number;
  trade_rules: TradeRule[]; campaign_holds_enabled: boolean; campaign_max_hold_share_pct: number; campaign_default_response_rate: number;
  campaign_release_grace_hours: number; backfill_enabled: boolean; backfill_offer_ttl_minutes: number; backfill_batch_size: number;
  backfill_min_lead_minutes: number; backfill_max_offers_per_customer_7d: number; backfill_max_offers_per_customer_24h: number;
}
export type GuardSettingsPatch = Partial<Omit<GuardSettings, 'user_id'>>;

export interface HoldRow { id: string; kind: 'value' | 'campaign'; technician_id: string; trade: string | null; slot_start: string; slot_end: string; status: 'active' | 'released' | 'consumed'; shadow: boolean; release_reason: string | null }
export interface GapRow {
  id: string; source_reason: 'cancelled' | 'no_show'; service_type: string | null; slot_start: string; duration_minutes: number; est_value_cents: number;
  status: 'open' | 'offered' | 'filled' | 'expired' | 'abandoned'; recovered_estimate_cents: number | null; realized_cents: number | null; created_at: string; filled_at: string | null;
}
export interface OfferRow { id: string; gap_id: string; candidate_type: string; customer_name: string; status: string; blocked_reason: string | null; rank: number; sent_at: string | null; expires_at: string | null }

export async function fetchSettings(): Promise<GuardSettings> {
  const { data, error } = await supabase.rpc('get_capacity_guard_settings');
  if (error) throw error;
  return data as GuardSettings;
}
export async function saveSettings(patch: GuardSettingsPatch): Promise<GuardSettings> {
  const { data, error } = await supabase.rpc('update_capacity_guard_settings', { p: patch });
  if (error) throw error;
  return data as GuardSettings;
}

export async function fetchHolds(fromIso: string, toIso: string): Promise<HoldRow[]> {
  const { data, error } = await supabase.from('capacity_holds')
    .select('id, kind, technician_id, trade, slot_start, slot_end, status, shadow, release_reason')
    .gte('slot_start', fromIso).lt('slot_start', toIso).order('slot_start').limit(2000);
  if (error) throw error;
  return (data ?? []) as HoldRow[];
}
export async function fetchGaps(sinceIso: string): Promise<GapRow[]> {
  const { data, error } = await supabase.from('backfill_gaps')
    .select('id, source_reason, service_type, slot_start, duration_minutes, est_value_cents, status, recovered_estimate_cents, realized_cents, created_at, filled_at')
    .gte('created_at', sinceIso).order('slot_start', { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as GapRow[];
}
/** token_hash is column-revoked: always list columns explicitly (select('*') is denied). */
export async function fetchOffers(gapIds: string[]): Promise<OfferRow[]> {
  if (gapIds.length === 0) return [];
  const { data, error } = await supabase.from('backfill_offers')
    .select('id, gap_id, candidate_type, customer_name, status, blocked_reason, rank, sent_at, expires_at').in('gap_id', gapIds).order('rank').limit(2000);
  if (error) throw error;
  return (data ?? []) as OfferRow[];
}

export interface ReservationResult { status: 'applied' | 'already_applied' | 'disabled'; reservation_id?: string; holds_placed?: number; applied_by?: string; applied_at?: string; shadow?: boolean }
export async function applyCampaignReservation(a: {
  sourceType: 'marketing' | 'direct_mail' | 'ads'; sourceId: string; expectedResponses: number; curveSource: 'history' | 'default'; curveShares: number[];
  windowStart: string; windowEnd: string; holds: { technician_id: string; slot_start: string; slot_end: string; trade?: string }[];
}): Promise<ReservationResult> {
  const { data, error } = await supabase.rpc('apply_campaign_reservation', {
    p_source_type: a.sourceType, p_source_id: a.sourceId, p_expected_responses: a.expectedResponses, p_curve_source: a.curveSource,
    p_window_start: a.windowStart, p_window_end: a.windowEnd, p_holds: a.holds, p_curve_shares: a.curveShares,
  });
  if (error) throw error;
  return data as ReservationResult;
}

// -------- public claim (no auth) --------
export type ClaimPreview = { status: 'available' | 'claimed' | 'already_filled' | 'expired' | 'invalid'; slot_label?: string; service_type?: string | null; expires_at?: string };
export type ClaimResult = { status: 'claimed' | 'already_filled' | 'expired' | 'unavailable' | 'invalid' | 'error'; slot_label?: string };
async function callClaim<T>(action: 'preview' | 'claim', token: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('backfill-claim', { body: { action, token } });
  if (error) throw error;
  return data as T;
}
export const previewClaim = (token: string) => callClaim<ClaimPreview>('preview', token);
export const submitClaim = (token: string) => callClaim<ClaimResult>('claim', token);
