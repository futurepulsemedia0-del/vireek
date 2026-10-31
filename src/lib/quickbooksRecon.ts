/**
 * QuickBooks reconciliation audit: client API.
 *
 * The browser only READS findings / runs / events (RLS + can_manage_quickbooks), asks the qbo-sync-run edge
 * function to start a read-only audit, and calls qbo_recon_set_status to resolve a finding with a note.
 * Nothing here can write to QuickBooks, to invoices or to payments.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  BUCKET_LABEL,
  RECON_BUCKETS,
  findingsToCsv,
  type ReconBucket,
  type ReconSeverity,
  type ReconSummary,
} from '../../supabase/functions/_shared/quickbooks/reconcile';

export { BUCKET_LABEL, RECON_BUCKETS, findingsToCsv };
export type { ReconBucket, ReconSeverity };

export type FindingStatus = 'open' | 'resolved' | 'cleared';
export type ReconRunStatus = 'running' | 'success' | 'partial' | 'failed';

export interface ReconRun {
  id: string;
  status: ReconRunStatus;
  summary: Partial<ReconSummary> & { note?: string; truncated?: boolean; qbo_fetched?: number; skipped_count?: number };
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ReconFindingRow {
  id: string;
  bucket: ReconBucket;
  severity: ReconSeverity;
  cents_at_stake: number;
  has_payments: boolean;
  status: FindingStatus;
  suggested_action: string;
  resolution_note: string | null;
  resolved_at: string | null;
  evidence: { vireek: Record<string, unknown> | null; qbo: Record<string, unknown> | null; detail?: Record<string, unknown> };
  updated_at: string;
}

export interface ReconEvent {
  id: string;
  finding_id: string;
  action: 'detected' | 'reopened' | 'resolved' | 'unresolved' | 'cleared';
  note: string | null;
  created_at: string;
}

const SEVERITY_RANK: Record<ReconSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const sortFindings = (rows: ReconFindingRow[]): ReconFindingRow[] =>
  [...rows].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.cents_at_stake - a.cents_at_stake || a.id.localeCompare(b.id));

export const formatCents = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function readError(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload.error === 'string') return payload.error;
    } catch {
      /* keep fallback */
    }
  }
  return fallback;
}

export async function startReconciliation(connectionId: string): Promise<{ run_id: string }> {
  const { data, error } = await supabase.functions.invoke('qbo-sync-run', { body: { action: 'reconcile', connection_id: connectionId } });
  if (error) throw new Error(await readError(error, 'Could not start the audit.'));
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') throw new Error((data as { error: string }).error);
  return data as { run_id: string };
}

export async function latestReconRun(connectionId: string): Promise<ReconRun | null> {
  const { data, error } = await supabase
    .from('qbo_recon_runs')
    .select('id, status, summary, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ReconRun | null) ?? null;
}

export async function listFindings(connectionId: string, status: FindingStatus | 'all' = 'open'): Promise<ReconFindingRow[]> {
  let q = supabase
    .from('qbo_recon_findings')
    .select('id, bucket, severity, cents_at_stake, has_payments, status, suggested_action, resolution_note, resolved_at, evidence, updated_at')
    .eq('connection_id', connectionId);
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q.order('cents_at_stake', { ascending: false }).limit(2000);
  if (error) throw error;
  return sortFindings((data ?? []) as ReconFindingRow[]);
}

export async function listFindingEvents(findingId: string): Promise<ReconEvent[]> {
  const { data, error } = await supabase
    .from('qbo_recon_events')
    .select('id, finding_id, action, note, created_at')
    .eq('finding_id', findingId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ReconEvent[];
}

export async function setFindingStatus(findingId: string, status: 'open' | 'resolved', note?: string): Promise<void> {
  const { error } = await supabase.rpc('qbo_recon_set_status', { p_finding: findingId, p_status: status, p_note: note ?? null });
  if (error) throw new Error(error.message || 'Could not update the finding.');
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
