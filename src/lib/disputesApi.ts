/**
 * Stripe Disputes — API layer (Supabase). RLS already scopes every read to the account owner;
 * the explicit `.eq('user_id', ownerId)` is defence-in-depth (accountOwnerId scoping).
 */

import { supabase } from '@/lib/supabase';
import {
  safeFileName,
  type DisputeEventRow,
  type DisputeStats,
  type EvidenceCategory,
  type DisputeEvidenceFile,
  type StripeDisputeRow,
} from '@/lib/disputes';

const DISPUTE_COLUMNS =
  'id, user_id, stripe_dispute_id, stripe_charge_id, payment_request_id, job_id, customer_name, amount_cents, currency, reason, network_reason_code, status, is_charge_refundable, evidence_due_by, has_evidence, past_due, submission_count, evidence_submitted_at, net_balance_cents, opened_at, closed_at, evidence_draft, last_event_type, updated_at';

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

export async function fetchDisputes(ownerId: string): Promise<StripeDisputeRow[]> {
  const { data, error } = await supabase
    .from('stripe_disputes')
    .select(DISPUTE_COLUMNS)
    .eq('user_id', ownerId)
    .order('opened_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as StripeDisputeRow[];
}

export async function fetchDisputeStats(days = 365): Promise<DisputeStats> {
  const { data, error } = await supabase.rpc('get_dispute_stats', { p_days: days });
  if (error) throw error;
  return data as DisputeStats;
}

export async function fetchDisputeDetail(
  ownerId: string,
  disputeId: string,
): Promise<{ files: DisputeEvidenceFile[]; events: DisputeEventRow[] }> {
  const [files, events] = await Promise.all([
    supabase
      .from('stripe_dispute_evidence_files')
      .select('id, dispute_id, category, file_name, storage_path, mime_type, size_bytes, stripe_file_id, created_at')
      .eq('user_id', ownerId)
      .eq('dispute_id', disputeId)
      .order('created_at'),
    supabase
      .from('stripe_dispute_events')
      .select('stripe_event_id, event_type, event_created, status_after')
      .eq('user_id', ownerId)
      .eq('dispute_id', disputeId)
      .order('event_created', { ascending: false })
      .limit(30),
  ]);
  if (files.error) throw files.error;
  if (events.error) throw events.error;
  return { files: (files.data ?? []) as DisputeEvidenceFile[], events: (events.data ?? []) as DisputeEventRow[] };
}

export async function saveEvidenceDraft(disputeId: string, draft: Record<string, string>): Promise<void> {
  const { error } = await supabase.rpc('save_dispute_evidence_draft', { p_dispute_id: disputeId, p_draft: draft });
  if (error) throw new Error(error.message || 'Could not save the evidence draft.');
}

export async function uploadEvidenceFile(
  ownerId: string,
  disputeId: string,
  category: EvidenceCategory,
  file: File,
): Promise<string> {
  const path = `${ownerId}/${disputeId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage.from('dispute-evidence').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw new Error(uploadError.message || 'Upload failed.');
  const { data, error } = await supabase.rpc('register_dispute_evidence_file', {
    p_dispute_id: disputeId,
    p_category: category,
    p_file_name: file.name,
    p_storage_path: path,
    p_mime_type: file.type,
    p_size_bytes: file.size,
  });
  if (error) {
    await supabase.storage.from('dispute-evidence').remove([path]); // never leave an orphaned object behind
    throw new Error(error.message || 'Could not attach the file.');
  }
  return data as string;
}

export async function removeEvidenceFile(fileId: string): Promise<void> {
  const { data, error } = await supabase.rpc('remove_dispute_evidence_file', { p_file_id: fileId });
  if (error) throw new Error(error.message || 'Could not remove the file.');
  if (typeof data === 'string' && data) await supabase.storage.from('dispute-evidence').remove([data]);
}

export async function getEvidenceFileUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('dispute-evidence').createSignedUrl(storagePath, 300);
  if (error || !data?.signedUrl) throw new Error('Could not open the file.');
  return data.signedUrl;
}

async function disputeAction(action: 'submit' | 'accept' | 'sync', disputeId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('dispute-evidence', { body: { action, dispute_id: disputeId } });
  if (error) throw new Error(await functionErrorMessage(error, 'Something went wrong. Please try again.'));
  return (data as { status?: string })?.status ?? '';
}

export const submitEvidence = (disputeId: string) => disputeAction('submit', disputeId);
export const acceptDispute = (disputeId: string) => disputeAction('accept', disputeId);
export const syncDispute = (disputeId: string) => disputeAction('sync', disputeId);
