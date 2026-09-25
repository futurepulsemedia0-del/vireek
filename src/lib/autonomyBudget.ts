import { supabase } from '@/lib/supabase';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';
export type SessionStatus = 'running' | 'completed' | 'terminated_budget_exceeded';

export interface AutonomyBudget {
  id: string;
  agent_source: string;
  risk_level: RiskLevel;
  spend_limit_cents: number | null;
  spend_period: BudgetPeriod;
  max_actions: number | null;
  actions_period: BudgetPeriod;
  max_session_minutes: number | null;
  allowed_tools: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AutonomySession {
  id: string;
  budget_id: string;
  agent_source: string;
  started_at: string;
  ended_at: string | null;
  actions_taken: number;
  spend_cents: number;
  status: SessionStatus;
  termination_reason: string | null;
}

export const RISK_LABELS: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const RISK_COLOR: Record<RiskLevel, string> = {
  low: 'text-success-500', medium: 'text-text-secondary', high: 'text-warning-500', critical: 'text-error-500',
};

export async function fetchAutonomyBudgets(): Promise<AutonomyBudget[]> {
  const { data, error } = await supabase.from('agent_autonomy_budgets').select('*').order('agent_source');
  if (error) throw error;
  return (data as AutonomyBudget[]) ?? [];
}

export async function fetchAutonomySessions(limit = 30): Promise<AutonomySession[]> {
  const { data, error } = await supabase.from('agent_autonomy_sessions').select('*').order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as AutonomySession[]) ?? [];
}

export async function upsertAutonomyBudget(params: {
  agent_source: string;
  risk_level: RiskLevel;
  spend_limit_cents: number | null;
  spend_period: BudgetPeriod;
  max_actions: number | null;
  actions_period: BudgetPeriod;
  max_session_minutes: number | null;
  allowed_tools: string[];
  enabled: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('upsert_autonomy_budget', {
    p_agent_source: params.agent_source,
    p_risk_level: params.risk_level,
    p_spend_limit_cents: params.spend_limit_cents,
    p_spend_period: params.spend_period,
    p_max_actions: params.max_actions,
    p_actions_period: params.actions_period,
    p_max_session_minutes: params.max_session_minutes,
    p_allowed_tools: params.allowed_tools,
    p_enabled: params.enabled,
  });
  if (error) throw error;
}

export async function deleteAutonomyBudget(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_autonomy_budget', { p_id: id });
  if (error) throw error;
}
