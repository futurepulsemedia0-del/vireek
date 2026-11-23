import { supabase } from '@/lib/supabase';
import {
  cleanPayoutError,
  parseAgreements,
  parsePayouts,
  parseStatement,
  type AgreementRow,
  type PartnerStatement,
  type PayoutRow,
} from '@/lib/partnerStatement';

export class PartnerPayoutError extends Error {
  constructor(message: string, readonly forbidden: boolean) {
    super(message);
  }
}

// Every RPC below re-checks is_vireek_staff() in the database; the route guard is only a convenience.
function fail(error: { message: string; code?: string }): never {
  throw new PartnerPayoutError(cleanPayoutError(error.message), error.code === '42501');
}

export async function fetchPayouts(period: string | null, partnerId: string | null = null): Promise<PayoutRow[]> {
  const { data, error } = await supabase.rpc('staff_partner_payouts', { p_period: period, p_partner_id: partnerId, p_limit: 200 });
  if (error) fail(error);
  return parsePayouts(data);
}

export async function fetchStatement(payoutId: string): Promise<PartnerStatement> {
  const { data, error } = await supabase.rpc('staff_partner_statement', { p_payout_id: payoutId });
  if (error) fail(error);
  const parsed = parseStatement(data);
  if (!parsed) throw new PartnerPayoutError('The statement could not be read.', false);
  return parsed;
}

export async function fetchAgreements(partnerId: string): Promise<AgreementRow[]> {
  const { data, error } = await supabase.rpc('staff_partner_agreements', { p_partner_id: partnerId });
  if (error) fail(error);
  return parseAgreements(data);
}

export interface CalculationSummary {
  period_start: string;
  period_end: string;
  created: number;
  updated: number;
  locked: number;
  skipped: number;
}

export async function calculatePayouts(period: string, partnerId: string | null = null): Promise<CalculationSummary> {
  const { data, error } = await supabase.rpc('calculate_partner_payouts', { p_period: period, p_partner_id: partnerId });
  if (error) fail(error);
  const d = (data ?? {}) as Partial<CalculationSummary>;
  return {
    period_start: String(d.period_start ?? period),
    period_end: String(d.period_end ?? ''),
    created: Number(d.created ?? 0),
    updated: Number(d.updated ?? 0),
    locked: Number(d.locked ?? 0),
    skipped: Number(d.skipped ?? 0),
  };
}

export async function approvePayout(payoutId: string): Promise<void> {
  const { error } = await supabase.rpc('approve_partner_payout', { p_payout_id: payoutId });
  if (error) fail(error);
}

export async function markPayoutPaid(payoutId: string, method: string, reference: string): Promise<void> {
  const { error } = await supabase.rpc('mark_partner_payout_paid', { p_payout_id: payoutId, p_method: method, p_reference: reference });
  if (error) fail(error);
}

export async function voidPayout(payoutId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_partner_payout', { p_payout_id: payoutId, p_reason: reason });
  if (error) fail(error);
}

export async function createAgreementDraft(input: {
  partnerId: string;
  ratePct: number;
  months: number;
  minPayoutCents: number;
  effectiveFrom: string;
  documentRef: string;
  notes: string;
}): Promise<void> {
  const { error } = await supabase.rpc('create_partner_agreement_draft', {
    p_partner_id: input.partnerId,
    p_rate: input.ratePct,
    p_months: input.months,
    p_min_payout_cents: input.minPayoutCents,
    p_effective_from: input.effectiveFrom,
    p_document_ref: input.documentRef || null,
    p_notes: input.notes || null,
  });
  if (error) fail(error);
}

export async function activateAgreement(agreementId: string, reason: string, counselConfirmed: boolean): Promise<void> {
  const { error } = await supabase.rpc('activate_partner_agreement', {
    p_agreement_id: agreementId,
    p_reason: reason,
    p_counsel_confirmed: counselConfirmed,
  });
  if (error) fail(error);
}

export async function terminateAgreement(agreementId: string, effectiveTo: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('terminate_partner_agreement', {
    p_agreement_id: agreementId,
    p_effective_to: effectiveTo,
    p_reason: reason,
  });
  if (error) fail(error);
}
