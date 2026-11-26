import { supabase } from '@/lib/supabase';
import {
  cleanClickContext,
  MSA_DOC_KEY,
  parseDocumentOverview,
  parseEvidenceRows,
  PLAN_CHANGE_DOC_KEYS,
  type AcceptanceEvidence,
  type ClickThroughSource,
  type LegalDocumentOverview,
} from '@/lib/legalEvidence';

const CLICK_TIMEOUT_MS = 4000;

async function recordClickThrough(source: ClickThroughSource, docKeys: readonly string[], context: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('record_legal_click_through', {
    p_source: source,
    p_doc_keys: [...docKeys],
    p_context: cleanClickContext(context),
  });
  if (error) throw new Error(error.message);
}

/**
 * Plan change: best effort. A failure to write the evidence must not block a paying customer, so this resolves to
 * false instead of throwing, and never waits longer than a few seconds. Called BEFORE the money call so that the
 * evidence exists even when the checkout redirect leaves the page.
 */
export async function recordPlanChangeAcceptance(planId: string, fromPlanId?: string): Promise<boolean> {
  try {
    await Promise.race([
      recordClickThrough('plan_change', PLAN_CHANGE_DOC_KEYS, { plan_id: planId, from_plan_id: fromPlanId }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CLICK_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** MSA: NOT best effort. The person must know whether the acceptance was stored, so this throws. */
export function recordMsaAcceptance(signerTitle?: string): Promise<void> {
  return recordClickThrough('msa_click_through', [MSA_DOC_KEY], { authority_confirmed: true, signer_title: signerTitle });
}

export interface HistoryQuery {
  userId?: string;
  email?: string;
  docKey?: string;
  before?: string;
  limit?: number;
}

export async function fetchAcceptanceHistory(q: HistoryQuery): Promise<AcceptanceEvidence[]> {
  const { data, error } = await supabase.rpc('staff_legal_acceptance_history', {
    p_user_id: q.userId ?? null,
    p_email: q.email ?? null,
    p_doc_key: q.docKey ?? null,
    p_limit: q.limit ?? 100,
    p_before: q.before ?? null,
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return parseEvidenceRows(data);
}

export async function fetchLegalDocumentOverview(): Promise<LegalDocumentOverview[]> {
  const { data, error } = await supabase.rpc('staff_legal_documents');
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return parseDocumentOverview(data);
}

export async function fetchGraceDays(): Promise<number> {
  const { data, error } = await supabase.rpc('staff_legal_gate_settings');
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const n = Number((data as { grace_days?: unknown } | null)?.grace_days);
  return Number.isInteger(n) && n >= 0 && n <= 90 ? n : 0;
}

export async function saveGraceDays(days: number, reason: string): Promise<void> {
  const { error } = await supabase.rpc('staff_set_legal_grace_days', { p_days: days, p_reason: reason });
  if (error) throw new Error(error.message);
}
