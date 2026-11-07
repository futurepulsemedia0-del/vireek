/**
 * Results Plan — client data access. Pure rules live in supabase/functions/_shared/results-plan/* (shared with the edge functions).
 * Reads go through RLS; writes only through edge functions / SECURITY DEFINER RPCs.
 */
import { supabase } from '@/lib/supabase';
import { statementCsv, summarize, type StatementLine, type Summary } from '../../supabase/functions/_shared/results-plan/statement';

export { statementCsv, summarize };
export type { StatementLine, Summary };
export { DISPUTE_WINDOW_DAYS, disputeWindowOpen } from '../../supabase/functions/_shared/results-plan/dispute';

export type ChargeStatus = 'pending' | 'posted' | 'failed' | 'voided' | 'credited';
export interface ChargeRow {
  id: string; job_id: string; status: ChargeStatus; job_type: string | null; verified_at: string; month: string;
  list_price_cents: number | null; amount_cents: number | null; bound_by: string | null; posted_at: string | null; created_at: string;
}
export interface LedgerRow { id: number; seq: number; job_id: string | null; event_type: string; rule_version: string; evidence: Record<string, unknown>; hash: string; created_at: string }
export interface DisputeRow { id: string; charge_id: string; reason: string; status: 'open' | 'auto_credited' | 'upheld' | 'credited_by_review'; decision_note: string | null; opened_at: string; resolved_at: string | null }
export interface AccountRow {
  user_id: string; status: 'draft' | 'active' | 'paused' | 'ended'; billing_level: string; existing_work_window_days: number; duplicate_window_hours: number;
  cancel_window_hours: number; monthly_cap_cents: number | null; never_exceed_flat: boolean; flat_plan_cents: number | null; opted_in_at: string | null; terms_id: string | null; paused_reason: string | null;
}
export interface TermsRow {
  id: string; model: 'hybrid' | 'per_job'; currency: string; base_fee_cents: number; per_job_cents: number; tier_price_cents: Record<string, number>;
  monthly_floor_cents: number; monthly_cap_cents: number | null; guarantee_days: number; guarantee_cap_cents: number | null; trial_days: number; rule_version: string;
}

export const currentMonth = () => new Date().toISOString().slice(0, 7);
export const formatMoney = (cents: number, currency = 'USD') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
};

export async function fetchAccount(): Promise<{ account: AccountRow | null; terms: TermsRow | null }> {
  const { data: account } = await supabase.from('results_plan_accounts').select('*').maybeSingle();
  let terms: TermsRow | null = null;
  if (account && (account as AccountRow).terms_id) {
    const { data } = await supabase.from('results_plan_pricing_terms').select('*').eq('id', (account as AccountRow).terms_id as string).maybeSingle();
    terms = (data as TermsRow | null) ?? null;
  }
  return { account: (account as AccountRow | null) ?? null, terms };
}
export async function fetchCharges(month: string): Promise<ChargeRow[]> {
  const { data, error } = await supabase.from('results_plan_charges').select('id,job_id,status,job_type,verified_at,month,list_price_cents,amount_cents,bound_by,posted_at,created_at').eq('month', month).order('verified_at', { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as ChargeRow[];
}
export async function fetchLedgerForJob(jobId: string): Promise<LedgerRow[]> {
  const { data, error } = await supabase.from('proof_ledger').select('id,seq,job_id,event_type,rule_version,evidence,hash,created_at').eq('job_id', jobId).order('seq', { ascending: true }).limit(50);
  if (error) throw error;
  return (data ?? []) as LedgerRow[];
}
export async function fetchDisputes(): Promise<DisputeRow[]> {
  const { data, error } = await supabase.from('results_plan_disputes').select('id,charge_id,reason,status,decision_note,opened_at,resolved_at').order('opened_at', { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as DisputeRow[];
}
/** Live evidence under RLS (never copied into the immutable ledger): call timestamp, short excerpt, recording link. */
export async function fetchCallEvidence(jobId: string): Promise<{ call_datetime: string; transcript: string | null; recording_url: string | null } | null> {
  const { data: job } = await supabase.from('jobs').select('call_id').eq('id', jobId).maybeSingle();
  const callId = (job as { call_id: string | null } | null)?.call_id;
  if (!callId) return null;
  const { data } = await supabase.from('calls').select('call_datetime,transcript,recording_url').eq('id', callId).maybeSingle();
  return (data as { call_datetime: string; transcript: string | null; recording_url: string | null } | null) ?? null;
}
export async function verifyChain(userId: string): Promise<{ ok: boolean; checked: number; first_bad_seq: number | null }> {
  const { data, error } = await supabase.rpc('proof_ledger_verify', { p_user: userId });
  if (error) throw error;
  return data as { ok: boolean; checked: number; first_bad_seq: number | null };
}
export async function openDispute(chargeId: string, reason: string): Promise<{ outcome: 'auto_credited' | 'in_review'; why?: string }> {
  const { data, error } = await supabase.rpc('rp_open_dispute', { p_charge: chargeId, p_reason: reason });
  if (error) throw error;
  return data as { outcome: 'auto_credited' | 'in_review'; why?: string };
}
export async function flagJob(jobId: string, flag: 'spam' | 'wrong_number' | 'test', note: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { data: owner } = await supabase.rpc('get_account_owner_id');
  if (!u.user || !owner) throw new Error('auth');
  const { error } = await supabase.from('results_plan_job_flags').insert({ user_id: owner as string, job_id: jobId, flag, source: 'owner', note: note.slice(0, 500) || null });
  if (error) throw error;
}
async function callEnroll(body: Record<string, unknown>): Promise<{ ok?: boolean; url?: string; error?: string; flat_plan_cents?: number | null }> {
  const { data, error } = await supabase.functions.invoke('results-plan-enroll', { body });
  if (error) {
    let msg = 'Request failed';
    try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = String(j.error); } catch { /* keep default */ }
    return { error: msg };
  }
  return data as { ok?: boolean; url?: string; error?: string };
}
export const enroll = (neverExceedFlat: boolean) => callEnroll({ action: 'enroll', never_exceed_flat: neverExceedFlat });
export const startCheckout = (confirm: boolean) => callEnroll({ action: 'start_checkout', confirm });
export const switchToFlat = (priceId: string) => callEnroll({ action: 'switch_to_flat', price_id: priceId });

export function chargesToLines(charges: ChargeRow[], label: (jobId: string) => string): StatementLine[] {
  return charges.map((c) => ({
    chargeId: c.id, jobId: c.job_id, verifiedAt: c.verified_at, customerLabel: label(c.job_id), jobType: c.job_type, ruleVersion: 'rp-rules-v1',
    amountCents: c.amount_cents ?? 0, listPriceCents: c.list_price_cents ?? c.amount_cents ?? 0, status: c.status === 'failed' ? 'pending' : c.status, estimatedRevenueCents: null,
  }));
}
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- staff ----
export interface StaffOverviewRow { user_id: string; company_name: string | null; status: string; verified_jobs: number; billed_cents: number; credited_cents: number; base_fee_cents: number; open_disputes: number; high_flags: number }
export async function staffOverview(month: string): Promise<StaffOverviewRow[]> {
  const { data, error } = await supabase.rpc('rp_staff_overview', { p_month: month });
  if (error) throw error;
  return (data ?? []) as StaffOverviewRow[];
}
export async function staffOpenDisputes(): Promise<Array<DisputeRow & { user_id: string }>> {
  const { data, error } = await supabase.from('results_plan_disputes').select('id,user_id,charge_id,reason,status,decision_note,opened_at,resolved_at').eq('status', 'open').order('opened_at').limit(100);
  if (error) throw error;
  return (data ?? []) as Array<DisputeRow & { user_id: string }>;
}
export async function staffFlags(): Promise<Array<{ id: string; user_id: string; code: string; severity: string; detail: string; week_start: string }>> {
  const { data, error } = await supabase.from('results_plan_flags').select('id,user_id,code,severity,detail,week_start').is('resolved_at', null).order('week_start', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; user_id: string; code: string; severity: string; detail: string; week_start: string }>;
}
export async function staffPendingJobFlags(): Promise<Array<{ id: string; user_id: string; job_id: string; flag: string; note: string | null }>> {
  const { data, error } = await supabase.from('results_plan_job_flags').select('id,user_id,job_id,flag,note').eq('source', 'owner').is('accepted_at', null).is('rejected_at', null).limit(100);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; user_id: string; job_id: string; flag: string; note: string | null }>;
}
export const staffResolveDispute = async (id: string, uphold: boolean, note: string) => { const { error } = await supabase.rpc('rp_staff_resolve_dispute', { p_id: id, p_uphold: uphold, p_note: note }); if (error) throw error; };
export const staffResolveJobFlag = async (id: string, accept: boolean) => { const { error } = await supabase.rpc('rp_staff_resolve_job_flag', { p_id: id, p_accept: accept }); if (error) throw error; };
export const staffSetStatus = async (userId: string, status: 'paused' | 'active', reason: string) => { const { error } = await supabase.rpc('rp_staff_set_status', { p_user: userId, p_status: status, p_reason: reason }); if (error) throw error; };
