// src/lib/photoAuthenticityApi.ts
import { supabase } from '@/lib/supabase';
import { parseAuthenticityItems, type AuthenticityReport, type StoredAuthenticity } from '@/lib/photoAuthenticity';

/** Stored reports for a job (RLS: caller's account and visible jobs only). */
export async function fetchAuthenticity(jobId: string): Promise<Map<string, StoredAuthenticity>> {
  const { data, error } = await supabase.rpc('get_evidence_photo_authenticity', { p_job_id: jobId });
  if (error) throw new Error(error.message);
  return parseAuthenticityItems(data);
}

/** Asks the server to read the sealed original and store a report. The server re-verifies the file hash first. */
export async function requestAuthenticity(captureId: string): Promise<AuthenticityReport> {
  const { data, error } = await supabase.functions.invoke('photo-provenance', { body: { action: 'analyze_authenticity', capture_id: captureId } });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    let message = error.message;
    if (ctx instanceof Response) {
      try { message = ((await ctx.clone().json()) as { error?: string }).error ?? message; } catch { /* keep default */ }
    }
    throw new Error(message);
  }
  const report = (data as { report?: AuthenticityReport } | null)?.report;
  if (!report) throw new Error('empty_report');
  return report;
}
