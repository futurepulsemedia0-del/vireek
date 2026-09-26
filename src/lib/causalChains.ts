import { supabase } from '@/lib/supabase';

export interface CausalEdge {
  from_metric: string;
  to_metric: string;
  same_week_corr: number | null;
  next_week_corr: number | null;
}

export interface TopDriver extends CausalEdge {
  strength: number;
  leading: boolean;
}

export interface CausalWeekPoint {
  week_start: string;
  dispatch_delay: number | null;
  missed_call_rate: number | null;
  reschedule_rate: number | null;
  conversion_rate: number | null;
  cancellation_rate: number | null;
  revenue: number | null;
}

export interface CausalChainResult {
  weeks_analyzed: number;
  weeks_with_dispatch_data: number;
  confidence: 'low' | 'medium' | 'high';
  edges: CausalEdge[];
  top_driver: TopDriver | null;
  business_chain: CausalEdge[];
  weekly: CausalWeekPoint[];
}

export async function fetchCausalChainAnalysis(): Promise<CausalChainResult | null> {
  const { data, error } = await supabase.from('causal_chain_analyses').select('result').maybeSingle();
  if (error) throw error;
  return (data?.result as CausalChainResult) ?? null;
}

export async function computeCausalChainAnalysis(weeks = 26): Promise<CausalChainResult> {
  const { data, error } = await supabase.rpc('compute_causal_disruption_chains', { p_weeks: weeks });
  if (error) throw error;
  return data as CausalChainResult;
}
