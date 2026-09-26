import { supabase } from '@/lib/supabase';

export type DecisionType =
  | 'hire_technicians'
  | 'raise_prices'
  | 'add_service_line'
  | 'extend_hours_24_7'
  | 'increase_marketing_spend'
  | 'reduce_response_time';

export interface Metrics {
  revenue_monthly_usd: number;
  margin_pct: number | null;
  sla_on_time_pct: number | null;
  capacity_load_pct: number | null;
  active_technicians: number;
  avg_job_value_usd: number;
  jobs_per_month: number;
}

export interface CausalFactor {
  factor: string;
  direction: 'positive' | 'negative' | 'uncertain';
  explanation: string;
}

export interface CausalWorldSimulation {
  id: string;
  decision_type: DecisionType;
  decision_label: string;
  decision_params: Record<string, number>;
  baseline: Metrics;
  projected: Metrics;
  predicted_impact_pct: number;
  predicted_confidence: number;
  timeframe_days: number;
  causal_factors: CausalFactor[];
  risk_factors: string[];
  counterfactual_narrative: string;
  created_at: string;
}

export interface DecisionParamField {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  suffix: string;
}

export interface DecisionLeverConfig {
  type: DecisionType;
  label: string;
  description: string;
  fields: DecisionParamField[];
}

export const DECISION_LEVERS: DecisionLeverConfig[] = [
  {
    type: 'hire_technicians',
    label: 'Hire more technicians',
    description: 'Add headcount and see the effect on capacity, revenue, and margin.',
    fields: [{ key: 'count', label: 'Technicians to add', min: 1, max: 10, step: 1, default: 2, suffix: '' }],
  },
  {
    type: 'raise_prices',
    label: 'Raise prices',
    description: 'Model a price increase against expected volume loss.',
    fields: [{ key: 'pct', label: 'Price increase', min: 1, max: 50, step: 1, default: 10, suffix: '%' }],
  },
  {
    type: 'add_service_line',
    label: 'Add a new service line',
    description: 'Estimate the impact of launching a new offering.',
    fields: [{ key: 'extra_jobs_per_month', label: 'Extra jobs / month', min: 5, max: 200, step: 5, default: 15, suffix: ' jobs' }],
  },
  {
    type: 'extend_hours_24_7',
    label: 'Extend to 24/7 coverage',
    description: 'Capture more after-hours calls that currently go to voicemail.',
    fields: [{ key: 'extra_call_capture_pct', label: 'Extra after-hours calls captured', min: 5, max: 100, step: 5, default: 25, suffix: '%' }],
  },
  {
    type: 'increase_marketing_spend',
    label: 'Increase marketing spend',
    description: 'Model demand lift from a bigger marketing budget (diminishing returns).',
    fields: [{ key: 'spend_increase_pct', label: 'Spend increase', min: 10, max: 300, step: 10, default: 50, suffix: '%' }],
  },
  {
    type: 'reduce_response_time',
    label: 'Reduce average response time',
    description: 'See the close-rate and SLA effect of answering faster.',
    fields: [{ key: 'target_minutes', label: 'Target response time', min: 1, max: 60, step: 1, default: 10, suffix: ' min' }],
  },
];

export const METRIC_LABELS: Record<keyof Metrics, string> = {
  revenue_monthly_usd: 'Monthly Revenue',
  margin_pct: 'Gross Margin',
  sla_on_time_pct: 'On-Time / SLA',
  capacity_load_pct: 'Capacity Load',
  active_technicians: 'Active Technicians',
  avg_job_value_usd: 'Avg Job Value',
  jobs_per_month: 'Jobs / Month',
};

export async function runCausalWorldSimulation(
  decisionType: DecisionType,
  params: Record<string, number>
): Promise<CausalWorldSimulation> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('causal-world-simulator', {
    body: { decision_type: decisionType, params },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  if (!data?.simulation) throw new Error('No simulation returned');
  return data.simulation as CausalWorldSimulation;
}

export async function fetchCausalWorldHistory(): Promise<CausalWorldSimulation[]> {
  const { data, error } = await supabase
    .from('causal_world_simulations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as CausalWorldSimulation[];
}

export async function deleteCausalWorldSimulation(id: string): Promise<void> {
  const { error } = await supabase.from('causal_world_simulations').delete().eq('id', id);
  if (error) throw error;
}
