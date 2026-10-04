/**
 * Vireek Adaptive Customer Diagnostic — API layer (Supabase).
 *
 * Customer side: ONE public edge function, token-gated by jobs.reschedule_token (the same secret as /service and /approve).
 * Staff side: RLS-scoped reads + SECURITY DEFINER RPCs that validate the account on the server.
 */

import { supabase } from '@/lib/supabase';
import type {
  DiagHypothesisRow,
  DiagQuestionRow,
  DiagSession,
  LearningSummary,
  StepResponse,
} from '@/lib/adaptiveDiagnostic';

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
// CUSTOMER (public, token-gated)
// ============================================================

async function callStep(body: Record<string, unknown>): Promise<StepResponse> {
  const { data, error } = await supabase.functions.invoke('adaptive-diagnostic', { body });
  if (error) throw new Error(await functionErrorMessage(error, 'Something went wrong. Please try again.'));
  return data as StepResponse;
}

export const startDiagnostic = (token: string, opts: { hazard: boolean; text?: string }) =>
  callStep({ action: 'start', token, hazard: opts.hazard, text: opts.text?.trim() || undefined });

export const answerQuestion = (token: string, sessionId: string, questionCode: string, answerId: string) =>
  callStep({ action: 'answer', token, sessionId, questionCode, answerId });

export const addNote = (token: string, sessionId: string, text: string) =>
  callStep({ action: 'note', token, sessionId, text });

// ============================================================
// STAFF
// ============================================================

const SESSION_COLUMNS =
  'id, job_id, domain_code, status, answers, posterior, top_hypothesis, confidence, hazard, stop_reason, customer_text, created_at, completed_at, confirmed_hypothesis, confirmed_at, top1_correct, outcome_applied_at';

export async function fetchJobSessions(jobId: string): Promise<DiagSession[]> {
  const { data, error } = await supabase
    .from('diag_sessions')
    .select(SESSION_COLUMNS)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data ?? []) as DiagSession[];
}

export async function fetchCatalog(domain: string): Promise<{ hypotheses: DiagHypothesisRow[]; questions: DiagQuestionRow[] }> {
  const [h, q] = await Promise.all([
    supabase.from('diag_hypotheses').select('code, label, parts_hint').eq('domain_code', domain).order('prior', { ascending: false }),
    supabase.from('diag_questions').select('code, text, options').eq('domain_code', domain),
  ]);
  if (h.error) throw h.error;
  if (q.error) throw q.error;
  return { hypotheses: (h.data ?? []) as DiagHypothesisRow[], questions: (q.data ?? []) as DiagQuestionRow[] };
}

export async function confirmOutcome(sessionId: string, hypothesis: string, note?: string) {
  const { data, error } = await supabase.rpc('diag_confirm_outcome', {
    p_session: sessionId,
    p_hypothesis: hypothesis,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as { top1_correct: boolean | null; steps_learned: number; unmapped: boolean };
}

export async function fetchLearningSummary(domain?: string): Promise<LearningSummary> {
  const { data, error } = await supabase.rpc('diag_learning_summary', { p_domain: domain ?? null });
  if (error) throw error;
  return data as LearningSummary;
}
