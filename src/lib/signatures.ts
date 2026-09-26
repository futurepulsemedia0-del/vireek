/**
 * Native E-Signature — shared domain logic.
 *
 * One signing system for every document type in Vireek (quotes,
 * commercial contracts, invoices, or a one-off custom document) instead
 * of a parallel flow per feature. Server-side counterpart lives in
 * supabase/migrations/20261201000000_native_esignature.sql.
 *
 * Reads (dashboard side) go through normal RLS-scoped table queries.
 * The public /sign/:token page never touches tables directly — creation
 * goes through the send-signature-request Edge Function, and every
 * public read/write goes through get_signature_request_for_signer (safe
 * to call directly, read-only) or the sign-document-action Edge
 * Function (view/consent/sign/decline — needs the real request IP for
 * the audit trail, which only the Edge Function can see).
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type SignatureDocumentType = 'quote' | 'contract' | 'invoice' | 'custom';

export type SignatureRequestStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'partially_signed'
  | 'completed'
  | 'declined'
  | 'voided'
  | 'expired';

export type SignerRole = 'signer' | 'company_rep' | 'witness';

export type SignerStatus = 'pending' | 'viewed' | 'signed' | 'declined';

export type SignatureType = 'drawn' | 'typed';

export interface SignatureSigner {
  id: string;
  request_id: string;
  role: SignerRole;
  signing_order: number;
  name: string;
  email: string | null;
  phone: string | null;
  signer_token: string;
  status: SignerStatus;
  signature_type: SignatureType | null;
  signature_data: string | null;
  typed_font: string | null;
  signed_name: string | null;
  consented_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface SignatureRequest {
  id: string;
  user_id: string;
  customer_id: string | null;
  document_type: SignatureDocumentType;
  document_id: string | null;
  title: string;
  document_summary: string | null;
  document_url: string | null;
  consent_text: string;
  status: SignatureRequestStatus;
  sent_at: string | null;
  completed_at: string | null;
  voided_at: string | null;
  decline_reason: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  signers?: SignatureSigner[];
}

export interface SignatureEvent {
  id: string;
  request_id: string;
  signer_id: string | null;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PublicSignatureInfo {
  request_id: string;
  title: string;
  document_type: SignatureDocumentType;
  document_summary: string | null;
  document_url: string | null;
  consent_text: string;
  request_status: SignatureRequestStatus;
  expires_at: string | null;
  business_name: string | null;
  signer_id: string;
  signer_name: string;
  signer_role: SignerRole;
  signer_status: SignerStatus;
  signing_order: number;
  other_signers: { name: string; role: SignerRole; status: SignerStatus }[];
}

// ============================================================
// LABELS
// ============================================================

export const SIGNATURE_STATUS_LABELS: Record<SignatureRequestStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  partially_signed: 'Partially signed',
  completed: 'Completed',
  declined: 'Declined',
  voided: 'Voided',
  expired: 'Expired',
};

export const SIGNATURE_STATUS_COLORS: Record<SignatureRequestStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-accent/10 text-accent',
  viewed: 'bg-accent/10 text-accent',
  partially_signed: 'bg-warning-500/10 text-warning-500',
  completed: 'bg-success-500/10 text-success-500',
  declined: 'bg-danger/10 text-danger',
  voided: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-bg-tertiary text-text-secondary',
};

export const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  signer: 'Signer',
  company_rep: 'Company representative',
  witness: 'Witness',
};

// ============================================================
// DASHBOARD SIDE (RLS-scoped, normal table access)
// ============================================================

export async function listSignatureRequests(documentType?: SignatureDocumentType, documentId?: string): Promise<SignatureRequest[]> {
  let query = supabase.from('signature_requests').select('*, signers:signature_signers(*)').order('created_at', { ascending: false });
  if (documentType) query = query.eq('document_type', documentType);
  if (documentId) query = query.eq('document_id', documentId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as SignatureRequest[]) || [];
}

export async function getSignatureRequest(id: string): Promise<SignatureRequest | null> {
  const { data, error } = await supabase.from('signature_requests').select('*, signers:signature_signers(*)').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as SignatureRequest | null;
}

export async function getSignatureEvents(requestId: string): Promise<SignatureEvent[]> {
  const { data, error } = await supabase.from('signature_events').select('*').eq('request_id', requestId).order('created_at', { ascending: true });
  if (error) throw error;
  return (data as SignatureEvent[]) || [];
}

export async function voidSignatureRequest(id: string): Promise<void> {
  const { error } = await supabase.from('signature_requests').update({ status: 'voided', voided_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

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

export interface CreateSignatureRequestInput {
  document_type: SignatureDocumentType;
  document_id?: string | null;
  customer_id?: string | null;
  title: string;
  document_summary?: string;
  document_url?: string;
  consent_text?: string;
  expires_in_days?: number;
  signers: { name: string; email?: string; phone?: string; role?: SignerRole }[];
}

export interface CreateSignatureRequestResult {
  request: SignatureRequest;
  signers: { signer_id: string; sign_url: string; email_sent: boolean; sms_sent: boolean }[];
}

export async function createSignatureRequest(input: CreateSignatureRequestInput): Promise<CreateSignatureRequestResult> {
  const { data, error } = await supabase.functions.invoke('send-signature-request', { body: input });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not send the signature request. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.error));
  return data as CreateSignatureRequestResult;
}

export function getSignLink(signerToken: string): string {
  return `${window.location.origin}/sign/${signerToken}`;
}

// ============================================================
// PUBLIC SIDE (/sign/:token — no auth)
// ============================================================

export async function fetchSignatureRequestForSigner(signerToken: string): Promise<PublicSignatureInfo | null> {
  const { data, error } = await supabase.rpc('get_signature_request_for_signer', { p_signer_token: signerToken });
  if (error || !data || data.length === 0) return null;
  return data[0] as PublicSignatureInfo;
}

async function callSignAction(body: Record<string, unknown>): Promise<{ ok: boolean; request_completed?: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('sign-document-action', { body });
  if (error) return { ok: false, error: await functionErrorMessage(error, 'Could not reach the signing server.') };
  if (data?.error) return { ok: false, error: String(data.error) };
  return data as { ok: boolean; request_completed?: boolean };
}

export function recordSignatureView(signerToken: string): void {
  void callSignAction({ action: 'view', signer_token: signerToken });
}

export function recordSignatureConsent(signerToken: string): void {
  void callSignAction({ action: 'consent', signer_token: signerToken });
}

export async function submitSignature(
  signerToken: string,
  signature: { type: SignatureType; data: string; typedFont?: string; signedName?: string }
): Promise<{ ok: boolean; completed: boolean; error?: string }> {
  const res = await callSignAction({
    action: 'sign',
    signer_token: signerToken,
    signature_type: signature.type,
    signature_data: signature.data,
    typed_font: signature.typedFont,
    signed_name: signature.signedName,
  });
  return { ok: res.ok, completed: Boolean(res.request_completed), error: res.error };
}

export async function declineSignature(signerToken: string, reason: string): Promise<boolean> {
  const res = await callSignAction({ action: 'decline', signer_token: signerToken, reason });
  return res.ok;
}
