// Goal Decomposition Orchestrator — client domain logic.
// Reads/writes strategic_goals -> goal_strategies -> goal_actions directly
// (all three are plain user-owned FOR ALL tables, same posture as
// businessRoadmap.ts) and calls the goal-decomposition-orchestrator edge
// function to create + AI-decompose a new goal.
// See supabase/migrations/20261207000000_goal_decomposition_orchestrator.sql

import { supabase } from '@/lib/supabase';

export type GoalStatus = 'active' | 'completed' | 'archived';
export type StrategyStatus = 'active' | 'completed' | 'abandoned';
export type ActionType = 'human_task' | 'workflow_enrollment' | 'marketing_campaign';
export type ActionStatus = 'open' | 'in_progress' | 'done' | 'blocked';

export interface StrategicGoal {
  id: string;
  vision: string;
  target_metric: string | null;
  target_value: number | null;
  horizon_days: number;
  status: GoalStatus;
  progress_pct: number;
  created_at: string;
}

export interface GoalStrategy {
  id: string;
  goal_id: string;
  title: string;
  rationale: string | null;
  status: StrategyStatus;
  sort_order: number;
}

export interface GoalAction {
  id: string;
  strategy_id: string;
  title: string;
  description: string | null;
  action_type: ActionType;
  owner_name: string | null;
  due_at: string | null;
  status: ActionStatus;
  is_auto_generated: boolean;
  sort_order: number;
}

export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  human_task: 'Human task',
  workflow_enrollment: 'Automated workflow',
  marketing_campaign: 'Marketing campaign',
};

export const ACTION_STATUS_COLORS: Record<ActionStatus, string> = {
  open: 'bg-bg-tertiary text-text-secondary',
  in_progress: 'bg-cta/15 text-cta',
  done: 'bg-success-500/15 text-success-500',
  blocked: 'bg-error-500/15 text-error-500',
};

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function fetchGoals(status: GoalStatus = 'active'): Promise<StrategicGoal[]> {
  const { data, error } = await supabase.from('strategic_goals').select('*').eq('status', status).order('created_at', { ascending: false });
  if (error) throw error;
  return (data as StrategicGoal[]) ?? [];
}

export async function fetchStrategiesWithActions(goalId: string): Promise<{ strategy: GoalStrategy; actions: GoalAction[] }[]> {
  const { data: strategies, error: sErr } = await supabase.from('goal_strategies').select('*').eq('goal_id', goalId).order('sort_order');
  if (sErr) throw sErr;
  const strategyIds = (strategies ?? []).map((s) => s.id);
  if (strategyIds.length === 0) return [];

  const { data: actions, error: aErr } = await supabase.from('goal_actions').select('*').in('strategy_id', strategyIds).order('sort_order');
  if (aErr) throw aErr;

  return ((strategies as GoalStrategy[]) ?? []).map((strategy) => ({
    strategy,
    actions: ((actions as GoalAction[]) ?? []).filter((a) => a.strategy_id === strategy.id),
  }));
}

/** Creates a goal and triggers AI decomposition into strategies + actions. Takes a few seconds. */
export async function createAndDecomposeGoal(input: {
  vision: string;
  target_metric?: string;
  target_value?: number;
  horizon_days?: number;
}): Promise<{ goal_id: string; strategies_count: number; actions_count: number }> {
  const { data, error } = await supabase.functions.invoke('goal-decomposition-orchestrator', { body: input });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not decompose this goal. Try again shortly.'));
  if (data?.error) throw new Error(String(data.error));
  return data;
}

export async function updateActionStatus(id: string, status: ActionStatus): Promise<void> {
  const { error } = await supabase.from('goal_actions').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function archiveGoal(id: string): Promise<void> {
  const { error } = await supabase.from('strategic_goals').update({ status: 'archived' }).eq('id', id);
  if (error) throw error;
}
