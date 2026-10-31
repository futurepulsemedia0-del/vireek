// Thin typed wrappers over the warranty recovery RPCs (20280210000000_warranty_claim_recovery_workflow.sql).
// Status and payment can ONLY change through these functions: the database guard rejects direct table updates.
// Nothing here contacts a manufacturer; "submitted" records what the user did themselves.
import { supabase } from '@/lib/supabase';
import { warrantyErrorMessage, type WarrantyClaimPacket } from '@/lib/warrantyClaimRecovery';

export class WarrantyRecoveryError extends Error {
  constructor(public readonly raw: string) {
    super(warrantyErrorMessage(raw));
    this.name = 'WarrantyRecoveryError';
  }
}

export interface PaymentResult {
  id: string;
  status: 'credit_received';
  recovered_cents: number;
  claimed_cents: number | null;
  shortfall_cents: number | null;
}

export async function fetchClaimPacket(claimId: string): Promise<WarrantyClaimPacket> {
  const { data, error } = await supabase.rpc('warranty_claim_packet', { p_claim_id: claimId });
  if (error) throw new WarrantyRecoveryError(error.message);
  return data as WarrantyClaimPacket;
}

export async function approveForSubmission(claimId: string): Promise<void> {
  const { error } = await supabase.rpc('warranty_claim_transition', {
    p_claim_id: claimId, p_to: 'ready', p_confirm: true,
  });
  if (error) throw new WarrantyRecoveryError(error.message);
}

export async function markSubmitted(claimId: string, referenceNumber: string): Promise<void> {
  const { error } = await supabase.rpc('warranty_claim_transition', {
    p_claim_id: claimId, p_to: 'submitted', p_ref: referenceNumber, p_confirm: true,
  });
  if (error) throw new WarrantyRecoveryError(error.message);
}

export async function transitionClaim(
  claimId: string,
  to: 'needs_review' | 'denied' | 'expired' | 'closed',
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('warranty_claim_transition', {
    p_claim_id: claimId, p_to: to, p_note: note ?? null,
  });
  if (error) throw new WarrantyRecoveryError(error.message);
}

export async function recordPayment(
  claimId: string,
  amountCents: number,
  receivedOn: string | null,
  method: 'account_credit' | 'check' | 'ach' | 'other' | null,
): Promise<PaymentResult> {
  const { data, error } = await supabase.rpc('warranty_claim_record_payment', {
    p_claim_id: claimId, p_amount_cents: amountCents, p_received_on: receivedOn, p_method: method,
  });
  if (error) throw new WarrantyRecoveryError(error.message);
  return data as PaymentResult;
}
