import { supabase } from '@/lib/supabase';
import {
  isOutcome,
  parseSummary,
  type DispositionOutcome,
  type DispositionRow,
  type DispositionSummary,
  type FollowUpPayload,
} from '@/lib/callDisposition';
import type { TaskStatus } from '@/lib/tasks';

/**
 * Call dispositions — Supabase access. Permissions and account scoping are
 * enforced by RLS and the RPCs (see 20271021000000_call_dispositions.sql);
 * the explicit user_id filter below is defence in depth, matching the other
 * call pages.
 */

export interface LinkedFollowUp {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
  assigned_to_name: string | null;
}

export async function fetchDisposition(callId: string, accountOwnerId: string): Promise<DispositionRow | null> {
  const { data, error } = await supabase
    .from('call_dispositions')
    .select('*')
    .eq('call_id', callId)
    .eq('user_id', accountOwnerId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !isOutcome((data as { outcome?: unknown }).outcome)) return null;
  return data as unknown as DispositionRow;
}

/** The linked task, or null when it was deleted or the caller's RLS hides it. */
export async function fetchFollowUp(taskId: string): Promise<LinkedFollowUp | null> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, due_at, assigned_to_name')
    .eq('id', taskId)
    .maybeSingle();
  if (error) throw error;
  return (data as LinkedFollowUp | null) ?? null;
}

export interface SaveDispositionResult {
  disposition: DispositionRow;
  taskCreated: boolean;
}

/** Tags the call and (optionally) creates the follow-up task in one transaction. */
export async function saveDisposition(args: {
  callId: string;
  outcome: DispositionOutcome;
  note: string;
  followUp: FollowUpPayload | null;
}): Promise<SaveDispositionResult> {
  const { data, error } = await supabase.rpc('set_call_disposition', {
    p_call_id: args.callId,
    p_outcome: args.outcome,
    p_note: args.note.trim() || null,
    p_task: args.followUp,
  });
  if (error) throw error;
  const payload = data as { disposition?: DispositionRow; task_created?: boolean } | null;
  if (!payload?.disposition) throw new Error('empty_response');
  return { disposition: payload.disposition, taskCreated: Boolean(payload.task_created) };
}

export async function fetchDispositionSummary(from: Date, to: Date): Promise<DispositionSummary> {
  const { data, error } = await supabase.rpc('call_disposition_summary', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return parseSummary(data);
}
