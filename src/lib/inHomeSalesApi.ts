/**
 * In-home sales — Supabase access. Every call is a SECURITY DEFINER RPC that
 * resolves the account owner server-side (quotes are owner-only under RLS, so
 * comfort advisors who are team members cannot read them directly).
 */

import { supabase } from '@/lib/supabase';
import { signPaths } from '@/lib/galleryApi';
import { createSignatureRequest, recordSignatureConsent, submitSignature, type SignatureType } from '@/lib/signatures';
import { newRequestId } from '@/lib/inPersonPayments';
import {
  SalesError,
  type PerformancePayload,
  type PresentableQuote,
  type PresentableTemplate,
  type PresentationPayload,
  type SalesAccess,
  type SalesAppointment,
  type SalesTeamMember,
} from '@/lib/inHomeSales';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new SalesError(error.message);
  return data as T;
}

export const getSalesAccess = () => rpc<SalesAccess>('get_my_sales_access');
export const listSalesTeam = () => rpc<SalesTeamMember[]>('list_sales_team');
export const setComfortAdvisor = (memberId: string, value: boolean) =>
  rpc<null>('set_comfort_advisor', { p_member_id: memberId, p_value: value });

export interface NewAppointmentInput {
  customerName: string;
  phone?: string;
  address?: string;
  scheduledAt?: string | null;
  advisorMemberId?: string | null;
  leadId?: string | null;
  customerId?: string | null;
  notes?: string;
}

export const createSalesAppointment = (i: NewAppointmentInput) =>
  rpc<string>('create_sales_appointment', {
    p_customer_name: i.customerName,
    p_phone: i.phone ?? null,
    p_address: i.address ?? null,
    p_scheduled_at: i.scheduledAt ?? null,
    p_advisor_member_id: i.advisorMemberId ?? null,
    p_lead_id: i.leadId ?? null,
    p_customer_id: i.customerId ?? null,
    p_notes: i.notes ?? null,
  });

export const createSalesLeadFromJob = (jobId: string, reason: string, service?: string, preferredAt?: string | null) =>
  rpc<{ lead_id: string; appointment_job_id: string | null; duplicate: boolean }>('create_sales_lead_from_job', {
    p_job_id: jobId,
    p_reason: reason,
    p_service: service ?? null,
    p_preferred_at: preferredAt ?? null,
  });

export const listSalesAppointments = () => rpc<SalesAppointment[]>('list_sales_appointments', { p_limit: 150 });

export const listPresentableQuotes = (jobId: string) =>
  rpc<{ quotes: PresentableQuote[]; templates: PresentableTemplate[] }>('list_presentable_quotes', { p_job_id: jobId });

export const startSalesPresentation = (jobId: string, source: { quoteId?: string; templateId?: string }) =>
  rpc<string>('start_sales_presentation', {
    p_job_id: jobId,
    p_quote_id: source.quoteId ?? null,
    p_template_id: source.templateId ?? null,
  });

export const getSalesPresentation = (id: string) => rpc<PresentationPayload>('get_sales_presentation', { p_id: id });
export const markSalesPresented = (id: string) => rpc<null>('mark_sales_presented', { p_id: id });
export const closeSalesLost = (id: string, reason: string) => rpc<null>('close_sales_presentation_lost', { p_id: id, p_reason: reason });

export interface WonResult {
  install_job_id: string;
  total_cents: number;
  deposit_due_cents: number;
  duplicate: boolean;
}

export const closeSalesWon = (i: {
  id: string;
  optionId: string;
  signatureRequestId: string;
  depositCents: number;
  financingTermMonths: number | null;
}) =>
  rpc<WonResult>('close_sales_presentation_won', {
    p_id: i.id,
    p_option_id: i.optionId,
    p_signature_request_id: i.signatureRequestId,
    p_deposit_cents: i.depositCents,
    p_financing_term_months: i.financingTermMonths,
  });

export interface DepositResult {
  success: boolean;
  error?: string;
  duplicate?: boolean;
  balance_cents?: number;
}

export async function recordSaleDeposit(i: {
  presentationId: string;
  method: 'cash' | 'check';
  amountCents: number;
  clientRequestId?: string;
  checkNumber?: string;
  checkBank?: string;
  checkPayer?: string;
  tenderedCents?: number;
}): Promise<DepositResult> {
  const res = await rpc<DepositResult>('record_sale_deposit', {
    p_presentation_id: i.presentationId,
    p_method: i.method,
    p_amount_cents: i.amountCents,
    p_client_request_id: i.clientRequestId ?? newRequestId(),
    p_check_number: i.checkNumber ?? null,
    p_check_bank: i.checkBank ?? null,
    p_check_payer: i.checkPayer ?? null,
    p_tendered_cents: i.tenderedCents ?? null,
  });
  if (!res.success) throw new SalesError(res.error ?? 'unknown');
  return res;
}

export const getSalesPerformance = (start: string, end: string) =>
  rpc<PerformancePayload>('get_sales_performance', { p_start: start, p_end: end });

/** Customer job photos live in a private bucket: sign them for display. */
export async function signJobPhotoUrls(paths: string[]): Promise<Map<string, string>> {
  return signPaths(paths);
}

// ============================================================
// E-SIGNATURE ON THE TABLET (reuses the native e-signature system)
// ============================================================

export interface InHomeSignatureRequest {
  requestId: string;
  signerToken: string;
}

/**
 * Creates the signature request for THIS quote. The customer needs an email or
 * phone (the signing system requires one and sends them their copy).
 */
export async function createInHomeSignatureRequest(i: {
  quoteId: string;
  customerId: string | null;
  customerName: string;
  email: string;
  phone: string;
  title: string;
  summary: string;
}): Promise<InHomeSignatureRequest> {
  const email = i.email.trim();
  const phone = i.phone.trim();
  if (!email && !phone) throw new SalesError('A phone number or email is needed to send the customer their signed copy.');
  const res = await createSignatureRequest({
    document_type: 'quote',
    document_id: i.quoteId,
    customer_id: i.customerId,
    title: i.title,
    document_summary: i.summary,
    expires_in_days: 1,
    signers: [{ name: i.customerName, email: email || undefined, phone: phone || undefined, role: 'signer' }],
  });
  const url = res.signers[0]?.sign_url ?? '';
  const signerToken = url.split('/').pop() ?? '';
  if (!res.request?.id || !signerToken) throw new SalesError('Could not start the signature. Try again.');
  return { requestId: res.request.id, signerToken };
}

export async function submitInHomeSignature(
  req: InHomeSignatureRequest,
  signature: { type: SignatureType; data: string; typedFont?: string },
  signedName: string
): Promise<void> {
  recordSignatureConsent(req.signerToken);
  const res = await submitSignature(req.signerToken, { ...signature, signedName });
  if (!res.ok || !res.completed) throw new SalesError(res.error ?? 'Could not save the signature. Try again.');
}
