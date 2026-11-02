/**
 * Shadow Mode — client library.
 *   Tables / RPCs: supabase/migrations/20280410000000_shadow_mode.sql (reads via RLS, writes via RPC only)
 *   Edge:          shadow-replay (refresh), shadow-report (HTML/PDF), shadow-digest (emails; scheduler only)
 *   Rules:         supabase/functions/_shared/shadow/logic.ts (shared, pure)
 */
import { supabase } from '@/lib/supabase';
import { SUPABASE_URL_FOR_FUNCTIONS } from '@/lib/shadowEnv';

export {
  SHADOW_TRIAL_DAYS, ESTIMATE_LABEL, trialDay, isTrialExpired,
} from '../../supabase/functions/_shared/shadow/logic';

export interface ShadowTrial {
  id: string; status: 'active' | 'completed' | 'cancelled' | 'went_live'; started_at: string; ends_at: string; timezone: string;
  replay_attested: boolean; caller_disclosure_configured: boolean; staff_notified: boolean; retention_days: number;
  avg_ticket_cents_override: number | null; close_rate_override: number | null;
  setup_items: { forwarding: boolean; hours: boolean; emergency_rules: boolean; test_call: boolean };
  last_replay_at: string | null; went_live_at: string | null;
}
export interface ShadowAction { kind: string; description: string; executed: false }
export interface ShadowCardRow {
  id: string; source: string; call_started_at: string; caller_last4: string | null;
  status: 'ready' | 'no_transcript' | 'analysis_failed' | 'blocked_consent'; block_reason: string | null;
  intent: string | null; emergency: boolean; would_book: boolean; capturable: boolean;
  transcript_redacted: string | null; actions: ShadowAction[];
  diff: { outcome?: string; answerSeconds?: number | null; afterHours?: boolean; note?: string };
  analysis: { slot_label?: string | null; service?: string | null };
}
export interface ShadowReviewRow {
  id: string; card_id: string; verdict: 'good' | 'bad'; severity: 'minor' | 'critical'; category: string;
  corrected_text: string | null; proposal_target: 'none' | 'faq' | 'script'; proposal_question: string | null;
  proposal_status: 'none' | 'pending' | 'accepted' | 'rejected' | 'applied';
}
export interface ShadowStats {
  calls_seen: number; analyzed: number; blocked_consent: number; unanswered: number; slow_answers: number; after_hours: number;
  emergencies: number; capturable: number; reviewed: number; approved: number; open_critical: number; pending_proposals: number;
}

const fail = (e: { message?: string } | null, fallback: string) => new Error(e?.message || fallback);

export async function fetchTrial(): Promise<ShadowTrial | null> {
  const { data, error } = await supabase.from('shadow_trials').select('*').limit(1).maybeSingle();
  if (error) throw fail(error, 'Could not load the trial.');
  return (data as ShadowTrial | null) ?? null;
}
export async function startTrial(timezone: string): Promise<string> {
  const { data, error } = await supabase.rpc('shadow_start_trial', { p_timezone: timezone });
  if (error) throw fail(error, 'Could not start the trial.');
  return data as string;
}
export async function updateSettings(trialId: string, s: {
  replayAttested?: boolean; callerDisclosure?: boolean; staffNotified?: boolean; retentionDays?: number; avgTicketCents?: number | null;
}): Promise<void> {
  const { error } = await supabase.rpc('shadow_update_settings', {
    p_trial_id: trialId, p_replay_attested: s.replayAttested ?? null, p_caller_disclosure: s.callerDisclosure ?? null,
    p_staff_notified: s.staffNotified ?? null, p_retention_days: s.retentionDays ?? null,
    p_avg_ticket_cents: s.avgTicketCents === undefined ? null : s.avgTicketCents === null ? -1 : s.avgTicketCents,
  });
  if (error) throw fail(error, 'Could not save settings.');
}
export async function setSetupItem(trialId: string, key: keyof ShadowTrial['setup_items'], done: boolean): Promise<void> {
  const { error } = await supabase.rpc('shadow_set_setup_item', { p_trial_id: trialId, p_key: key, p_done: done });
  if (error) throw fail(error, 'Could not update the checklist.');
}
export async function fetchStats(trialId: string): Promise<ShadowStats> {
  const { data, error } = await supabase.rpc('shadow_trial_stats', { p_trial_id: trialId });
  if (error) throw fail(error, 'Could not load counters.');
  return data as ShadowStats;
}
export async function fetchCards(trialId: string, limit = 50): Promise<ShadowCardRow[]> {
  const { data, error } = await supabase.from('shadow_cards')
    .select('id, source, call_started_at, caller_last4, status, block_reason, intent, emergency, would_book, capturable, transcript_redacted, actions, diff, analysis')
    .eq('trial_id', trialId).order('call_started_at', { ascending: false }).limit(limit);
  if (error) throw fail(error, 'Could not load cards.');
  return (data ?? []) as ShadowCardRow[];
}
export async function fetchReviews(trialId: string): Promise<ShadowReviewRow[]> {
  const { data, error } = await supabase.from('shadow_reviews')
    .select('id, card_id, verdict, severity, category, corrected_text, proposal_target, proposal_question, proposal_status').eq('trial_id', trialId);
  if (error) throw fail(error, 'Could not load reviews.');
  return (data ?? []) as ShadowReviewRow[];
}
export async function submitReview(r: {
  cardId: string; verdict: 'good' | 'bad'; severity?: 'minor' | 'critical'; category?: string; correctedText?: string;
  proposalTarget?: 'none' | 'faq' | 'script'; proposalQuestion?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('shadow_submit_review', {
    p_card_id: r.cardId, p_verdict: r.verdict, p_severity: r.severity ?? 'minor', p_category: r.category ?? 'other',
    p_corrected_text: r.correctedText ?? null, p_proposal_target: r.proposalTarget ?? 'none', p_proposal_question: r.proposalQuestion ?? null,
  });
  if (error) throw fail(error, 'Could not save the review.');
}
export async function decideProposal(reviewId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('shadow_decide_proposal', { p_review_id: reviewId, p_accept: accept });
  if (error) throw fail(error, 'Could not record the decision.');
}
export async function applyFaq(reviewId: string): Promise<void> {
  const { error } = await supabase.rpc('shadow_apply_faq', { p_review_id: reviewId });
  if (error) throw fail(error, 'Could not add the FAQ.');
}
export async function goLive(trialId: string): Promise<void> {
  const { error } = await supabase.rpc('shadow_go_live', { p_trial_id: trialId });
  if (error) throw fail(error, 'Could not go live.');
}
export async function deleteShadowData(trialId: string): Promise<void> {
  const { error } = await supabase.rpc('shadow_delete_data', { p_trial_id: trialId });
  if (error) throw fail(error, 'Could not delete Shadow data.');
}
export async function refreshReplay(): Promise<{ processed: number; pending: number }> {
  const { data, error } = await supabase.functions.invoke('shadow-replay', { body: {} });
  if (error) throw fail(error, 'Could not refresh.');
  return data as { processed: number; pending: number };
}
/** Fetches the report as a Blob (html | pdf) using the user's session. */
export async function fetchReportBlob(format: 'html' | 'pdf', locale: string): Promise<{ blob: Blob; preview: boolean }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');
  const res = await fetch(`${SUPABASE_URL_FOR_FUNCTIONS}/functions/v1/shadow-report`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, locale: locale.startsWith('es') ? 'es' : 'en' }),
  });
  if (!res.ok) throw new Error('Could not build the report.');
  return { blob: await res.blob(), preview: res.headers.get('X-Shadow-Preview') === '1' };
}
