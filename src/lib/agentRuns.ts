import { supabase } from '@/lib/supabase';
import type { RunStepView, RunView } from '@/lib/agentRunsCore';

/**
 * Agent run runtime — read client. Tables are owner-readable through RLS
 * (agent_runs / agent_run_steps, see 20281116000000_agent_run_runtime.sql); all writes happen
 * server-side. Approval decisions still go through decideAgentAction() in lib/agentGovernance.
 */

export interface ApprovalContext {
  step: RunStepView;
  run: RunView | null;
}

/** Map of agent_action_log.id → the ledger step (and run) that is waiting on it. */
export async function fetchApprovalContext(logIds: string[]): Promise<Map<string, ApprovalContext>> {
  const result = new Map<string, ApprovalContext>();
  if (logIds.length === 0) return result;

  const { data: steps, error } = await supabase
    .from('agent_run_steps')
    .select('*')
    .in('action_log_id', logIds)
    .limit(500);
  if (error) throw error;
  const stepRows = (steps ?? []) as RunStepView[];
  if (stepRows.length === 0) return result;

  const runIds = [...new Set(stepRows.map((s) => s.run_id))];
  const { data: runs, error: runError } = await supabase
    .from('agent_runs')
    .select('id, agent_source, correlation_id, status, plan, limits, usage, deadline_at, created_at')
    .in('id', runIds);
  if (runError) throw runError;
  const runById = new Map(((runs ?? []) as RunView[]).map((r) => [r.id, r]));

  for (const step of stepRows) {
    if (step.action_log_id) result.set(step.action_log_id, { step, run: runById.get(step.run_id) ?? null });
  }
  return result;
}

/** Full timeline of one run: plan + every step in order. */
export async function fetchRunTimeline(runId: string): Promise<{ run: RunView | null; steps: RunStepView[] }> {
  const [{ data: run, error: runError }, { data: steps, error: stepsError }] = await Promise.all([
    supabase
      .from('agent_runs')
      .select('id, agent_source, correlation_id, status, plan, limits, usage, deadline_at, created_at')
      .eq('id', runId)
      .maybeSingle(),
    supabase.from('agent_run_steps').select('*').eq('run_id', runId).order('step_index', { ascending: true }),
  ]);
  if (runError) throw runError;
  if (stepsError) throw stepsError;
  return { run: (run as RunView | null) ?? null, steps: (steps ?? []) as RunStepView[] };
}
