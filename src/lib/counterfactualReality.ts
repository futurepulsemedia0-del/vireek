import { supabase } from '@/lib/supabase';

export type RealityDecisionCategory = 'pricing' | 'marketing' | 'staffing' | 'service_area' | 'process' | 'other';
export type RealityMetric = 'revenue' | 'leads' | 'bookings' | 'jobs_completed' | 'avg_ticket';

export interface RealityWeekPoint {
  week_start: string;
  actual: number;
  counterfactual: number;
}

export interface RealityPathResult {
  metric: RealityMetric;
  decision_week: string;
  pre_weeks_used: number;
  post_weeks_used: number;
  slope: number;
  r_squared: number;
  cumulative_actual: number;
  cumulative_counterfactual: number;
  cumulative_impact: number;
  confidence: 'low' | 'medium' | 'high';
  weekly: RealityWeekPoint[];
}

export interface RealityDecision {
  id: string;
  title: string;
  category: RealityDecisionCategory;
  decision_date: string;
  metric: RealityMetric;
  description: string | null;
  last_result: RealityPathResult | null;
  last_computed_at: string | null;
  created_at: string;
}

export async function fetchRealityDecisions(): Promise<RealityDecision[]> {
  const { data, error } = await supabase
    .from('business_reality_decisions')
    .select('*')
    .order('decision_date', { ascending: false });
  if (error) throw error;
  return (data as RealityDecision[]) ?? [];
}

export async function createRealityDecision(input: {
  title: string;
  category: RealityDecisionCategory;
  decision_date: string;
  metric: RealityMetric;
  description?: string;
}): Promise<RealityDecision> {
  const { data, error } = await supabase.from('business_reality_decisions').insert(input).select().single();
  if (error) throw error;
  return data as RealityDecision;
}

export async function deleteRealityDecision(id: string): Promise<void> {
  const { error } = await supabase.from('business_reality_decisions').delete().eq('id', id);
  if (error) throw error;
}

export async function computeRealityPath(decisionId: string, preWeeks = 8, postWeeks = 8): Promise<RealityPathResult> {
  const { data, error } = await supabase.rpc('compute_counterfactual_reality_path', {
    p_decision_id: decisionId,
    p_pre_weeks: preWeeks,
    p_post_weeks: postWeeks,
  });
  if (error) throw error;
  return data as RealityPathResult;
}
