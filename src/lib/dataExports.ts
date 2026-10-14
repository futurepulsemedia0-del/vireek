/**
 * Data Exports — client API.
 *
 * All heavy lifting (reading rows, building CSV/XLSX/PDF, storing the file,
 * signing links) happens in the `export-run` edge function. The browser only:
 *   - asks for an export,
 *   - reads the history (export_jobs, RLS + permission gated),
 *   - asks for a short-lived signed download link.
 *
 * Dataset / format metadata comes from the SAME engine file the server uses,
 * so labels, status values and row caps can never drift apart.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  EXPORT_DATASETS,
  EXPORT_DATASET_LIST,
  EXPORT_FORMATS,
  FORMAT_LABEL,
  FORMAT_ROW_CAP,
  FILE_RETENTION_DAYS,
  describeFilters,
  isExportExpired,
  type ExportDatasetId,
  type ExportFilters,
  type ExportFormat,
} from '../../supabase/functions/_shared/exports/engine';

export {
  EXPORT_DATASETS,
  EXPORT_DATASET_LIST,
  EXPORT_FORMATS,
  FORMAT_LABEL,
  FORMAT_ROW_CAP,
  FILE_RETENTION_DAYS,
  describeFilters,
  isExportExpired,
};
export type { ExportDatasetId, ExportFilters, ExportFormat };

export type ExportJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired';

export interface ExportJob {
  id: string;
  user_id: string;
  requested_by: string;
  requested_by_email: string | null;
  dataset: string;
  format: ExportFormat;
  filters: ExportFilters;
  status: ExportJobStatus;
  row_count: number | null;
  truncated: boolean;
  file_size_bytes: number | null;
  error_message: string | null;
  download_count: number;
  last_downloaded_at: string | null;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

const JOB_COLUMNS =
  'id, user_id, requested_by, requested_by_email, dataset, format, filters, status, row_count, truncated, file_size_bytes, error_message, download_count, last_downloaded_at, expires_at, created_at, completed_at';

/** Permission gate used by the page, nav and every Export button. */
export function useCanExport(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_export_data === true;
}

async function invokeExport<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('export-run', { body });
  if (error) {
    let message = 'Export request failed. Please try again.';
    if (error instanceof FunctionsHttpError) {
      try {
        const payload = await error.context.json();
        if (payload && typeof payload.error === 'string') message = payload.error;
      } catch {
        /* keep generic message */
      }
    }
    throw new Error(message);
  }
  return data as T;
}

export async function createExport(input: {
  dataset: ExportDatasetId;
  format: ExportFormat;
  filters?: ExportFilters;
}): Promise<{ job_id: string }> {
  return invokeExport<{ job_id: string }>({ action: 'create', ...input, filters: input.filters ?? {} });
}

export async function listExports(limit = 50): Promise<ExportJob[]> {
  const { data, error } = await supabase
    .from('export_jobs')
    .select(JOB_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ExportJob[];
}

/** Mints a fresh, short-lived signed URL and triggers the browser download. */
export async function downloadExport(jobId: string): Promise<void> {
  const { url, file_name } = await invokeExport<{ url: string; file_name: string }>({
    action: 'download',
    job_id: jobId,
  });
  const a = document.createElement('a');
  a.href = url;
  a.download = file_name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function deleteExport(jobId: string): Promise<void> {
  await invokeExport<{ ok: true }>({ action: 'delete', job_id: jobId });
}

export function datasetLabel(id: string): string {
  return (EXPORT_DATASETS as Record<string, { label: string }>)[id]?.label ?? id;
}

export function isActiveJob(job: Pick<ExportJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'processing';
}

/** What the UI should show, accounting for files that aged out client-side. */
export function effectiveStatus(job: Pick<ExportJob, 'status' | 'expires_at'>, now = Date.now()): ExportJobStatus {
  if (job.status === 'completed' && isExportExpired(job.expires_at, now)) return 'expired';
  return job.status;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'Expires in <1h';
  if (hours < 24) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}
