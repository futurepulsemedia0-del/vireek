import { supabase } from '@/lib/supabase';
import { parseWorkspace, type FollowUpPlanStep, type QuoteWorkspace } from '@/lib/quoteWorkspace';

/**
 * Thin RPC layer for /dashboard/quotes/:id. Every call goes through a
 * SECURITY DEFINER function that re-checks the caller's account and
 * can_view_billing, so a missing client-side gate can never leak data.
 */

type Failure = { message?: string; code?: string } | null;

function isForbidden(err: Failure): boolean {
  return err?.code === '42501' || /forbidden/i.test(err?.message ?? '');
}

export type WorkspaceLoadResult =
  | { ok: true; data: QuoteWorkspace }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'failed' };

export async function fetchQuoteWorkspace(quoteId: string): Promise<WorkspaceLoadResult> {
  const { data, error } = await supabase.rpc('get_quote_workspace', { p_quote_id: quoteId });
  if (error) return { ok: false, reason: isForbidden(error) ? 'forbidden' : 'failed' };
  if (data == null) return { ok: false, reason: 'not_found' };
  const parsed = parseWorkspace(data);
  return parsed ? { ok: true, data: parsed } : { ok: false, reason: 'failed' };
}

export async function scheduleQuoteFollowUps(
  quoteId: string,
  steps: FollowUpPlanStep[],
): Promise<{ ok: true } | { ok: false; reason: 'forbidden' | 'invalid_state' | 'failed' }> {
  const { error } = await supabase.rpc('schedule_quote_followups', { p_quote_id: quoteId, p_steps: steps });
  if (!error) return { ok: true };
  if (isForbidden(error)) return { ok: false, reason: 'forbidden' };
  if (/quote_not_sent/i.test(error.message ?? '')) return { ok: false, reason: 'invalid_state' };
  return { ok: false, reason: 'failed' };
}

export async function completeQuoteFollowUp(
  followUpId: string,
  status: 'done' | 'skipped',
  outcome: string | null,
): Promise<{ ok: true } | { ok: false; reason: 'forbidden' | 'invalid_state' | 'failed' }> {
  const { data, error } = await supabase.rpc('complete_quote_followup', {
    p_followup_id: followUpId,
    p_status: status,
    p_outcome: outcome,
  });
  if (error) return { ok: false, reason: isForbidden(error) ? 'forbidden' : 'failed' };
  // false = already completed/cancelled by someone else in the meantime.
  return data === true ? { ok: true } : { ok: false, reason: 'invalid_state' };
}

export async function convertQuoteToJob(
  quoteId: string,
  opts: { scheduledAt: string | null; address: string | null },
): Promise<{ ok: true; jobId: string } | { ok: false; reason: 'forbidden' | 'invalid_state' | 'failed' }> {
  const { data, error } = await supabase.rpc('convert_quote_to_job', {
    p_quote_id: quoteId,
    p_scheduled_at: opts.scheduledAt,
    p_address: opts.address,
  });
  if (error) {
    if (isForbidden(error)) return { ok: false, reason: 'forbidden' };
    if (/quote_not_accepted/i.test(error.message ?? '')) return { ok: false, reason: 'invalid_state' };
    return { ok: false, reason: 'failed' };
  }
  return typeof data === 'string' ? { ok: true, jobId: data } : { ok: false, reason: 'failed' };
}
