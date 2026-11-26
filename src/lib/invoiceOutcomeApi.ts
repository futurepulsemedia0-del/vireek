/**
 * Invoice outcome statements (Task E) — client data access. Pure rules live in supabase/functions/_shared/results-plan/*.
 * Reads go through RLS. Writes only through SECURITY DEFINER RPCs / edge functions. Not live-verified.
 */
import { supabase } from '@/lib/supabase';
import type { OutcomeSnapshot, StatementState } from '../../supabase/functions/_shared/results-plan/outcomeStatement';
import type { DisputeState } from '../../supabase/functions/_shared/results-plan/outcomeDispute';

export { validateReason, slaStatus } from '../../supabase/functions/_shared/results-plan/outcomeDispute';
export type { OutcomeSnapshot, StatementState, DisputeState };

export interface StatementRow {
  id: string; period: string; state: StatementState; currency: string; total_cents: number; base_fee_cents: number; outcome_fee_cents: number;
  approved_at: string | null; terms_version: number | null; snapshot: OutcomeSnapshot;
}
export interface LineRow { id: string; statement_id: string; invoice_id: string; recovered_cents: number; fee_cents: number; held: boolean }
export interface DisputeRow {
  id: string; line_id: string; invoice_id: string; reason: string; state: DisputeState; opened_at: string; ack_due_at: string; resolve_due_at: string;
  acknowledged_at: string | null; resolved_at: string | null; resolution_note: string | null;
}
export interface GlobalRow { feature_enabled: boolean; kill_switch: boolean }
export interface SettingsRow { enabled: boolean; kill_switch: boolean; enrolled_at: string | null; suspended_reason: string | null }

export type ApiErrorCode = 'already_contested' | 'contest_window_closed' | 'statement_not_contestable' | 'feature_disabled' | 'invalid_reason' | 'generic';
const KNOWN: ApiErrorCode[] = ['already_contested', 'contest_window_closed', 'statement_not_contestable', 'feature_disabled', 'invalid_reason'];
export function errorCode(err: { message?: string } | null | undefined): ApiErrorCode {
  const m = err?.message ?? '';
  return KNOWN.find((k) => m.includes(k)) ?? 'generic';
}

export const formatMoney = (cents: number, currency: string, locale: string): string => {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format((Number(cents) || 0) / 100); }
  catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`; }
};

export async function fetchGate(): Promise<{ global: GlobalRow | null; settings: SettingsRow | null }> {
  const [g, s] = await Promise.all([
    supabase.from('invoice_outcome_global').select('feature_enabled,kill_switch').maybeSingle(),
    supabase.from('invoice_outcome_settings').select('enabled,kill_switch,enrolled_at,suspended_reason').maybeSingle(),
  ]);
  if (g.error) throw g.error;
  if (s.error) throw s.error;
  return { global: g.data as GlobalRow | null, settings: s.data as SettingsRow | null };
}

export async function fetchStatements(): Promise<StatementRow[]> {
  const { data, error } = await supabase.from('invoice_outcome_statements')
    .select('id,period,state,currency,total_cents,base_fee_cents,outcome_fee_cents,approved_at,terms_version,snapshot').order('period', { ascending: false }).limit(24);
  if (error) throw error;
  return (data ?? []) as StatementRow[];
}

export async function fetchDetail(statementId: string): Promise<{ lines: LineRow[]; disputes: DisputeRow[]; billableCents: number | null }> {
  const [l, d, b] = await Promise.all([
    supabase.from('invoice_outcome_statement_lines').select('id,statement_id,invoice_id,recovered_cents,fee_cents,held').eq('statement_id', statementId).order('created_at'),
    supabase.from('invoice_outcome_disputes').select('id,line_id,invoice_id,reason,state,opened_at,ack_due_at,resolve_due_at,acknowledged_at,resolved_at,resolution_note').eq('statement_id', statementId).order('opened_at', { ascending: false }),
    supabase.from('invoice_outcome_statement_billable').select('billable_cents').eq('statement_id', statementId).maybeSingle(),
  ]);
  if (l.error) throw l.error;
  if (d.error) throw d.error;
  return { lines: (l.data ?? []) as LineRow[], disputes: (d.data ?? []) as DisputeRow[], billableCents: b.data ? Number((b.data as { billable_cents: number }).billable_cents) : null };
}

export async function openDispute(lineId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('invoice_outcome_open_dispute', { p_line_id: lineId, p_reason: reason });
  if (error) throw error;
}
export async function withdrawDispute(id: string): Promise<void> {
  const { error } = await supabase.rpc('invoice_outcome_withdraw_dispute', { p_dispute_id: id });
  if (error) throw error;
}
export async function confirmInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('invoice_outcome_confirm', { p_invoice_id: invoiceId });
  if (error) throw error;
}

export async function downloadStatementPdf(statementId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('invoice-outcome-statement', { body: { action: 'pdf', statementId } });
  if (error || !data || typeof (data as { base64?: unknown }).base64 !== 'string') throw error ?? new Error('pdf_failed');
  const { base64, filename } = data as { base64: string; filename: string };
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- staff ----
export async function isStaff(): Promise<boolean> {
  const { data, error } = await supabase.rpc('invoice_outcome_is_staff');
  return !error && data === true;
}
export const staffTransition = async (statementId: string, to: 'approved' | 'invoiced' | 'paid' | 'void', stripeRecordId?: string): Promise<void> => {
  const { error } = await supabase.rpc('invoice_outcome_staff_transition', { p_statement_id: statementId, p_to: to, p_stripe_record_id: stripeRecordId ?? null });
  if (error) throw error;
};
export const staffDisputeSet = async (id: string, to: 'under_review' | 'upheld' | 'rejected' | 'withdrawn', note: string): Promise<void> => {
  const { error } = await supabase.rpc('invoice_outcome_staff_dispute_set', { p_dispute_id: id, p_to: to, p_note: note });
  if (error) throw error;
};
export const staffSetGlobal = async (feature: boolean, kill: boolean): Promise<void> => {
  const { error } = await supabase.rpc('invoice_outcome_staff_set_global', { p_feature_enabled: feature, p_kill_switch: kill });
  if (error) throw error;
};
export const staffSaveTerms = async (payload: Record<string, unknown>): Promise<string> => {
  const { data, error } = await supabase.rpc('invoice_outcome_staff_save_terms', { p: payload });
  if (error) throw error;
  return data as string;
};
export const staffApproveTerms = async (id: string, docVersion: number): Promise<void> => {
  const { error } = await supabase.rpc('invoice_outcome_staff_approve_terms', { p_terms_id: id, p_contract_doc_version: docVersion });
  if (error) throw error;
};
export async function staffCreateStripeTestRecord(statementId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('invoice-outcome-stripe-test', { body: { statementId } });
  if (error) throw error;
  return String((data as { recordId?: string }).recordId ?? '');
}
