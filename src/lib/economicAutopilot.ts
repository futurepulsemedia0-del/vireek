import { supabase } from '@/lib/supabase';

export type SignalType =
  | 'revenue_cents' | 'cost_cents' | 'margin_pct' | 'capacity_utilization_pct'
  | 'cash_runway_days' | 'overdue_receivables_cents' | 'discretionary_spend_cents';

export type ActionCategory = 'pricing' | 'capacity' | 'spend' | 'collections' | 'margin';
export type Urgency = 'low' | 'medium' | 'high';
export type ActionStatus = 'pending' | 'approved' | 'dismissed' | 'implemented';

export const SIGNAL_LABELS: Record<SignalType, string> = {
  revenue_cents: 'Revenue (cents)',
  cost_cents: 'Cost (cents)',
  margin_pct: 'Margin (%)',
  capacity_utilization_pct: 'Capacity utilization (%)',
  cash_runway_days: 'Cash runway (days)',
  overdue_receivables_cents: 'Overdue receivables (cents)',
  discretionary_spend_cents: 'Discretionary spend (cents)',
};

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  pricing: 'Pricing',
  capacity: 'Capacity',
  spend: 'Spend',
  collections: 'Collections',
  margin: 'Margin',
};

export interface EconomicSnapshot {
  id: string;
  computed_at: string;
  revenue_cents: number | null;
  cost_cents: number | null;
  margin_pct: number | null;
  capacity_utilization_pct: number | null;
  cash_runway_days: number | null;
  overdue_receivables_cents: number | null;
  health_score: number | null;
  signals_used: number;
  notes: string | null;
}

export interface EconomicAction {
  id: string;
  snapshot_id: string;
  category: ActionCategory;
  title: string;
  rationale: string;
  evidence: Record<string, number>;
  estimated_impact_cents: number;
  urgency: Urgency;
  status: ActionStatus;
  decision_reason: string | null;
  decided_at: string | null;
  implemented_at: string | null;
  realized_impact_cents: number | null;
  created_at: string;
}

export async function fetchSnapshots(limit = 10): Promise<EconomicSnapshot[]> {
  const { data, error } = await supabase.from('economic_snapshots').select('*').order('computed_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as EconomicSnapshot[]) ?? [];
}

export async function fetchActions(status?: ActionStatus): Promise<EconomicAction[]> {
  let query = supabase.from('economic_actions').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query.limit(100);
  if (error) throw error;
  return (data as EconomicAction[]) ?? [];
}

export async function logSignal(input: {
  signal_type: SignalType;
  value: number;
  period_start: string;
  period_end: string;
}): Promise<void> {
  const { error } = await supabase.rpc('log_economic_signal', {
    p_signal_type: input.signal_type,
    p_value: input.value,
    p_period_start: input.period_start,
    p_period_end: input.period_end,
  });
  if (error) throw error;
}

export async function runAutopilot(): Promise<{ snapshot_id: string; health_score: number; actions_created: number; signals_used: number }> {
  const { data, error } = await supabase.rpc('run_economic_autopilot');
  if (error) throw error;
  return data as { snapshot_id: string; health_score: number; actions_created: number; signals_used: number };
}

export async function decideAction(id: string, decision: 'approved' | 'dismissed', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('decide_economic_action', { p_action_id: id, p_decision: decision, p_reason: reason ?? null });
  if (error) throw error;
}

export async function markImplemented(id: string, realizedImpactCents?: number): Promise<void> {
  const { error } = await supabase.rpc('mark_action_implemented', { p_action_id: id, p_realized_impact_cents: realizedImpactCents ?? null });
  if (error) throw error;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
