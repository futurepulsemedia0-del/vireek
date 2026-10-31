import { supabase } from '@/lib/supabase';

// Client API for Commercial Approval-to-Cash. All enforcement lives in the database
// (RLS + SECURITY DEFINER functions); this file only calls it and shapes the results.

export type CommercialStage =
  | 'draft' | 'blocked_needs_approval' | 'sent' | 'received' | 'approved' | 'rejected' | 'paid' | 'void';

export interface PrecheckReason {
  code: 'missing_po' | 'over_approved_amount' | 'missing_completion_proof';
  message: string;
  excess_cents?: number;
  invoice_total_cents?: number;
  previously_billed_cents?: number;
  approved_amount_cents?: number;
}

export interface PrecheckResult {
  applies: boolean;
  mode?: 'block' | 'warn';
  blocked: boolean;
  overridden?: boolean;
  reasons: PrecheckReason[];
  warnings: PrecheckReason[];
  approval_id?: string | null;
  total_cents?: number;
  approved_amount_cents?: number | null;
}

export interface CommercialApproval {
  id: string;
  customer_id: string | null;
  job_id: string | null;
  quote_id: string | null;
  po_number: string | null;
  work_order_number: string | null;
  approved_amount_cents: number;
  approval_source: string;
  evidence_storage_path: string | null;
  evidence_ref: string | null;
  approved_by_name: string;
  approved_at: string;
  status: 'active' | 'void';
  created_at: string;
}

export interface CommercialTracking {
  id: string;
  invoice_id: string;
  approval_id: string | null;
  stage: CommercialStage;
  block_reasons: PrecheckReason[];
  warnings: PrecheckReason[];
  rejection_reason: string | null;
  override_reason: string | null;
  override_at: string | null;
  stage_changed_at: string;
}

export interface CommercialEvent {
  id: string;
  event_type: string;
  from_stage: string | null;
  to_stage: string | null;
  reason: string | null;
  created_at: string;
}

export interface DemandDraft {
  id: string;
  body: string;
  disclaimer: string;
  status: 'pending_review' | 'reviewed' | 'dismissed';
  created_at: string;
}

export interface RecordApprovalInput {
  ownerId: string;
  customerId: string | null;
  jobId: string | null;
  quoteId: string | null;
  poNumber: string;
  workOrderNumber: string;
  approvedAmountCents: number;
  source: 'purchase_order' | 'work_order' | 'email' | 'portal' | 'verbal_logged' | 'other';
  evidenceRef: string;
  approvedByName: string;
  approvedAt: string;
  file: File | null;
}

const EVIDENCE_BUCKET = 'commercial-approvals';

/** Turns the trigger's "blocked_needs_approval: code, code" error into a readable message. */
export function describeSendError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  return msg.startsWith('blocked_needs_approval') ? msg : null;
}

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Request failed.');
}

export async function precheckInvoice(invoiceId: string): Promise<PrecheckResult> {
  const { data, error } = await supabase.rpc('commercial_precheck_invoice', { p_invoice_id: invoiceId });
  if (error) fail(error);
  return data as PrecheckResult;
}

export async function fetchCommercialState(invoiceId: string): Promise<{
  tracking: CommercialTracking | null;
  events: CommercialEvent[];
  draft: DemandDraft | null;
}> {
  const [t, e, d] = await Promise.all([
    supabase.from('commercial_invoice_tracking').select('*').eq('invoice_id', invoiceId).maybeSingle(),
    supabase.from('commercial_invoice_events').select('id, event_type, from_stage, to_stage, reason, created_at')
      .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(50),
    supabase.from('commercial_demand_drafts').select('id, body, disclaimer, status, created_at').eq('invoice_id', invoiceId).maybeSingle(),
  ]);
  if (t.error) fail(t.error);
  if (e.error) fail(e.error);
  if (d.error) fail(d.error);
  return { tracking: (t.data as CommercialTracking) ?? null, events: (e.data as CommercialEvent[]) ?? [], draft: (d.data as DemandDraft) ?? null };
}

export async function fetchApprovalsFor(opts: { customerId: string | null; jobId: string | null; quoteId: string | null }): Promise<CommercialApproval[]> {
  const ors = [
    opts.jobId && `job_id.eq.${opts.jobId}`,
    opts.quoteId && `quote_id.eq.${opts.quoteId}`,
    opts.customerId && `customer_id.eq.${opts.customerId}`,
  ].filter(Boolean) as string[];
  if (ors.length === 0) return [];
  const { data, error } = await supabase.from('commercial_approvals').select('*').or(ors.join(',')).order('approved_at', { ascending: false });
  if (error) fail(error);
  return (data as CommercialApproval[]) ?? [];
}

export async function isCommercialCustomer(customerId: string): Promise<boolean> {
  const { data, error } = await supabase.from('commercial_billing_profiles').select('id').eq('customer_id', customerId).maybeSingle();
  if (error) fail(error);
  return !!data;
}

export async function enableCommercialBilling(customerId: string): Promise<void> {
  const { error } = await supabase.from('commercial_billing_profiles').upsert({ customer_id: customerId }, { onConflict: 'user_id,customer_id', ignoreDuplicates: true });
  if (error) fail(error);
}

export async function recordApproval(input: RecordApprovalInput): Promise<void> {
  let path: string | null = null;
  if (input.file) {
    const safe = input.file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
    path = `${input.ownerId}/${crypto.randomUUID()}-${safe}`;
    const up = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, input.file, { contentType: input.file.type || undefined, upsert: false });
    if (up.error) fail(up.error);
  }
  const { error } = await supabase.from('commercial_approvals').insert({
    customer_id: input.customerId, job_id: input.jobId, quote_id: input.quoteId,
    po_number: input.poNumber.trim() || null, work_order_number: input.workOrderNumber.trim() || null,
    approved_amount_cents: input.approvedAmountCents, approval_source: input.source,
    evidence_storage_path: path, evidence_ref: input.evidenceRef.trim() || null,
    approved_by_name: input.approvedByName.trim(), approved_at: input.approvedAt,
  });
  if (error) fail(error);
}

export async function linkInvoiceApproval(invoiceId: string, approvalId: string): Promise<PrecheckResult> {
  const { data, error } = await supabase.rpc('commercial_link_invoice_approval', { p_invoice_id: invoiceId, p_approval_id: approvalId });
  if (error) fail(error);
  return data as PrecheckResult;
}

export async function overrideBlock(invoiceId: string, reason: string): Promise<PrecheckResult> {
  const { data, error } = await supabase.rpc('commercial_override_block', { p_invoice_id: invoiceId, p_reason: reason });
  if (error) fail(error);
  return data as PrecheckResult;
}

export async function setCommercialStage(invoiceId: string, to: 'received' | 'approved' | 'rejected' | 'sent', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('commercial_set_stage', { p_invoice_id: invoiceId, p_to: to, p_reason: reason ?? null });
  if (error) fail(error);
}

export async function reviewDraft(id: string, patch: { status?: 'reviewed' | 'dismissed'; body?: string }): Promise<void> {
  const { error } = await supabase.from('commercial_demand_drafts').update(patch).eq('id', id);
  if (error) fail(error);
}

export async function logPacketGenerated(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('commercial_log_packet', { p_invoice_id: invoiceId });
  if (error) fail(error);
}

export async function signedEvidenceUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, 300);
  if (error || !data) fail(error);
  return data.signedUrl;
}
