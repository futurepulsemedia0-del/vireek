/**
 * Vireek Autonomous Operations Loop — umbrella over every learning engine.
 *
 *   OBSERVE -> UNDERSTAND -> PREDICT -> DECIDE -> ACT -> MEASURE -> LEARN
 *   -> UPDATE POLICY -> ACT BETTER (repeat)
 *
 * Every job is a training event. This module does NOT re-implement any engine:
 * it reads the per-job evidence the existing engines already wrote
 * (Evidence Chain, Outcome Assurance, Agent Governance, Job Outcomes,
 * Continuous Improvement) and answers two questions honestly:
 *   1. How far did each job travel through the loop?
 *   2. Did approved policy updates actually make operations better?
 *
 * Everything above the "DATA LAYER" banner is pure and deterministic.
 * Server counterpart: supabase/migrations/20270210000000_autonomous_operations_loop.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type JobStageKey = 'observe' | 'understand' | 'predict' | 'decide' | 'act' | 'measure' | 'learn';
export type StageHealth = 'healthy' | 'partial' | 'gap' | 'idle';
export type ImpactVerdict = 'improved' | 'flat' | 'worsened' | 'insufficient';

export interface OpsLoopTotals {
  jobs: number;
  completed: number;
  closed_loop: number;
  training_events: number;
  avg_training_value: number;
  observed: number;
  understood: number;
  predicted: number;
  decided: number;
  acted: number;
  measured: number;
  learned: number;
}

export interface OpsLoopPolicySummary {
  policy_changes_total: number;
  policy_changes_window: number;
  pending_proposals: number;
  active_policies: number;
}

export interface OpsPolicyImpact {
  id: string;
  epoch: number;
  change_type: 'activated' | 'reverted' | 'superseded';
  summary: string;
  effective_at: string;
  n_before: number;
  n_after: number;
  mae_before: number | null;
  mae_after: number | null;
  verdict: ImpactVerdict;
}

export interface OpsLoopRecentEvent {
  job_id: string;
  customer_name: string;
  job_type_key: string | null;
  stages_reached: number;
  training_value: number;
  observed: boolean;
  understood: boolean;
  predicted: boolean;
  decided: boolean;
  acted: boolean;
  measured: boolean;
  learned: boolean;
  primary_cause: string | null;
  created_at: string;
}

export interface OpsLoopSnapshot {
  window_days: number;
  last_sync: string | null;
  totals: OpsLoopTotals;
  policy: OpsLoopPolicySummary;
  impact: OpsPolicyImpact[];
  recent: OpsLoopRecentEvent[];
}

export interface StageDefinition {
  key: JobStageKey;
  label: string;
  /** Existing Vireek engine that powers this stage. */
  engine: string;
  href: string;
  /** What counts as proof that a job reached this stage. */
  proof: string;
}

export interface StageStatus extends StageDefinition {
  count: number;
  /** Jobs this stage can reasonably apply to. */
  of: number;
  /** 0-100, or null when `of` is 0. */
  coverage: number | null;
  health: StageHealth;
}

// ============================================================
// CONFIG
// ============================================================

export const WINDOW_OPTIONS = [30, 90, 180] as const;

export const STAGES: StageDefinition[] = [
  { key: 'observe', label: 'Observe', engine: 'Job Evidence Chain', href: '/dashboard/evidence-chain', proof: 'The job has at least one evidence-chain entry.' },
  { key: 'understand', label: 'Understand', engine: 'Outcome Assurance', href: '/dashboard/outcome-assurance', proof: 'The pre-dispatch assessment explained its factors.' },
  { key: 'predict', label: 'Predict', engine: 'Outcome Assurance', href: '/dashboard/outcome-assurance', proof: 'A pre-dispatch probability and duration were stored.' },
  { key: 'decide', label: 'Decide', engine: 'Agent Governance', href: '/dashboard/agent-governance', proof: 'An intervention or governed agent decision targets the job.' },
  { key: 'act', label: 'Act', engine: 'Jobs & Dispatch', href: '/dashboard/jobs', proof: 'The job was completed.' },
  { key: 'measure', label: 'Measure', engine: 'Trade Playbooks', href: '/dashboard/trade-playbooks', proof: 'A job outcome (resolution, duration) was recorded.' },
  { key: 'learn', label: 'Learn', engine: 'Continuous Improvement', href: '/dashboard/continuous-improvement', proof: 'Expected vs. actual was compared and the miss attributed.' },
];

export const LOOP_THRESHOLDS = {
  healthy: 70,
  partial: 30,
  /** Minimum measured jobs before the loop is judged at all. */
  minJobs: 5,
} as const;

// ============================================================
// PURE LOGIC
// ============================================================

export const clampPct = (n: number) => Math.max(0, Math.min(100, n));

export function healthFor(coverage: number | null): StageHealth {
  if (coverage === null) return 'idle';
  if (coverage >= LOOP_THRESHOLDS.healthy) return 'healthy';
  if (coverage >= LOOP_THRESHOLDS.partial) return 'partial';
  return 'gap';
}

/** Per-stage coverage. Denominators follow the loop: learn applies to measured jobs, measure to completed jobs. */
export function computeStageStatuses(t: OpsLoopTotals): StageStatus[] {
  const counts: Record<JobStageKey, { count: number; of: number }> = {
    observe: { count: t.observed, of: t.jobs },
    understand: { count: t.understood, of: t.jobs },
    predict: { count: t.predicted, of: t.jobs },
    decide: { count: t.decided, of: t.jobs },
    act: { count: t.acted, of: t.jobs },
    measure: { count: t.measured, of: t.completed },
    learn: { count: t.learned, of: t.measured },
  };
  return STAGES.map((def) => {
    const { count, of } = counts[def.key];
    const coverage = of > 0 ? clampPct(Math.round((count / of) * 100)) : null;
    return { ...def, count, of, coverage, health: healthFor(coverage) };
  });
}

/**
 * The weakest link is where the loop leaks most. `act` is excluded: it only
 * reflects how many jobs are finished, not how well the loop is wired.
 */
export function findWeakestLink(stages: StageStatus[], totals: OpsLoopTotals): StageStatus | null {
  if (totals.jobs < LOOP_THRESHOLDS.minJobs) return null;
  const candidates = stages.filter((s) => s.key !== 'act' && s.coverage !== null && s.coverage < LOOP_THRESHOLDS.healthy);
  if (candidates.length === 0) return null;
  return candidates.reduce((worst, s) => ((s.coverage as number) < (worst.coverage as number) ? s : worst));
}

/** Share of completed jobs that travelled all 7 job-level stages. */
export function closureRate(t: OpsLoopTotals): number | null {
  if (t.completed <= 0) return null;
  return clampPct(Math.round((t.closed_loop / t.completed) * 100));
}

export interface ActBetterSummary {
  improved: number;
  flat: number;
  worsened: number;
  insufficient: number;
  /** One honest sentence for the "Act better" stage. */
  headline: string;
}

export function summarizeImpact(impact: OpsPolicyImpact[]): ActBetterSummary {
  const base = { improved: 0, flat: 0, worsened: 0, insufficient: 0 };
  for (const i of impact) {
    if (i.change_type === 'activated') base[i.verdict] += 1;
  }
  const judged = base.improved + base.flat + base.worsened;
  let headline: string;
  if (impact.length === 0) headline = 'No policy has been activated yet, so there is nothing to compare.';
  else if (judged === 0) headline = 'Policies are active, but there is not yet enough data on both sides to judge them.';
  else if (base.worsened > 0) headline = `${base.worsened} of ${judged} judged policy updates made duration error worse — review and revert them.`;
  else if (base.improved > 0) headline = `${base.improved} of ${judged} judged policy updates reduced duration error.`;
  else headline = 'Judged policy updates made no measurable difference yet.';
  return { ...base, headline };
}

export type PolicyStageHealth = StageHealth;

/** Health of UPDATE POLICY: is learning turning into approved, effective change? */
export function policyStageHealth(p: OpsLoopPolicySummary, summary: ActBetterSummary): PolicyStageHealth {
  if (p.active_policies === 0 && p.policy_changes_total === 0 && p.pending_proposals === 0) return 'idle';
  if (summary.worsened > 0) return 'gap';
  if (p.pending_proposals > 0 && p.active_policies === 0) return 'partial';
  return 'healthy';
}

export const HEALTH_STYLES: Record<StageHealth, { label: string; dot: string; text: string; bg: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-500/10' },
  partial: { label: 'Partial', dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-500/10' },
  gap: { label: 'Gap', dot: 'bg-red-500', text: 'text-red-600', bg: 'bg-red-500/10' },
  idle: { label: 'No data', dot: 'bg-slate-400', text: 'text-slate-500', bg: 'bg-slate-500/10' },
};

export const VERDICT_STYLES: Record<ImpactVerdict, { label: string; className: string }> = {
  improved: { label: 'Improved', className: 'bg-emerald-500/10 text-emerald-600' },
  flat: { label: 'No change', className: 'bg-slate-500/10 text-slate-500' },
  worsened: { label: 'Worse', className: 'bg-red-500/10 text-red-600' },
  insufficient: { label: 'Not enough data', className: 'bg-amber-500/10 text-amber-600' },
};

export const JOB_STAGE_KEYS: JobStageKey[] = STAGES.map((s) => s.key);

// ============================================================
// DATA LAYER
// ============================================================

function rpcMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** Rebuilds the per-job training events from the source engines (idempotent). */
export async function syncOperationsLoop(days: number): Promise<number> {
  const { data, error } = await supabase.rpc('sync_ops_loop_events', { p_days: days });
  if (error) throw new Error(rpcMessage(error, 'Could not sync the operations loop.'));
  return typeof data === 'number' ? data : 0;
}

export async function fetchOperationsLoopSnapshot(days: number): Promise<OpsLoopSnapshot> {
  const { data, error } = await supabase.rpc('get_ops_loop_snapshot', { p_days: days });
  if (error) throw new Error(rpcMessage(error, 'Could not load the operations loop.'));
  return data as OpsLoopSnapshot;
}
