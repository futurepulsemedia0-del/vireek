import { supabase } from '@/lib/supabase';

export type KpiCategory = 'revenue' | 'retention' | 'cost';
export type Unit = 'dollars' | 'percentage_points';
export type Confidence = 'low' | 'medium' | 'high';

export interface PendingAiActionEvent {
  id: string;
  source: 'next_best_action' | 'workflow_run';
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  occurred_at: string;
}

export interface CausalRoiSummaryRow {
  kpi_category: KpiCategory;
  unit: Unit;
  causal_total: number;
  correlation_total: number;
  analyzed_count: number;
  high_confidence_count: number;
}

export interface CausalRoiByActionTypeRow {
  action_type: string;
  kpi_category: KpiCategory;
  unit: Unit;
  avg_causal_estimate: number;
  avg_correlation_estimate: number;
  analyzed_count: number;
}

export interface CausalRoiAttribution {
  id: string;
  action_event_id: string;
  kpi_category: KpiCategory;
  unit: Unit;
  correlation_estimate: number;
  causal_estimate: number;
  matched_sample_size: number;
  unmatched_sample_size: number;
  confidence: Confidence;
  method: string;
  covariates_used: string[];
  job_id: string | null;
  created_at: string;
}

export async function fetchPendingAiActionEvents(limit = 20): Promise<PendingAiActionEvent[]> {
  const { data, error } = await supabase.rpc('find_unanalyzed_ai_action_events', { p_limit: limit });
  if (error) throw error;
  return (data as PendingAiActionEvent[]) ?? [];
}

export async function computeCausalRoiAttribution(eventId: string): Promise<void> {
  const { error } = await supabase.rpc('compute_causal_roi_attribution', { p_event_id: eventId });
  if (error) throw error;
}

export async function fetchCausalRoiSummary(): Promise<CausalRoiSummaryRow[]> {
  const { data, error } = await supabase.rpc('get_causal_roi_summary');
  if (error) throw error;
  return (data as CausalRoiSummaryRow[]) ?? [];
}

export async function fetchCausalRoiByActionType(): Promise<CausalRoiByActionTypeRow[]> {
  const { data, error } = await supabase.rpc('get_causal_roi_by_action_type');
  if (error) throw error;
  return (data as CausalRoiByActionTypeRow[]) ?? [];
}

export async function fetchRecentAttributions(limit = 30): Promise<CausalRoiAttribution[]> {
  const { data, error } = await supabase
    .from('causal_roi_attributions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as CausalRoiAttribution[]) ?? [];
}
