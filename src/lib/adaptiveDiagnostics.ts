/**
 * VIREEK Adaptive Diagnostic Network - client domain logic.
 *
 * Loop: symptom -> best next question (highest expected information gain) -> technician
 * answer -> probabilities recomputed -> ... -> diagnosis -> confirmed cause -> repair ->
 * verified outcome -> counts flow back into the model (account + optional anonymous network).
 *
 * Server counterparts:
 *   supabase/functions/adaptive-diagnostics        (start / answer / state)
 *   supabase/functions/_shared/adaptive-diagnostics/engine.ts   (pure Bayesian engine)
 *   supabase/migrations/20270315000000_adaptive_diagnostic_network.sql (+ _seed)
 * Keep the types below in sync with the edge function's buildState().
 */

import { supabase } from '@/lib/supabase';

export const ADN_SKIP_ANSWER = '__skip__';

export type AdnStatus =
  'active' | 'diagnosed' | 'confirmed' | 'repaired' | 'verified' | 'abandoned';
export type AdnOutcome = 'success' | 'partial' | 'failed';
export type AdnConfidence = 'high' | 'moderate' | 'low';
export type AdnStopReason = 'confident' | 'safety_hazard' | 'no_informative_test' | 'max_steps';

export interface AdnSymptom {
  key: string;
  label: string;
  family: string;
  trade: string;
  sort_order: number;
}

export interface AdnCause {
  key: string;
  label: string;
  family: string;
  safety_critical: boolean;
  summary: string | null;
  repair_steps: string[];
  parts: { name: string; necessity: 'likely' | 'possible' | 'if_confirmed' }[];
}

export interface AdnAnswerDef {
  key: string;
  label: string;
  hazard?: boolean;
}

export interface AdnDifferentialItem {
  cause_key: string;
  label: string;
  probability: number;
  safety_critical: boolean;
}

export interface AdnAnswerPreview {
  answer_key: string;
  answer_label: string;
  probability: number;
  top_cause_key: string;
  top_cause_label: string;
  top_cause_probability: number;
}

export interface AdnNextQuestion {
  test: {
    key: string;
    label: string;
    question: string;
    tool_needed: string | null;
    effort: number;
    kind: 'question' | 'inspection' | 'measurement';
    safety_note: string | null;
    answers: AdnAnswerDef[];
  };
  information_gain_bits: number;
  reason: 'safety_check' | 'highest_information_gain';
  preview: AdnAnswerPreview[];
}

export interface AdnDecision {
  action: 'ask' | 'conclude';
  stop_reason: AdnStopReason | null;
  confidence: AdnConfidence;
  entropy_bits: number | null;
  answered_count: number;
  differential: AdnDifferentialItem[];
  safety_alerts: { cause_key: string; label: string; probability: number }[];
  hazards: { test_key: string; answer_key: string; answer_label: string }[];
  next: AdnNextQuestion | null;
}

export interface AdnStepView {
  step_no: number;
  test_key: string;
  test_label: string;
  answer_key: string;
  answer_label: string;
  information_gain_bits: number | null;
  entropy_before: number | null;
  entropy_after: number | null;
  top_cause_key: string | null;
  top_cause_label: string | null;
  top_probability: number | null;
}

export interface AdnSessionView {
  id: string;
  status: AdnStatus;
  symptom_key: string;
  family: string;
  make: string;
  model: string | null;
  equipment_label: string | null;
  job_id: string | null;
  step_count: number;
  suggested_cause_key: string | null;
  suggested_probability: number | null;
  confirmed_cause_key: string | null;
  outcome: AdnOutcome | null;
  needs_review: boolean;
  verify_due_at: string | null;
  created_at: string;
}

export interface AdnState {
  session: AdnSessionView;
  steps: AdnStepView[];
  decision: AdnDecision;
}

export interface AdnSessionRow extends AdnSessionView {
  symptom_key: string;
  repaired_at: string | null;
  outcome_source: 'technician' | 'auto' | null;
  outcome_at: string | null;
  repair_notes: string | null;
}

export interface AdnStats {
  sessions_total: number;
  in_progress: number;
  awaiting_verification: number;
  verified: number;
  fix_rate: number | null;
  top1_accuracy: number | null;
  avg_questions: number | null;
  account_learned_outcomes: number;
  network_learned_outcomes: number;
}

export interface AdnSettings {
  share_anonymous_learning: boolean;
  verify_after_days: number;
}

export const ADN_DEFAULT_SETTINGS: AdnSettings = {
  share_anonymous_learning: true,
  verify_after_days: 14,
};

export const ADN_STATUS_META: Record<AdnStatus, { label: string; className: string }> = {
  active: { label: 'In progress', className: 'bg-accent/10 text-accent' },
  diagnosed: { label: 'Diagnosed', className: 'bg-warning-500/10 text-warning-500' },
  confirmed: { label: 'Cause confirmed', className: 'bg-warning-500/10 text-warning-500' },
  repaired: { label: 'Awaiting verification', className: 'bg-accent/10 text-accent' },
  verified: { label: 'Verified', className: 'bg-success-500/15 text-success-500' },
  abandoned: { label: 'Abandoned', className: 'bg-bg-tertiary text-text-secondary' },
};

export const ADN_FAMILY_LABELS: Record<string, string> = {
  ac: 'Air conditioning',
  furnace: 'Gas furnace',
  water_heater: 'Water heater',
  plumbing_drain: 'Drains & sewer',
};

export const ADN_STOP_REASON_TEXT: Record<AdnStopReason, string> = {
  confident: 'Evidence is strong enough to act on.',
  safety_hazard: 'A safety hazard was reported - stop and make the site safe before any diagnosis.',
  no_informative_test: 'No remaining test would meaningfully narrow it down.',
  max_steps: 'Question limit reached - confirm with a hands-on check.',
};

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

async function invoke(body: Record<string, unknown>): Promise<AdnState> {
  const { data, error } = await supabase.functions.invoke('adaptive-diagnostics', { body });
  if (error)
    throw new Error(
      await functionErrorMessage(
        error,
        'Could not reach the adaptive diagnostic engine. Check your connection and try again.',
      ),
    );
  if (data?.error) throw new Error(String(data.error));
  return data as AdnState;
}

export function startAdnSession(input: {
  symptomKey: string;
  jobId?: string | null;
  equipmentId?: string | null;
  equipmentLabel?: string;
  make?: string;
  model?: string;
}): Promise<AdnState> {
  return invoke({
    action: 'start',
    symptomKey: input.symptomKey,
    jobId: input.jobId ?? null,
    equipmentId: input.equipmentId ?? null,
    equipmentLabel: input.equipmentLabel?.trim() ?? '',
    make: input.make?.trim() ?? '',
    model: input.model?.trim() ?? '',
  });
}

export function answerAdnStep(
  sessionId: string,
  testKey: string,
  answerKey: string,
): Promise<AdnState> {
  return invoke({ action: 'answer', sessionId, testKey, answerKey });
}

export function fetchAdnState(sessionId: string): Promise<AdnState> {
  return invoke({ action: 'state', sessionId });
}

export async function fetchAdnSymptoms(): Promise<AdnSymptom[]> {
  const { data, error } = await supabase
    .from('adn_symptoms')
    .select('key, label, family, trade, sort_order')
    .order('sort_order');
  if (error) throw error;
  return (data as AdnSymptom[]) ?? [];
}

export async function fetchAdnCauses(): Promise<Record<string, AdnCause>> {
  const { data, error } = await supabase
    .from('adn_causes')
    .select('key, label, family, safety_critical, summary, repair_steps, parts');
  if (error) throw error;
  const out: Record<string, AdnCause> = {};
  for (const c of (data as AdnCause[]) ?? []) out[c.key] = c;
  return out;
}

export async function fetchAdnSessions(limit = 30): Promise<AdnSessionRow[]> {
  const { data, error } = await supabase
    .from('adn_sessions')
    .select(
      'id, status, symptom_key, family, make, model, equipment_label, job_id, step_count, suggested_cause_key, suggested_probability, confirmed_cause_key, outcome, needs_review, verify_due_at, created_at, repaired_at, outcome_source, outcome_at, repair_notes',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as AdnSessionRow[]) ?? [];
}

export async function confirmAdnCause(sessionId: string, causeKey: string): Promise<void> {
  const { error } = await supabase.rpc('adn_confirm_cause', {
    p_session_id: sessionId,
    p_cause_key: causeKey,
  });
  if (error) throw new Error(error.message);
}

export async function completeAdnRepair(
  sessionId: string,
  notes: string,
): Promise<{ verify_due_at: string }> {
  const { data, error } = await supabase.rpc('adn_complete_repair', {
    p_session_id: sessionId,
    p_notes: notes.trim() || null,
  });
  if (error) throw new Error(error.message);
  return data as { verify_due_at: string };
}

export async function recordAdnOutcome(
  sessionId: string,
  outcome: AdnOutcome,
  correctedCauseKey?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('adn_record_outcome', {
    p_session_id: sessionId,
    p_outcome: outcome,
    p_corrected_cause_key: correctedCauseKey || null,
  });
  if (error) throw new Error(error.message);
}

export async function abandonAdnSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('adn_abandon_session', { p_session_id: sessionId });
  if (error) throw new Error(error.message);
}

/** Auto-verifies repairs whose verification date has passed and whose customer had no repeat job. Returns how many. */
export async function sweepAdnVerifications(): Promise<number> {
  const { data, error } = await supabase.rpc('adn_sweep_my_due_verifications');
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function fetchAdnStats(): Promise<AdnStats | null> {
  const { data, error } = await supabase.rpc('adn_my_stats');
  if (error) throw error;
  return (data as AdnStats) ?? null;
}

export async function fetchAdnSettings(): Promise<AdnSettings> {
  const { data, error } = await supabase
    .from('adn_settings')
    .select('share_anonymous_learning, verify_after_days')
    .maybeSingle();
  if (error) throw error;
  return (data as AdnSettings | null) ?? ADN_DEFAULT_SETTINGS;
}

export async function saveAdnSettings(userId: string, settings: AdnSettings): Promise<void> {
  const { error } = await supabase
    .from('adn_settings')
    .upsert(
      { user_id: userId, ...settings, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) throw new Error(error.message);
}

export const pct = (p: number | null | undefined, digits = 0): string =>
  p === null || p === undefined ? '—' : `${(p * 100).toFixed(digits)}%`;
