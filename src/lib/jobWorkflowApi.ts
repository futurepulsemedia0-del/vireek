/**
 * Extended job workflow — network layer. Pure logic lives in jobWorkflow.ts.
 *
 * All writes go through the SECURITY DEFINER RPCs (set_job_workflow_status /
 * resume_job_from_workflow); `job_holds` is read-only for clients. Row access is scoped by
 * RLS to the caller's account, so no explicit owner filter is needed on reads.
 */
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_WORKFLOW_POLICIES,
  WORKFLOW_STATUSES,
  isWorkflowRpcStatus,
  isWorkflowStatus,
  type HoldPayload,
  type JobHold,
  type ResumeTarget,
  type WorkflowPolicy,
  type WorkflowRpcStatus,
  type WorkflowStatus,
} from '@/lib/jobWorkflow';

const HOLD_COLUMNS =
  'id, user_id, job_id, status, reason_code, reason_note, previous_status, expected_resume_at, started_at, sla_minutes, sla_due_at, sla_breached_at, reminders_sent, max_reminders, next_reminder_at, last_reminded_at, resolved_at, resolved_to_status, resolution_note, created_at';

export interface WorkflowResult {
  ok: boolean;
  status: WorkflowRpcStatus | 'error';
  /** Safe, human-readable message to show in a toast when `ok` is false. */
  message?: string;
}

function toResult(data: unknown, error: { message?: string } | null, fallback: string): WorkflowResult {
  if (error) return { ok: false, status: 'error', message: fallback };
  const row = (data ?? {}) as { status?: unknown; reason?: unknown };
  if (!isWorkflowRpcStatus(row.status)) return { ok: false, status: 'error', message: fallback };
  if (row.status === 'ok') return { ok: true, status: 'ok' };
  const message = typeof row.reason === 'string' && row.reason.length < 200 ? row.reason : fallback;
  return { ok: false, status: row.status, message };
}

/** Open (unresolved) holds for the whole account — one row per held job. */
export async function fetchOpenHolds(): Promise<JobHold[]> {
  const { data, error } = await supabase
    .from('job_holds')
    .select(HOLD_COLUMNS)
    .is('resolved_at', null)
    .order('started_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as JobHold[]).filter((h) => isWorkflowStatus(h.status));
}

/** Full hold history for one job, newest first. */
export async function fetchJobHoldHistory(jobId: string): Promise<JobHold[]> {
  const { data, error } = await supabase
    .from('job_holds')
    .select(HOLD_COLUMNS)
    .eq('job_id', jobId)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return ((data ?? []) as JobHold[]).filter((h) => isWorkflowStatus(h.status));
}

export async function setJobWorkflowStatus(jobId: string, payload: HoldPayload): Promise<WorkflowResult> {
  const { data, error } = await supabase.rpc('set_job_workflow_status', {
    p_job_id: jobId,
    p_status: payload.status,
    p_reason_code: payload.reasonCode,
    p_reason_note: payload.note,
    p_expected_resume_at: payload.expectedResumeAt,
  });
  return toResult(data, error, 'Could not update the job status.');
}

export async function resumeJobFromWorkflow(jobId: string, to: ResumeTarget, note: string | null): Promise<WorkflowResult> {
  const { data, error } = await supabase.rpc('resume_job_from_workflow', {
    p_job_id: jobId,
    p_to_status: to,
    p_note: note && note.trim() ? note.trim() : null,
  });
  return toResult(data, error, 'Could not resume the job.');
}

// ------------------------------------------------------------
// Per-account SLA / reminder policy (owner-only writes)
// ------------------------------------------------------------

interface PolicyRow {
  status: WorkflowStatus;
  sla_minutes: number | null;
  remind_after_minutes: number | null;
  remind_every_minutes: number | null;
  max_reminders: number;
  enabled: boolean;
}

/** Effective policy per status: the account's override when present, else the built-in default. */
export async function fetchWorkflowPolicies(): Promise<Record<WorkflowStatus, WorkflowPolicy>> {
  const { data, error } = await supabase
    .from('job_workflow_policies')
    .select('status, sla_minutes, remind_after_minutes, remind_every_minutes, max_reminders, enabled');
  if (error) throw error;
  const out = { ...DEFAULT_WORKFLOW_POLICIES };
  for (const r of (data ?? []) as PolicyRow[]) {
    if (!isWorkflowStatus(r.status)) continue;
    out[r.status] = {
      slaMinutes: r.sla_minutes,
      remindAfterMinutes: r.remind_after_minutes,
      remindEveryMinutes: r.remind_every_minutes,
      maxReminders: r.max_reminders,
      enabled: r.enabled,
    };
  }
  return out;
}

export async function saveWorkflowPolicy(userId: string, status: WorkflowStatus, policy: WorkflowPolicy): Promise<void> {
  if (!WORKFLOW_STATUSES.includes(status)) throw new Error('Unknown workflow status');
  const { error } = await supabase.from('job_workflow_policies').upsert(
    {
      user_id: userId,
      status,
      sla_minutes: policy.slaMinutes,
      remind_after_minutes: policy.remindAfterMinutes,
      remind_every_minutes: policy.remindEveryMinutes,
      max_reminders: policy.maxReminders,
      enabled: policy.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,status' },
  );
  if (error) throw error;
}
