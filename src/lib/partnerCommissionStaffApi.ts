import { supabase } from '@/lib/supabase';
import {
  cleanGuardrailMessage,
  parseLedger,
  parseOverview,
  type PartnerCommissionRow,
  type PartnerLedger,
} from '@/lib/partnerCommissionStaff';

export class PartnerCommissionError extends Error {
  constructor(message: string, readonly forbidden: boolean) {
    super(message);
  }
}

// Every RPC below re-checks is_vireek_staff() in the database; the route guard is only a convenience.
function fail(error: { message: string; code?: string }): never {
  throw new PartnerCommissionError(cleanGuardrailMessage(error.message), error.code === '42501');
}

export async function fetchPartnerOverview(): Promise<PartnerCommissionRow[]> {
  const { data, error } = await supabase.rpc('staff_partner_commission_overview');
  if (error) fail(error);
  return parseOverview(data);
}

export async function fetchPartnerLedger(partnerId: string): Promise<PartnerLedger> {
  const { data, error } = await supabase.rpc('staff_partner_ledger', { p_partner_id: partnerId, p_limit: 200 });
  if (error) fail(error);
  return parseLedger(data);
}

export async function setPartnerTerms(partnerId: string, rate: number, months: number, reason: string): Promise<void> {
  const { error } = await supabase.rpc('set_partner_commission_terms', {
    p_partner_id: partnerId,
    p_rate: rate,
    p_months: months,
    p_reason: reason,
  });
  if (error) fail(error);
}

export async function payPartner(partnerId: string): Promise<{ paid_cents: number; entries: number }> {
  const { data, error } = await supabase.rpc('pay_partner_approved_commissions', { p_partner_id: partnerId });
  if (error) fail(error);
  const d = (data ?? {}) as { paid_cents?: number; entries?: number };
  return { paid_cents: Number(d.paid_cents ?? 0), entries: Number(d.entries ?? 0) };
}

export async function voidLedgerEntry(entryId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_partner_commission_entry', { p_entry_id: entryId, p_reason: reason });
  if (error) fail(error);
}

export async function approveLegacyEstimate(referralId: string): Promise<void> {
  const { error } = await supabase.rpc('set_partner_referral_commission_status', { p_referral_id: referralId, p_status: 'approved' });
  if (error) fail(error);
}
