/**
 * Call-to-cash workflow health — network layer. Pure logic lives in c2cWorkflowHealth.ts.
 * Reads are RLS-scoped to the caller's account; writes go through SECURITY DEFINER RPCs
 * (takeover_job_workflow / release_job_workflow) that re-check job ownership server-side.
 */
import { supabase } from '@/lib/supabase';
import { parseHealthRows, validateTakeoverReason, type HealthRow } from '@/lib/c2cWorkflowHealth';

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export async function fetchWorkflowHealth(): Promise<HealthRow[]> {
  const { data, error } = await supabase.rpc('c2c_workflow_health');
  if (error) throw error;
  return parseHealthRows(data);
}

/** Job ids currently under operator control (automation is blocked by the database). */
export async function fetchLockedJobIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('job_automation_locks')
    .select('job_id')
    .is('released_at', null)
    .limit(1000);
  if (error) throw error;
  return new Set(((data ?? []) as { job_id: string }[]).map((r) => r.job_id));
}

export async function takeoverJob(jobId: string, reason: string): Promise<ActionResult> {
  const invalid = validateTakeoverReason(reason);
  if (invalid) return { ok: false, message: invalid };
  const { error } = await supabase.rpc('takeover_job_workflow', { p_job_id: jobId, p_reason: reason.trim() });
  if (error) return { ok: false, message: 'Could not take over this job. Refresh and try again.' };
  return { ok: true };
}

export async function releaseJob(jobId: string): Promise<ActionResult> {
  const { error } = await supabase.rpc('release_job_workflow', { p_job_id: jobId });
  if (error) return { ok: false, message: 'Could not resume automation for this job. Refresh and try again.' };
  return { ok: true };
}
