/**
 * Vireek «No-Surprise» Engine — API layer (Supabase).
 *
 * Staff side: RLS-scoped table access + SECURITY INVOKER status RPC.
 * Customer side: token-gated SECURITY DEFINER RPCs keyed by jobs.reschedule_token
 * (same secret already used by /reschedule, /track and /service).
 */

import { supabase } from '@/lib/supabase';
import {
  draftToOptions,
  friendlyDbError,
  type AiAssessment,
  type Certification,
  type NoSurpriseDraft,
  type NoSurpriseRequest,
  type NoSurpriseRoom,
} from '@/lib/noSurprise';

export function getApprovalLink(token: string): string {
  return `${window.location.origin}/approve/${token}`;
}

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

// ============================================================
// STAFF
// ============================================================

/** Flushes requests whose deadline passed (server records the expiry in the evidence chain). */
export async function expireDueRequests(jobId: string): Promise<void> {
  await supabase.rpc('no_surprise_expire_job', { p_job_id: jobId });
}

export async function fetchJobRequests(jobId: string): Promise<NoSurpriseRequest[]> {
  await expireDueRequests(jobId).catch(() => undefined);
  const { data, error } = await supabase
    .from('no_surprise_requests')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as NoSurpriseRequest[]) ?? [];
}

export async function fetchJobCertification(jobId: string): Promise<Certification | null> {
  const { data, error } = await supabase.rpc('no_surprise_job_status', { p_job_id: jobId });
  if (error) throw error;
  return (data as Certification | null) ?? null;
}

export async function createRequest(input: {
  jobId: string;
  draft: NoSurpriseDraft;
  triggerNote: string;
  aiAssisted: boolean;
}): Promise<NoSurpriseRequest> {
  const { jobId, draft, triggerNote, aiAssisted } = input;
  const expires = new Date(Date.now() + draft.expires_in_hours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('no_surprise_requests')
    .insert({
      job_id: jobId,
      title: draft.title.trim(),
      trigger_note: triggerNote.trim() || null,
      why: draft.why.trim(),
      necessity: draft.necessity,
      risk_level: draft.risk_level,
      consequence: draft.consequence.trim(),
      options: draftToOptions(draft),
      work_paused: draft.work_paused,
      ai_assisted: aiAssisted,
      expires_at: expires,
    })
    .select('*')
    .single();
  if (error) throw new Error(friendlyDbError(error.message));
  return data as NoSurpriseRequest;
}

export async function withdrawRequest(requestId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('no_surprise_requests')
    .update({ status: 'withdrawn', withdrawn_reason: reason.trim().slice(0, 500) || null })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (error) throw new Error(friendlyDbError(error.message));
}

export async function assessWithAi(input: { jobId: string; findings: string }): Promise<AiAssessment> {
  const { data, error } = await supabase.functions.invoke('no-surprise-assess', {
    body: { jobId: input.jobId, findings: input.findings.trim() },
  });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not reach the AI assistant. You can still fill this in by hand.'));
  if (data?.error) throw new Error(String(data.error));
  return data.assessment as AiAssessment;
}

// ============================================================
// CUSTOMER (token-gated)
// ============================================================

export async function fetchRoom(token: string): Promise<NoSurpriseRoom | null> {
  const { data, error } = await supabase.rpc('get_no_surprise_room', { p_token: token });
  if (error || !data) return null;
  return data as NoSurpriseRoom;
}

export type RespondResult = { ok: true; status: 'approved' | 'declined' } | { ok: false; error: string };

export async function respondToRequest(input: {
  token: string;
  requestId: string;
  decision: 'approve' | 'decline';
  optionId?: string | null;
  signedName?: string;
  note?: string;
  acknowledged?: boolean;
}): Promise<RespondResult> {
  const { data, error } = await supabase.rpc('respond_no_surprise_request', {
    p_token: input.token,
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_option_id: input.optionId ?? null,
    p_signed_name: input.signedName?.trim() || null,
    p_note: input.note?.trim() || null,
    p_acknowledged: input.acknowledged ?? false,
  });
  if (error || !data) return { ok: false, error: 'network' };
  const res = data as { ok: boolean; status?: 'approved' | 'declined'; error?: string };
  if (res.ok && res.status) return { ok: true, status: res.status };
  return { ok: false, error: res.error ?? 'unknown' };
}
