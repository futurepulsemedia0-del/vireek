import { supabase } from '@/lib/supabase';

export type ShockType = 'technician_unavailable' | 'payment_outage' | 'demand_surge' | 'supply_shortage' | 'other';
export type Severity = 'low' | 'moderate' | 'high' | 'severe';
export type CascadeDomain = 'jobs' | 'crew' | 'customer' | 'sla' | 'cash' | 'reputation';

export interface CascadeStep {
  order: number;
  domain: CascadeDomain;
  headline: string;
  detail: string;
}
export interface ResponsePlanStep {
  step: string;
  owner: 'dispatcher' | 'owner' | 'technician' | 'customer_service' | 'finance';
  urgency: 'immediate' | 'today' | 'this_week';
}

export interface CausalShockSimulation {
  id: string;
  question: string;
  shock_type: ShockType;
  shock_params: Record<string, unknown>;
  impact: {
    customer: { jobs_at_risk: number; vip_customers_at_risk: number };
    sla: { jobs_likely_delayed: number; avg_delay_hours: number };
    cash: { revenue_at_risk_usd: number; revenue_at_risk_pct_of_30d: number | null };
    jobs: { jobs_in_window: number; jobs_affected: number; window_hours: number };
    crew: { active_technicians: number; technicians_unavailable: number; capacity_loss_pct: number };
    reputation: { vip_jobs_affected: number; total_customers_tracked: number };
  };
  severity: Severity;
  cascade: CascadeStep[];
  response_plan: ResponsePlanStep[];
  summary: string | null;
  created_at: string;
}

export const SHOCK_TYPE_LABELS: Record<ShockType, string> = {
  technician_unavailable: 'Technician unavailability',
  payment_outage: 'Payment provider outage',
  demand_surge: 'Demand surge',
  supply_shortage: 'Supply / parts shortage',
  other: 'Other scenario',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  low: 'bg-success-500/10 text-success-500',
  moderate: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  severe: 'bg-danger/20 text-danger',
};

export const DOMAIN_LABELS: Record<CascadeDomain, string> = {
  jobs: 'Jobs',
  crew: 'Crew',
  customer: 'Customer',
  sla: 'SLA',
  cash: 'Cash',
  reputation: 'Reputation',
};

export async function runCausalShockSimulation(question: string): Promise<CausalShockSimulation> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('causal-shock-simulator', {
    body: { question },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  if (!data?.simulation) throw new Error('No simulation returned');
  return data.simulation as CausalShockSimulation;
}

export async function fetchCausalShockHistory(): Promise<CausalShockSimulation[]> {
  const { data, error } = await supabase
    .from('causal_shock_simulations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as CausalShockSimulation[];
}

export async function deleteCausalShockSimulation(id: string): Promise<void> {
  const { error } = await supabase.from('causal_shock_simulations').delete().eq('id', id);
  if (error) throw error;
}
