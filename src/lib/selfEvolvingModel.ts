import { supabase } from '@/lib/supabase';

export type PolicyDomain = 'pricing' | 'staffing' | 'marketing' | 'process' | 'sla';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type Confidence = 'low' | 'medium' | 'high';

export interface OperatingPolicy {
  id: string;
  domain: PolicyDomain;
  key: string;
  label: string;
  description: string | null;
  current_value: number;
  unit: string;
  guardrail_min: number;
  guardrail_max: number;
  step_pct: number;
  evolution_count: number;
  last_evolved_at: string | null;
  created_at: string;
}

export interface EvolutionCycle {
  id: string;
  started_at: string;
  completed_at: string | null;
  policies_reviewed: number;
  proposals_created: number;
  summary: string | null;
}

export interface EvolutionProposal {
  id: string;
  cycle_id: string;
  policy_id: string;
  current_value_snapshot: number;
  proposed_value: number;
  direction: 'increase' | 'decrease';
  confidence: Confidence;
  rationale: string;
  evidence: { sample_size: number; avg_observed: number; avg_target: number; deviation_pct: number; window_days: number };
  status: ProposalStatus;
  decision_reason: string | null;
  decided_at: string | null;
  created_at: string;
}

export const DOMAIN_LABELS: Record<PolicyDomain, string> = {
  pricing: 'Pricing',
  staffing: 'Staffing',
  marketing: 'Marketing',
  process: 'Process',
  sla: 'SLA',
};

export async function seedDefaultPolicies(): Promise<void> {
  const { error } = await supabase.rpc('seed_default_operating_policies');
  if (error) throw error;
}

export async function fetchPolicies(): Promise<OperatingPolicy[]> {
  const { data, error } = await supabase.from('operating_policies').select('*').order('domain').order('label');
  if (error) throw error;
  return (data as OperatingPolicy[]) ?? [];
}

export async function fetchCycles(limit = 10): Promise<EvolutionCycle[]> {
  const { data, error } = await supabase.from('evolution_cycles').select('*').order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as EvolutionCycle[]) ?? [];
}

export async function fetchProposals(status?: ProposalStatus): Promise<EvolutionProposal[]> {
  let query = supabase.from('evolution_proposals').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query.limit(100);
  if (error) throw error;
  return (data as EvolutionProposal[]) ?? [];
}

export async function logObservation(input: {
  policy_id: string;
  observed_metric: number;
  target_metric: number;
  sample_size: number;
  period_start: string;
  period_end: string;
}): Promise<void> {
  const { error } = await supabase.rpc('log_operating_observation', {
    p_policy_id: input.policy_id,
    p_observed_metric: input.observed_metric,
    p_target_metric: input.target_metric,
    p_sample_size: input.sample_size,
    p_period_start: input.period_start,
    p_period_end: input.period_end,
  });
  if (error) throw error;
}

export async function runEvolutionCycle(): Promise<{ cycle_id: string; policies_reviewed: number; proposals_created: number }> {
  const { data, error } = await supabase.rpc('run_evolution_cycle');
  if (error) throw error;
  return data as { cycle_id: string; policies_reviewed: number; proposals_created: number };
}

export async function decideProposal(id: string, decision: 'approved' | 'rejected', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('decide_evolution_proposal', { p_proposal_id: id, p_decision: decision, p_reason: reason ?? null });
  if (error) throw error;
}
