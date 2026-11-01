import { supabase } from '@/lib/supabase';
import { classifyError, type AppError } from './appError';
import { buildAuditDetails, type AuditDetails } from '@/lib/auditLog';

export type HistoryTable = 'jobs' | 'leads' | 'customers' | 'quotes' | 'invoices' | 'calls';

export interface HistoryEntry {
  id: string;
  created_at: string;
  actor_email: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  seq: number | null;
}

export type HistoryResult = { ok: true; entries: HistoryEntry[] } | { ok: false; error: AppError };

export async function fetchRecordHistory(table: HistoryTable, id: string, limit = 100): Promise<HistoryResult> {
  try {
    const { data, error } = await supabase.rpc('get_record_history', { p_table: table, p_id: id, p_limit: limit });
    if (error) throw error;
    return { ok: true, entries: (data ?? []) as HistoryEntry[] };
  } catch (e) {
    return { ok: false, error: classifyError(e) };
  }
}

export const describeEntry = (e: Pick<HistoryEntry, 'metadata'>): AuditDetails => buildAuditDetails(e.metadata);

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  reason: string | null;
}

export async function verifyAuditChain(): Promise<{ ok: true; result: ChainVerification } | { ok: false; error: AppError }> {
  try {
    const { data, error } = await supabase.rpc('verify_audit_chain');
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { ok: boolean; checked: number | string; first_bad_seq: number | string | null; reason: string | null } | undefined;
    if (!row) throw new Error('empty verification result');
    return { ok: true, result: { ok: row.ok, checked: Number(row.checked), firstBadSeq: row.first_bad_seq == null ? null : Number(row.first_bad_seq), reason: row.reason } };
  } catch (e) {
    return { ok: false, error: classifyError(e) };
  }
}
