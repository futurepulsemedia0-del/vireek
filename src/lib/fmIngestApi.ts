// src/lib/fmIngestApi.ts
//
// Supabase access for Work-Order Guard intake (forwarded email / PDF) and rejection-learning drafts.
// Reads use RLS-scoped tables (the policy already limits rows to the caller's account); writes go through RPCs / the fm-ingest-pdf edge function.

import { supabase } from '@/lib/supabase';
import { candidateToDraftPayload, type RuleCandidate } from '@/lib/fmCheck';

export type IngestStatus = 'ready' | 'needs_ocr' | 'rejected' | 'imported' | 'dismissed';
export interface IngestItem {
  id: string; channel: 'email' | 'pdf'; status: IngestStatus; rejectCode: string | null; originalName: string | null;
  originalPath: string | null; sender: string | null; subject: string | null; pageCount: number | null; createdAt: string;
}
export interface RuleDraft { id: string; candidateKey: string; kind: string; evidenceCount: number; status: 'draft' | 'dismissed' }

export class IngestError extends Error { constructor(public code: string, message?: string) { super(message ?? code); } }

const COLS = 'id,channel,status,reject_code,original_name,original_path,sender,subject,page_count,created_at';

export async function listIngestItems(): Promise<IngestItem[]> {
  const { data, error } = await supabase.from('wog_ingest_items').select(COLS).order('created_at', { ascending: false }).limit(100);
  if (error) throw new IngestError('load_failed');
  return (data ?? []).map((r) => ({
    id: String(r.id), channel: r.channel as IngestItem['channel'], status: r.status as IngestStatus, rejectCode: (r.reject_code as string | null) ?? null,
    originalName: (r.original_name as string | null) ?? null, originalPath: (r.original_path as string | null) ?? null, sender: (r.sender as string | null) ?? null,
    subject: (r.subject as string | null) ?? null, pageCount: r.page_count == null ? null : Number(r.page_count), createdAt: String(r.created_at),
  }));
}

/** Sanitized text of one item (kept out of the list query: it can be large). */
export async function getIngestText(id: string): Promise<string> {
  const { data, error } = await supabase.from('wog_ingest_items').select('text_content').eq('id', id).maybeSingle();
  if (error || !data) throw new IngestError('load_failed');
  return (data.text_content as string | null) ?? '';
}

export async function uploadPdf(file: File): Promise<{ id: string; status: IngestStatus; duplicate: boolean }> {
  const { data, error } = await supabase.functions.invoke('fm-ingest-pdf', { body: file, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': file.name } });
  if (error) {
    let code = 'upload_failed';
    try { const body = await (error as { context?: Response }).context?.json(); if (body?.error) code = String(body.error); } catch { /* keep default */ }
    throw new IngestError(code);
  }
  return data as { id: string; status: IngestStatus; duplicate: boolean };
}

export async function markIngest(id: string, status: 'imported' | 'dismissed', batchId?: string): Promise<void> {
  const { error } = await supabase.rpc('wog_ingest_mark', { p_id: id, p_status: status, p_batch_id: batchId ?? null });
  if (error) throw new IngestError('mark_failed');
}

/** Short-lived download link for the stored original (served as a download, never rendered inline). */
export async function originalDownloadUrl(path: string, fileName: string): Promise<string> {
  const { data, error } = await supabase.storage.from('fm-ingest-originals').createSignedUrl(path, 60, { download: fileName });
  if (error || !data) throw new IngestError('download_failed');
  return data.signedUrl;
}

export async function saveRuleDraft(c: RuleCandidate): Promise<void> {
  const { error } = await supabase.rpc('wog_rule_suggestion_save', { p: candidateToDraftPayload(c) });
  if (error) throw new IngestError(error.message?.includes('suggestion_limit') ? 'suggestion_limit' : 'save_failed');
}

export async function listRuleDrafts(): Promise<RuleDraft[]> {
  const { data, error } = await supabase.from('wog_rule_suggestions').select('id,candidate_key,kind,evidence_count,status').order('updated_at', { ascending: false }).limit(100);
  if (error) throw new IngestError('load_failed');
  return (data ?? []).map((r) => ({ id: String(r.id), candidateKey: String(r.candidate_key), kind: String(r.kind), evidenceCount: Number(r.evidence_count), status: r.status as RuleDraft['status'] }));
}

export async function deleteRuleDraft(id: string): Promise<void> {
  const { error } = await supabase.rpc('wog_rule_suggestion_delete', { p_id: id });
  if (error) throw new IngestError('delete_failed');
}
