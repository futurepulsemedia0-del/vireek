/**
 * Call-to-Cash Workflow Engine — client library.
 *
 * Thin wrapper over the tables/RPCs created in
 * supabase/migrations/20261005000000_call_to_cash_workflow_engine.sql.
 * Enrollment and execution both happen server-side (a DB trigger on
 * business_activity_events, and the workflow-engine-executor cron
 * function) — this file only reads state and calls the small set of
 * RPCs that move a run forward.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type WorkflowTriggerEvent =
  | 'call.created' | 'call.missed' | 'call.emergency'
  | 'lead.created' | 'job.created' | 'job.completed'
  | 'quote.sent' | 'quote.accepted' | 'quote.declined'
  | 'payment.received' | 'review.completed'
  | 'quote.financing_needed' | 'quote.accepted_not_booked'
  | 'job.completed_not_invoiced' | 'invoice.payment_overdue'
  | 'membership.sold' | 'membership.visit_due' | 'membership.renewal_upcoming'
  | 'membership.payment_failed' | 'membership.churn_risk' | 'membership.churned';

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowMode = 'live' | 'test';
export type RunStatus = 'active' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type StepType = 'sms' | 'call' | 'wait' | 'webhook' | 'human_approval' | 'condition_gate';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval';

export interface WorkflowStepDefinition {
  step_number: number;
  type: StepType;
  delay_minutes: number;
  config: Record<string, unknown>;
  on_failure: 'continue' | 'stop';
}

export interface WorkflowDefinition {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string | null;
  industry: string | null;
  trigger_event: WorkflowTriggerEvent;
  trigger_conditions: Record<string, unknown>;
  status: WorkflowStatus;
  mode: WorkflowMode;
  active_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  workflow_version: number;
  user_id: string;
  entity_type: string | null;
  entity_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  context: Record<string, unknown>;
  status: RunStatus;
  current_step_number: number;
  stop_reason: string | null;
  mode: WorkflowMode;
  started_at: string;
  completed_at: string | null;
}

export interface WorkflowRunStep {
  id: string;
  run_id: string;
  step_number: number;
  step_type: StepType;
  config: Record<string, unknown>;
  on_failure: 'continue' | 'stop';
  status: StepStatus;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  max_attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface WorkflowApproval {
  id: string;
  run_id: string;
  run_step_id: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
}

export const TRIGGER_EVENT_LABELS: Record<WorkflowTriggerEvent, string> = {
  'call.created': 'Any call received',
  'call.missed': 'Call missed',
  'call.emergency': 'Emergency call detected',
  'lead.created': 'New lead created',
  'job.created': 'Job scheduled',
  'job.completed': 'Job completed',
  'quote.sent': 'Quote sent',
  'quote.accepted': 'Quote accepted',
  'quote.declined': 'Quote declined',
  'payment.received': 'Payment received',
  'review.completed': 'Review submitted',
};

export const STATUS_LABELS: Record<RunStatus, string> = {
  active: 'Running',
  waiting_approval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const STATUS_COLORS: Record<RunStatus, string> = {
  active: 'bg-accent-500/10 text-accent-500',
  waiting_approval: 'bg-warning-500/10 text-warning-500',
  completed: 'bg-success-500/10 text-success-500',
  failed: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

// ============================================================
// DEFINITIONS
// ============================================================

export async function fetchDefinitions(): Promise<WorkflowDefinition[]> {
  const { data, error } = await supabase
    .from('workflow_definitions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as WorkflowDefinition[]) ?? [];
}

export async function installPlaybook(playbook: {
  slug: string;
  name: string;
  description: string;
  industry: string;
  trigger_event: WorkflowTriggerEvent;
  trigger_conditions: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
}): Promise<WorkflowDefinition> {
  const { data, error } = await supabase.rpc('install_workflow_playbook', {
    p_slug: playbook.slug,
    p_name: playbook.name,
    p_description: playbook.description,
    p_industry: playbook.industry,
    p_trigger_event: playbook.trigger_event,
    p_trigger_conditions: playbook.trigger_conditions,
    p_steps: playbook.steps,
  });
  if (error) throw error;
  return data as WorkflowDefinition;
}

export async function setWorkflowStatus(workflowId: string, status: 'active' | 'paused' | 'archived'): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_workflow_status', { p_workflow_id: workflowId, p_status: status });
  if (error) return false;
  return Boolean(data);
}

// ============================================================
// RUNS
// ============================================================

export interface RunFilters {
  status?: RunStatus | 'all';
  workflowId?: string;
  limit?: number;
}

export async function fetchRuns(filters: RunFilters = {}): Promise<WorkflowRun[]> {
  let query = supabase.from('workflow_runs').select('*').order('started_at', { ascending: false }).limit(filters.limit ?? 200);
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.workflowId) query = query.eq('workflow_id', filters.workflowId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as WorkflowRun[]) ?? [];
}

export async function fetchRunSteps(runId: string): Promise<WorkflowRunStep[]> {
  const { data, error } = await supabase
    .from('workflow_run_steps')
    .select('*')
    .eq('run_id', runId)
    .order('step_number', { ascending: true });
  if (error) throw error;
  return (data as WorkflowRunStep[]) ?? [];
}

export async function cancelRun(runId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('cancel_workflow_run', { p_run_id: runId });
  if (error) return false;
  return Boolean(data);
}

// ============================================================
// APPROVALS
// ============================================================

export async function fetchPendingApprovals(): Promise<WorkflowApproval[]> {
  const { data, error } = await supabase
    .from('workflow_approvals')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });
  if (error) throw error;
  return (data as WorkflowApproval[]) ?? [];
}

export async function approveStep(approvalId: string, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('approve_workflow_step', { p_approval_id: approvalId, p_note: note ?? null });
  if (error) return false;
  return Boolean(data);
}

export async function rejectStep(approvalId: string, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('reject_workflow_step', { p_approval_id: approvalId, p_note: note ?? null });
  if (error) return false;
  return Boolean(data);
}

// ============================================================
// REVENUE ATTRIBUTION (see revenue_recovery_events.recovering_run_id,
// added in 20261006000000_workflow_revenue_attribution.sql)
// ============================================================

export interface RunRecoveryAttribution {
  status: 'open' | 'contacted' | 'recovered' | 'written_off';
  recovered_amount_cents: number | null;
}

/** Null if this run's entity has no Revenue Recovery Ledger entry at all
 *  (e.g. a lead.created-triggered run — that table only tracks
 *  calls/quotes/jobs). */
export async function fetchRunRecoveryAttribution(runId: string): Promise<RunRecoveryAttribution | null> {
  const { data, error } = await supabase
    .from('revenue_recovery_events')
    .select('status, recovered_amount_cents')
    .eq('recovering_run_id', runId)
    .maybeSingle();
  if (error || !data) return null;
  return data as RunRecoveryAttribution;
}

// ============================================================
// STATS
// ============================================================

export interface WorkflowStats {
  activeDefinitions: number;
  runsInFlight: number;
  pendingApprovals: number;
  completedThisMonth: number;
}

export function computeStats(definitions: WorkflowDefinition[], runs: WorkflowRun[], approvals: WorkflowApproval[]): WorkflowStats {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  return {
    activeDefinitions: definitions.filter((d) => d.status === 'active').length,
    runsInFlight: runs.filter((r) => r.status === 'active' || r.status === 'waiting_approval').length,
    pendingApprovals: approvals.length,
    completedThisMonth: runs.filter((r) => r.status === 'completed' && r.completed_at && new Date(r.completed_at) >= monthStart).length,
  };
}
