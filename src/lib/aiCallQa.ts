/**
 * AI call human review - client API + pure helpers.
 * Authorization, tenant scoping and the authoritative score/verdict live in the database
 * (see 20290312000100_ai_call_human_review.sql). previewScore() is a UI preview only.
 */

import { supabase } from '@/lib/supabase';

export interface Criterion { key: string; label: string; weight: number; description: string }
export interface ClaimedItem {
  item_id: string; call_id: string; call_at: string; stratum: 'random' | 'risk'; risk_flags: string[];
  summary: string | null; transcript: string; duration_seconds: number | null; is_emergency: boolean;
  rubric: { id: string; version: number; criteria: Criterion[] };
}
export type FeedbackTarget = 'prompt' | 'eval_case' | 'knowledge' | 'script';
export interface FeedbackDraft { target: FeedbackTarget; category: string; suggestion: string }
export interface FeedbackRow { id: string; review_id: string; target: FeedbackTarget; category: string; suggestion: string; status: 'open' | 'accepted' | 'rejected' | 'done'; created_at: string }
export interface QaSettings { enabled: boolean; random_rate: number; daily_cap: number; risk_rates: Record<string, number>; retention_days: number; policy_ack_at: string | null }
export interface ReportGroup { stratum?: string; flag?: string; reviewed: number; avg_overall: number | null; fail_rate: number | null }
export interface MonthlyReport {
  month: string; sampled: number; reviewed: number; pending_now: number; skipped: number; review_rate: number | null;
  avg_overall: number | null; pass_rate: number | null; critical_failures: number; low_sample: boolean;
  by_stratum: ReportGroup[]; by_risk_flag: ReportGroup[]; by_criterion: { criterion: string; scored: number; avg_score: number | null }[];
  feedback: { target: string; status: string; count: number }[];
}

export const RISK_LABELS: Record<string, string> = {
  emergency: 'Emergency', price_mismatch: 'Price mismatch', complaint: 'Complaint', price_quote: 'Price quote', human_transfer: 'Human transfer',
};
export const TARGET_LABELS: Record<FeedbackTarget, string> = { prompt: 'Prompt', eval_case: 'Eval case', knowledge: 'Knowledge base', script: 'Call script' };
export const MIN_SCORED = 3;

export type Scores = Record<string, number | null>;
export type Verdict = 'pass' | 'needs_improvement' | 'fail';

/** Mirrors ai_call_qa_submit_review(): 1 -> 0, 5 -> 100, weighted over scored criteria only. */
export function previewScore(criteria: Criterion[], scores: Scores): { overall: number | null; scored: number } {
  let num = 0, den = 0, scored = 0;
  for (const c of criteria) {
    const s = scores[c.key];
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 5) continue;
    num += (c.weight * (s - 1)) / 4; den += c.weight; scored++;
  }
  return { overall: scored >= MIN_SCORED && den > 0 ? Math.round((100 * num) / den) : null, scored };
}
export function verdictFor(overall: number, critical: boolean): Verdict {
  if (critical) return 'fail';
  return overall >= 80 ? 'pass' : overall >= 60 ? 'needs_improvement' : 'fail';
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthToDate(month: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : `${currentMonth()}-01`;
}

function fail(error: { message?: string } | null): never {
  const m = error?.message ?? '';
  if (/not allowed|only the account owner/i.test(m)) throw new Error('forbidden');
  if (/not claimed/i.test(m)) throw new Error('not_claimed');
  throw new Error('request_failed');
}

export async function claimNext(): Promise<ClaimedItem | null> {
  const { data, error } = await supabase.rpc('ai_call_qa_claim_next');
  if (error) fail(error);
  return (data as ClaimedItem | null) ?? null;
}
export async function releaseItem(itemId: string): Promise<void> {
  const { error } = await supabase.rpc('ai_call_qa_release', { p_item: itemId });
  if (error) fail(error);
}
export async function skipItem(itemId: string): Promise<void> {
  const { error } = await supabase.rpc('ai_call_qa_skip', { p_item: itemId });
  if (error) fail(error);
}
export async function submitReview(itemId: string, scores: Scores, critical: boolean, notes: string, feedback: FeedbackDraft[]) {
  const { data, error } = await supabase.rpc('ai_call_qa_submit_review', {
    p_item: itemId, p_scores: scores, p_critical: critical, p_notes: notes.trim() || null, p_feedback: feedback,
  });
  if (error) fail(error);
  return data as { review_id: string; overall: number; verdict: Verdict };
}
export async function fetchMonthlyReport(month: string): Promise<MonthlyReport> {
  const { data, error } = await supabase.rpc('ai_call_qa_get_monthly_report', { p_month: monthToDate(month) });
  if (error) fail(error);
  return data as MonthlyReport;
}
export async function fetchFeedback(): Promise<FeedbackRow[]> {
  const { data, error } = await supabase.from('ai_call_qa_feedback')
    .select('id, review_id, target, category, suggestion, status, created_at').order('created_at', { ascending: false }).limit(100);
  if (error) fail(error);
  return (data ?? []) as FeedbackRow[];
}
export async function setFeedbackStatus(id: string, status: FeedbackRow['status']): Promise<void> {
  const { error } = await supabase.rpc('ai_call_qa_set_feedback_status', { p_id: id, p_status: status });
  if (error) fail(error);
}
export async function fetchSettings(): Promise<QaSettings | null> {
  const { data, error } = await supabase.from('ai_call_qa_settings')
    .select('enabled, random_rate, daily_cap, risk_rates, retention_days, policy_ack_at').maybeSingle();
  if (error) fail(error);
  return (data as QaSettings | null) ?? null;
}
export async function saveSettings(s: { enabled: boolean; randomRate: number; dailyCap: number; riskRates: Record<string, number>; policyAck: boolean }) {
  const { error } = await supabase.rpc('ai_call_qa_set_settings', {
    p_enabled: s.enabled, p_random_rate: s.randomRate, p_daily_cap: s.dailyCap, p_risk_rates: s.riskRates, p_policy_ack: s.policyAck,
  });
  if (error) fail(error);
}
