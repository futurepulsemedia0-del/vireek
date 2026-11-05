/**
 * Voice Autopilot + Human CSR QA — client library.
 *
 *   Tables / RPCs: supabase/migrations/20280410000000_voice_autopilot.sql
 *   Evaluator:     supabase/functions/voice-autopilot-run   (hourly cron + "Evaluate now")
 *   QA scorer:     supabase/functions/csr-call-qa
 *   Rules:         supabase/functions/_shared/voice-autopilot/*, _shared/csr-qa/qa.ts (shared with the Edge Functions)
 *
 * Tenant scoping is enforced by RLS (get_account_owner_id() + can_edit_call_scripts() / can_view_csr_qa());
 * this file never passes an owner id. Browsers can read experiments / looks / audit but cannot write them.
 */

import { supabase } from '@/lib/supabase';
import type { ExperimentDimension } from '../../supabase/functions/_shared/voice-autopilot/locks';
import type { MetricId, Prereg, Evaluation } from '../../supabase/functions/_shared/voice-autopilot/decision';
import type { WeeklyReport } from '../../supabase/functions/_shared/voice-autopilot/report';
import type { BetaPrior } from '../../supabase/functions/_shared/voice-autopilot/stats';
import { priorFromPool } from '../../supabase/functions/_shared/voice-autopilot/stats';
import type { QaCoachKey, QaDimension } from '../../supabase/functions/_shared/csr-qa/qa';

export * from '../../supabase/functions/_shared/voice-autopilot/locks';
export * from '../../supabase/functions/_shared/voice-autopilot/stats';
export * from '../../supabase/functions/_shared/voice-autopilot/decision';
export * from '../../supabase/functions/_shared/voice-autopilot/report';
export * from '../../supabase/functions/_shared/csr-qa/qa';

// ============================================================ types
export type AutopilotModeSetting = 'off' | 'suggest' | 'auto';
export interface AutopilotSettings {
  mode: AutopilotModeSetting;
  max_traffic_pct: number;
  max_auto_promotions_per_week: number;
  pooled_priors_opt_in: boolean;
}
export const DEFAULT_SETTINGS: AutopilotSettings = { mode: 'suggest', max_traffic_pct: 20, max_auto_promotions_per_week: 1, pooled_priors_opt_in: false };

export type ExperimentStatus = 'running' | 'awaiting_approval' | 'promoted' | 'rolled_back' | 'stopped' | 'inconclusive';
export interface VoiceExperiment {
  id: string;
  script_id: string;
  scenario: string;
  name: string;
  hypothesis: string | null;
  dimension: ExperimentDimension;
  control_version_id: string;
  challenger_version_id: string;
  traffic_pct: number;
  prereg: Prereg;
  status: ExperimentStatus;
  last_look_done: number;
  started_at: string;
  concluded_at: string | null;
  conclusion: Record<string, unknown> | null;
}
export interface VoiceExperimentLook {
  id: string;
  experiment_id: string;
  look: number;
  n_control: number;
  n_challenger: number;
  decision: string;
  result: Evaluation;
  created_at: string;
}
export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_kind: 'user' | 'system';
  event: string;
  script_id: string | null;
  experiment_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RegistrationInput {
  dimension: ExperimentDimension;
  name: string;
  hypothesis: string;
  primaryMetric: MetricId;
  nMaxPerArm: number;
  /** Fraction (0.03 = 3 points). */
  minEffect: number;
  waived: MetricId[];
}

// ============================================================ settings
export async function fetchSettings(): Promise<AutopilotSettings> {
  const { data, error } = await supabase.from('voice_autopilot_settings').select('mode, max_traffic_pct, max_auto_promotions_per_week, pooled_priors_opt_in').maybeSingle();
  if (error) throw error;
  return (data as AutopilotSettings | null) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(next: AutopilotSettings): Promise<AutopilotSettings> {
  const { data, error } = await supabase
    .from('voice_autopilot_settings')
    .upsert({ ...next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select('mode, max_traffic_pct, max_auto_promotions_per_week, pooled_priors_opt_in')
    .single();
  if (error) throw error;
  return data as AutopilotSettings;
}

// ============================================================ experiments
export async function fetchExperiments(scriptId: string): Promise<VoiceExperiment[]> {
  const { data, error } = await supabase.from('voice_experiments').select('*').eq('script_id', scriptId).order('started_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data as VoiceExperiment[]) ?? [];
}

export async function fetchLooks(experimentId: string): Promise<VoiceExperimentLook[]> {
  const { data, error } = await supabase.from('voice_experiment_looks').select('*').eq('experiment_id', experimentId).order('look', { ascending: true });
  if (error) throw error;
  return (data as VoiceExperimentLook[]) ?? [];
}

export async function fetchAudit(scriptId: string, limit = 50): Promise<AuditEntry[]> {
  const { data, error } = await supabase.from('voice_autopilot_audit').select('*').eq('script_id', scriptId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as AuditEntry[]) ?? [];
}

/** Pre-registers and starts an experiment (the database freezes the plan and sets the traffic split). */
export async function startRegisteredExperiment(scriptId: string, challengerVersionId: string, pct: number, reg: RegistrationInput): Promise<string> {
  const { data, error } = await supabase.rpc('voice_experiment_start', {
    p_script_id: scriptId,
    p_challenger_version_id: challengerVersionId,
    p_dimension: reg.dimension,
    p_name: reg.name,
    p_hypothesis: reg.hypothesis || null,
    p_primary_metric: reg.primaryMetric,
    p_n_max: Math.round(reg.nMaxPerArm),
    p_min_effect: reg.minEffect,
    p_traffic_pct: Math.round(pct),
    p_waived: reg.waived,
  });
  if (error) throw error;
  return data as string;
}

export async function concludeExperiment(experimentId: string, action: 'promote' | 'stop' | 'rollback', note?: string): Promise<string> {
  const { data, error } = await supabase.rpc('voice_experiment_conclude', { p_experiment_id: experimentId, p_action: action, p_conclusion: note ? { note } : {} });
  if (error) throw error;
  return data as string;
}

async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const { data, error } = await supabase.functions.invoke(name, { body, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (error) throw error;
  return data as T;
}

export const evaluateNow = () => invokeFn<{ processed: number; results: { id: string; outcome: string }[] }>('voice-autopilot-run', { action: 'evaluate' });
export async function fetchWeeklyReport(): Promise<WeeklyReport> {
  return (await invokeFn<{ report: WeeklyReport }>('voice-autopilot-run', { action: 'weekly_report' })).report;
}

/** Opt-in pooled prior for this scenario+metric; flat prior (and `pooled: false`) when not enough accounts contributed. */
export async function fetchPooledPrior(scenario: string, metric: MetricId): Promise<{ prior: BetaPrior; pooled: boolean }> {
  const { data, error } = await supabase.rpc('get_voice_pooled_prior', { p_scenario: scenario, p_metric: metric });
  if (error) throw error;
  const row = (data as { successes: number; trials: number; accounts: number }[] | null)?.[0] ?? null;
  const prior = priorFromPool(row ? { successes: Number(row.successes), trials: Number(row.trials), accounts: Number(row.accounts) } : null);
  return { prior, pooled: !!row && Number(row.accounts) >= 10 };
}

// ============================================================ human CSR QA
export interface CsrQaSettings { enabled: boolean; employee_transparency: boolean; retention_days: number; policy_ack_at: string | null }
export const DEFAULT_QA_SETTINGS: CsrQaSettings = { enabled: false, employee_transparency: false, retention_days: 90, policy_ack_at: null };

export interface CsrQaReview {
  id: string;
  call_id: string;
  agent_id: string | null;
  call_at: string;
  scenario: string | null;
  after_hours: boolean;
  language: string | null;
  rubric: string;
  scores: Record<QaDimension, number | null>;
  overall: number | null;
  clips: { startTurn: number; endTurn: number; note: 'strength' | 'improve'; dimension: QaDimension }[];
  coaching: QaCoachKey[];
  status: 'auto' | 'human_reviewed';
}

export async function fetchQaSettings(): Promise<CsrQaSettings> {
  const { data, error } = await supabase.from('csr_qa_settings').select('enabled, employee_transparency, retention_days, policy_ack_at').maybeSingle();
  if (error) throw error;
  return (data as CsrQaSettings | null) ?? DEFAULT_QA_SETTINGS;
}

export async function saveQaSettings(next: Pick<CsrQaSettings, 'enabled' | 'employee_transparency' | 'retention_days'>, acknowledgePolicy: boolean): Promise<CsrQaSettings> {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('csr_qa_settings')
    .upsert({ ...next, updated_at: new Date().toISOString(), ...(acknowledgePolicy ? { policy_ack_at: new Date().toISOString(), policy_ack_by: u.user?.id ?? null } : {}) }, { onConflict: 'user_id' })
    .select('enabled, employee_transparency, retention_days, policy_ack_at')
    .single();
  if (error) throw error;
  return data as CsrQaSettings;
}

export async function fetchQaReviews(limit = 200): Promise<CsrQaReview[]> {
  const { data, error } = await supabase
    .from('csr_qa_reviews')
    .select('id, call_id, agent_id, call_at, scenario, after_hours, language, rubric, scores, overall, clips, coaching, status')
    .order('call_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as CsrQaReview[]) ?? [];
}

export async function fetchAgentNames(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('team_members').select('id, member_name, member_email');
  if (error) throw error;
  return new Map(((data as { id: string; member_name: string | null; member_email: string }[]) ?? []).map((m) => [m.id, m.member_name || m.member_email]));
}

export const runQaScoring = (callIds?: string[]) => invokeFn<{ scored: number; skipped: number }>('csr-call-qa', callIds?.length ? { call_ids: callIds } : {});

export async function markQaReviewed(reviewId: string): Promise<void> {
  const { error } = await supabase.rpc('csr_qa_mark_reviewed', { p_review_id: reviewId });
  if (error) throw error;
}
