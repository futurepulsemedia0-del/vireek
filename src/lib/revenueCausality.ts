/**
 * Revenue Causality Graph — data access.
 * Server counterpart: supabase/migrations/20270210000000_revenue_causality_graph.sql
 * All maths lives in revenueCausalityModel.ts (pure + tested).
 */
import { supabase } from '@/lib/supabase';
import { normalizeRcgData, type RcgData } from '@/lib/revenueCausalityModel';

export async function fetchRevenueCausality(): Promise<RcgData | null> {
  const { data, error } = await supabase.from('revenue_causality_snapshots').select('result').maybeSingle();
  if (error) throw error;
  return normalizeRcgData(data?.result);
}

export async function computeRevenueCausality(days = 180): Promise<RcgData> {
  const { data, error } = await supabase.rpc('compute_revenue_causality_graph', { p_days: days });
  if (error) throw error;
  const normalized = normalizeRcgData(data);
  if (!normalized) throw new Error('Unexpected response from the causality engine.');
  return normalized;
}
