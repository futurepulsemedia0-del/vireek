/**
 * Autonomous Operations Center — client library.
 *
 * End-to-end problem management: Detection -> Root Cause -> Action +
 * Owner -> Execution -> real Outcome, with automatic reopen-on-recurrence.
 * Every stage transition is appended to an immutable `timeline`
 * server-side (see the SECURITY DEFINER functions below).
 *
 * Server counterpart: supabase/migrations/20261207000000_autonomous_operations_center.sql
 */

import { supabase } from '@/lib/supabase';
import { OperationalSeverity, SEVERITY_COLORS, SEVERITY_LABELS } from '@/lib/decisionDebt';

export type OpsCategory = 'dispatch' | 'staffing' | 'quality' | 'customer' | 'vendor' | 'system' | 'safety' | 'financial' | 'custom';
export type OpsSource = 'auto' | 'agent' | 'manual';
export type OpsStatus = 'detected' | 'root_cause_identified' | 'action_assigned' | 'in_execution' | 'resolved' | 'reopened';
export type OpsOutcomeStatus = 'resolved' | 'partially_resolved' | 'unresolved';

export interface OpsTimelineEvent {
  at: string;
  stage: string;
  note: string | null;
}

export interface OpsProblem {
  id: string;
  linked_ledger_entry_id: string | null;
  recurrence_of_id: string | null;
  title: string;
  description: string | null;
  category: OpsCategory;
  severity: OperationalSeverity;
  source: OpsSource;
  status: OpsStatus;
  detected_at: string;
  root_cause: string | null;
  root_cause_category: string | null;
  root_cause_identified_at: string | null;
  action_plan: string | null;
  owner_id: string | null;
  action_assigned_at: string | null;
  execution_started_at: string | null;
  outcome_status: OpsOutcomeStatus | null;
  outcome_notes: string | null;
  outcome_recorded_at: string | null;
  timeline: OpsTimelineEvent[];
  created_at: string;
  updated_at: string;
}

export { SEVERITY_LABELS, SEVERITY_COLORS };
export type { OperationalSeverity };

// ============================================================
// LABELS
// ============================================================

export const CATEGORY_LABELS: Record<OpsCategory, string> = {
  dispatch: 'Dispatch',
  staffing: 'Staffing',
  quality: 'Quality',
  customer: 'Customer',
  vendor: 'Vendor',
  system: 'System / IT',
  safety: 'Safety',
  financial: 'Financial',
  custom: 'Other',
};

export const STATUS_LABELS: Record<OpsStatus, string> = {
  detected: 'Detected',
  root_cause_identified: 'Root Cause Identified',
  action_assigned: 'Action Assigned',
  in_execution: 'In Execution',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

export const STATUS_COLORS: Record<OpsStatus, string> = {
  detected: 'bg-danger/10 text-danger',
  root_cause_identified: 'bg-warning-500/10 text-warning-500',
  action_assigned: 'bg-accent/10 text-accent',
  in_execution: 'bg-accent/10 text-accent',
  resolved: 'bg-success-500/10 text-success-500',
  reopened: 'bg-danger/10 text-danger',
};

export const OUTCOME_LABELS: Record<OpsOutcomeStatus, string> = {
  resolved: 'Fully resolved',
  partially_resolved: 'Partially resolved',
  unresolved: 'Unresolved',
};

// ============================================================
// METRICS (MTTR / recurrence)
// ============================================================

/** Hours from detection to a recorded outcome; null while still open. */
export function computeResolutionHours(problem: OpsProblem): number | null {
  if (!problem.outcome_recorded_at) return null;
  return (new Date(problem.outcome_recorded_at).getTime() - new Date(problem.detected_at).getTime()) / 3_600_000;
}

export interface OpsCenterSummary {
  total: number;
  openBySeverity: Record<OperationalSeverity, number>;
  awaitingRootCause: number;
  awaitingAction: number;
  inExecution: number;
  resolvedCount: number;
  reopenedCount: number;
  avgResolutionHours: number | null;
}

export function summarizeOpsCenter(problems: OpsProblem[]): OpsCenterSummary {
  const open = problems.filter((p) => p.status !== 'resolved');
  const openBySeverity: Record<OperationalSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const p of open) openBySeverity[p.severity] += 1;

  const resolutionTimes = problems.map(computeResolutionHours).filter((h): h is number => h !== null);

  return {
    total: problems.length,
    openBySeverity,
    awaitingRootCause: problems.filter((p) => p.status === 'detected').length,
    awaitingAction: problems.filter((p) => p.status === 'root_cause_identified').length,
    inExecution: problems.filter((p) => p.status === 'action_assigned' || p.status === 'in_execution').length,
    resolvedCount: problems.filter((p) => p.status === 'resolved').length,
    reopenedCount: problems.filter((p) => p.status === 'reopened' || p.recurrence_of_id !== null).length,
    avgResolutionHours: resolutionTimes.length ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length : null,
  };
}

// ============================================================
// CRUD + STAGE TRANSITIONS
// ============================================================

export async function fetchOpsProblems(filters?: { status?: OpsStatus; category?: OpsCategory }): Promise<OpsProblem[]> {
  let query = supabase.from('operations_center_problems').select('*').order('detected_at', { ascending: false }).limit(300);
  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.category) query = query.eq('category', filters.category);
  const { data, error } = await query;
  if (error) throw error;
  return (data as OpsProblem[]) ?? [];
}

export interface CreateOpsProblemInput {
  title: string;
  description: string;
  category: OpsCategory;
  severity: OperationalSeverity;
  source: OpsSource;
  linked_ledger_entry_id: string | null;
}

export async function createOpsProblem(input: CreateOpsProblemInput, userId: string): Promise<OpsProblem> {
  const { data, error } = await supabase
    .from('operations_center_problems')
    .insert({
      user_id: userId,
      title: input.title.trim(),
      description: input.description.trim() || null,
      category: input.category,
      severity: input.severity,
      source: input.source,
      linked_ledger_entry_id: input.linked_ledger_entry_id,
      timeline: [{ at: new Date().toISOString(), stage: 'detected', note: null }],
    })
    .select()
    .single();
  if (error) throw error;
  return data as OpsProblem;
}

export async function recordRootCause(id: string, rootCause: string, rootCauseCategory: string): Promise<OpsProblem> {
  const { data, error } = await supabase.rpc('record_ops_problem_root_cause', { p_id: id, p_root_cause: rootCause, p_root_cause_category: rootCauseCategory });
  if (error) throw error;
  return data as OpsProblem;
}

export async function assignActionOwner(id: string, actionPlan: string, ownerId: string | null): Promise<OpsProblem> {
  const { data, error } = await supabase.rpc('assign_ops_problem_action_owner', { p_id: id, p_action_plan: actionPlan, p_owner_id: ownerId });
  if (error) throw error;
  return data as OpsProblem;
}

export async function startExecution(id: string): Promise<OpsProblem> {
  const { data, error } = await supabase.rpc('start_ops_problem_execution', { p_id: id });
  if (error) throw error;
  return data as OpsProblem;
}

export async function recordOutcome(id: string, outcomeStatus: OpsOutcomeStatus, notes: string): Promise<OpsProblem> {
  const { data, error } = await supabase.rpc('record_ops_problem_outcome', { p_id: id, p_outcome_status: outcomeStatus, p_notes: notes });
  if (error) throw error;
  return data as OpsProblem;
}

export async function reopenProblem(id: string, reason: string): Promise<OpsProblem> {
  const { data, error } = await supabase.rpc('reopen_ops_problem', { p_id: id, p_reason: reason });
  if (error) throw error;
  return data as OpsProblem;
}

export async function deleteOpsProblem(id: string): Promise<void> {
  const { error } = await supabase.from('operations_center_problems').delete().eq('id', id);
  if (error) throw error;
}
