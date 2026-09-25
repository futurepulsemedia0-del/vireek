import { supabase } from '@/lib/supabase';

/**
 * Agent Autonomy Readiness Score — dashboard client library.
 *
 * Reads the score computed by get_agent_autonomy_readiness() in
 * supabase/migrations/20261203000000_agent_autonomy_readiness_score.sql.
 * Every row is one governable action type from agent_action_catalog
 * (see src/lib/agentGovernance.ts), scored 0-100 from its last 30 days
 * of agent_action_log activity and placed on the ladder:
 *
 *   observe -> recommend -> execute -> autonomous
 */

export type AutonomyTier = 'observe' | 'recommend' | 'execute' | 'autonomous';

export interface AgentAutonomyReadiness {
  action_slug: string;
  agent_source: string;
  label: string;
  category: 'messaging' | 'calling' | 'financial' | 'marketing' | 'other';
  is_reversible: boolean;
  has_cost: boolean;
  enabled: boolean;
  requires_approval: boolean;
  auto_approve_max_cents: number | null;
  total_actions_30d: number;
  executed_30d: number;
  failed_30d: number;
  rejected_30d: number;
  rolled_back_30d: number;
  failure_rate: number;
  override_rate: number;
  days_since_last_incident: number | null;
  score: number;
  tier: AutonomyTier;
  blockers: string[];
}

export const AUTONOMY_TIER_LABELS: Record<AutonomyTier, string> = {
  observe: 'Observe',
  recommend: 'Recommend',
  execute: 'Execute',
  autonomous: 'Autonomous',
};

export const AUTONOMY_TIER_ORDER: AutonomyTier[] = ['observe', 'recommend', 'execute', 'autonomous'];

export const AUTONOMY_TIER_COLORS: Record<AutonomyTier, { bg: string; text: string; ring: string }> = {
  observe: { bg: 'bg-slate-100', text: 'text-slate-600', ring: 'ring-slate-300' },
  recommend: { bg: 'bg-amber-100', text: 'text-amber-700', ring: 'ring-amber-300' },
  execute: { bg: 'bg-blue-100', text: 'text-blue-700', ring: 'ring-blue-300' },
  autonomous: { bg: 'bg-emerald-100', text: 'text-emerald-700', ring: 'ring-emerald-300' },
};

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function nextTier(tier: AutonomyTier): AutonomyTier | null {
  const idx = AUTONOMY_TIER_ORDER.indexOf(tier);
  return idx >= 0 && idx < AUTONOMY_TIER_ORDER.length - 1 ? AUTONOMY_TIER_ORDER[idx + 1] : null;
}

export async function fetchAgentAutonomyReadiness(): Promise<AgentAutonomyReadiness[]> {
  const { data, error } = await supabase.rpc('get_agent_autonomy_readiness');
  if (error) throw error;
  return (data as AgentAutonomyReadiness[]) ?? [];
}

export interface AgentAutonomySnapshot {
  action_slug: string;
  snapshot_date: string;
  score: number;
  tier: AutonomyTier;
  total_actions_30d: number;
  failure_rate: number;
  override_rate: number;
}

export async function fetchAgentAutonomyHistory(actionSlug: string, days = 30): Promise<AgentAutonomySnapshot[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from('agent_autonomy_score_snapshots')
    .select('action_slug, snapshot_date, score, tier, total_actions_30d, failure_rate, override_rate')
    .eq('action_slug', actionSlug)
    .gte('snapshot_date', since.toISOString().slice(0, 10))
    .order('snapshot_date', { ascending: true });
  if (error) throw error;
  return (data as AgentAutonomySnapshot[]) ?? [];
}

export async function captureAgentAutonomySnapshot(): Promise<number> {
  const { data, error } = await supabase.rpc('capture_my_agent_autonomy_snapshot');
  if (error) throw error;
  return (data as number) ?? 0;
}

export function summarizeReadiness(rows: AgentAutonomyReadiness[]) {
  const total = rows.length;
  const counts: Record<AutonomyTier, number> = { observe: 0, recommend: 0, execute: 0, autonomous: 0 };
  let scoreSum = 0;
  for (const r of rows) {
    counts[r.tier] += 1;
    scoreSum += r.score;
  }
  return {
    total,
    counts,
    averageScore: total > 0 ? Math.round(scoreSum / total) : 0,
  };
}
