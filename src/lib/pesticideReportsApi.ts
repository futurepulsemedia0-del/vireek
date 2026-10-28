/**
 * Pesticide usage reports — Supabase API.
 * The report itself is built by the database (`pesticide_usage_report()`); sealing, filing and
 * verification go through RPCs so a snapshot can never be edited from the client.
 */

import { supabase } from '@/lib/supabase';
import { friendlyTradePackError } from '@/lib/tradePacksApi';
import { normalizeReport, type UsageReport } from '@/lib/pesticideReports';

export interface SavedUsageReport {
  id: string;
  period_from: string;
  period_to: string;
  restricted_only: boolean;
  jurisdiction: string | null;
  note: string | null;
  entry_count: number;
  voided_count: number;
  content_hash: string;
  prepared_by_email: string | null;
  created_at: string;
  filed_at: string | null;
  filing_reference: string | null;
}

const SAVED_COLS =
  'id, period_from, period_to, restricted_only, jurisdiction, note, entry_count, voided_count, content_hash, prepared_by_email, created_at, filed_at, filing_reference';

/** Database exceptions → short human messages (falls back to the shared trade-pack mapper). */
export function friendlyReportError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  const m = /^(?:invalid_period|invalid_reference):\s*(.+)$/s.exec(raw.trim());
  if (m) return m[1].trim();
  if (/already marked as filed|Report not found/.test(raw)) return 'That report was not found or is already marked as filed.';
  if (/sealed and cannot be edited|cannot be deleted/.test(raw)) return 'Sealed reports cannot be changed.';
  if (/not_authenticated/.test(raw)) return 'Please sign in again.';
  return friendlyTradePackError(err, fallback);
}

function owner(id: string | null | undefined): string {
  if (!id) throw new Error('Not signed in.');
  return id;
}

/** Live report for a half-open window [from, to) (ISO instants). */
export async function fetchUsageReport(fromIso: string, toIso: string, restrictedOnly: boolean): Promise<UsageReport> {
  const { data, error } = await supabase.rpc('pesticide_usage_report', { p_from: fromIso, p_to: toIso, p_restricted_only: restrictedOnly });
  if (error) throw error;
  return normalizeReport(data);
}

export async function finalizeUsageReport(input: {
  fromIso: string;
  toIso: string;
  restrictedOnly: boolean;
  jurisdiction?: string;
  note?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('finalize_pesticide_usage_report', {
    p_from: input.fromIso,
    p_to: input.toIso,
    p_restricted_only: input.restrictedOnly,
    p_jurisdiction: input.jurisdiction?.trim() || null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchSavedReports(ownerId: string | null | undefined, limit = 50): Promise<SavedUsageReport[]> {
  const { data, error } = await supabase
    .from('pesticide_usage_reports')
    .select(SAVED_COLS)
    .eq('user_id', owner(ownerId))
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw error;
  return (data as SavedUsageReport[]) ?? [];
}

/** The sealed payload of one snapshot (kept out of the list query because it can be large). */
export async function fetchSavedReportPayload(ownerId: string | null | undefined, id: string): Promise<UsageReport> {
  const { data, error } = await supabase.from('pesticide_usage_reports').select('report').eq('id', id).eq('user_id', owner(ownerId)).single();
  if (error) throw error;
  return normalizeReport((data as { report: unknown }).report);
}

export async function markReportFiled(id: string, reference: string): Promise<void> {
  const { error } = await supabase.rpc('mark_pesticide_usage_report_filed', { p_id: id, p_reference: reference });
  if (error) throw error;
}

/** true = the stored payload still matches the hash recorded when it was sealed. */
export async function verifySavedReport(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('verify_pesticide_usage_report', { p_id: id });
  if (error) throw error;
  return data === true;
}

/** Browser download (UTF-8 BOM so Excel renders accents / non-Latin names correctly). */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
