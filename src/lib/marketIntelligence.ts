import { supabase } from '@/lib/supabase';

export type SignalType = 'trend' | 'opportunity' | 'risk' | 'demand_shift';
export type SignalDomain = 'demand' | 'weather' | 'competitive' | 'marketing' | 'financial';
export type SignalStatus = 'active' | 'acknowledged' | 'dismissed' | 'expired';

export interface MarketSignal {
  id: string;
  signal_type: SignalType;
  domain: SignalDomain;
  title: string;
  narrative: string;
  confidence_score: number;
  estimated_impact_cents: number | null;
  source_refs: Record<string, unknown>;
  status: SignalStatus;
  expires_at: string | null;
  created_at: string;
}

export async function fetchMarketSignals(status?: SignalStatus): Promise<MarketSignal[]> {
  let query = supabase.from('market_intelligence_signals').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data as MarketSignal[]) ?? [];
}

export async function acknowledgeSignal(id: string): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_market_signal', { p_id: id });
  if (error) throw error;
}

export async function dismissSignal(id: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('dismiss_market_signal', { p_id: id, p_reason: reason ?? null });
  if (error) throw error;
}

export async function promoteToDecision(id: string): Promise<void> {
  const { error } = await supabase.rpc('promote_signal_to_decision', { p_id: id });
  if (error) throw error;
}
