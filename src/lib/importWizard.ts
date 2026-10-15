// src/lib/importWizard.ts
//
// Client API for the import wizard. Talks to the data-import-run edge function
// (actions: validate / run / rollback) with the caller's own JWT — the server
// resolves the account and enforces permission; nothing here is trusted.
// History reads are scoped to accountOwnerId explicitly (RLS is the backstop).

import { supabase } from './supabase';
import type { FieldMapping, ImportPresetId, ImportType } from './importPresets';

export type DedupeStrategy = 'skip' | 'fill_blanks' | 'overwrite';
export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'rolling_back' | 'rolled_back';
export type RowAction = 'create' | 'update' | 'skip' | 'error';

export interface RowIssue {
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export interface ValidateRow {
  row_number: number;
  action: RowAction;
  label: string;
  matched_by?: string;
  duplicate_of_row?: number;
  issues: RowIssue[];
  display: Record<string, string>;
}

export interface ValidateResult {
  summary: { total: number; create: number; update: number; skip: number; error: number; warnings: number; duplicates: number };
  rows: ValidateRow[];
  rows_truncated: boolean;
  can_import: boolean;
  blocking_reason?: string;
}

export interface RunResult {
  import_job_id: string;
  status: 'completed' | 'completed_with_errors' | 'failed';
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  warning_count: number;
  errors: { row_number: number; error_message: string }[];
}

export interface RollbackResult {
  import_job_id: string;
  deleted: number;
  restored: number;
  kept_modified: number;
  blocked: number;
  failures: string[];
}

export interface ImportJobRecord {
  id: string;
  user_id: string;
  source: ImportPresetId;
  import_type: ImportType;
  status: ImportJobStatus;
  file_name: string | null;
  file_type: 'csv' | 'xlsx' | null;
  dedupe_strategy: DedupeStrategy;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  warning_count: number;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  rolled_back_at: string | null;
  rollback_summary: { deleted: number; restored: number; kept_modified: number; blocked: number } | null;
}

export interface ImportRowErrorRecord {
  id: string;
  import_job_id: string;
  row_number: number;
  raw_row: Record<string, string>;
  error_message: string;
}

export const STATUS_LABELS: Record<ImportJobStatus, string> = {
  pending: 'Pending',
  running: 'Importing…',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
  rolling_back: 'Rolling back…',
  rolled_back: 'Rolled back',
};

export const SOURCE_LABELS: Record<ImportPresetId, string> = {
  csv: 'CSV / Excel',
  service_titan: 'ServiceTitan',
  jobber: 'Jobber',
  housecall_pro: 'Housecall Pro',
};

export const STRATEGY_OPTIONS: { value: DedupeStrategy; label: string; description: string }[] = [
  { value: 'fill_blanks', label: 'Fill in blanks', description: 'Add missing details to customers/jobs you already have. Nothing you’ve typed is overwritten.' },
  { value: 'skip', label: 'Skip existing', description: 'Leave anything already in Vireek exactly as it is. Only add new records.' },
  { value: 'overwrite', label: 'Update existing', description: 'Replace what’s in Vireek with the values from this file where they differ.' },
];

export const canRollBack = (job: Pick<ImportJobRecord, 'status'>) => job.status === 'completed' || job.status === 'completed_with_errors';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ------------------------------------------------------------------ API

async function callImportApi<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('Your session expired. Please sign in again.');

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/data-import-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('Couldn’t reach the server. Check your connection and try again.');
  }

  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
  return json as T;
}

interface FileParams {
  source: ImportPresetId;
  importType: ImportType;
  fileName: string;
  fileType: 'csv' | 'xlsx';
  csvText: string;
  mapping: FieldMapping;
  dedupe: DedupeStrategy;
}

const filePayload = (p: FileParams) => ({
  source: p.source,
  import_type: p.importType,
  file_name: p.fileName,
  file_type: p.fileType,
  csv_text: p.csvText,
  column_mapping: p.mapping,
  dedupe_strategy: p.dedupe,
  timezone: browserTimeZone(),
});

export const validateImport = (p: FileParams, signal?: AbortSignal) =>
  callImportApi<ValidateResult>({ action: 'validate', ...filePayload(p) }, signal);

export const runImport = (p: FileParams) => callImportApi<RunResult>({ action: 'run', ...filePayload(p) });

export const rollbackImport = (importJobId: string) => callImportApi<RollbackResult>({ action: 'rollback', import_job_id: importJobId });

// -------------------------------------------------------------- history

export async function listImportJobs(accountOwnerId: string): Promise<ImportJobRecord[]> {
  const { data, error } = await supabase
    .from('data_import_jobs')
    .select('id,user_id,source,import_type,status,file_name,file_type,dedupe_strategy,total_rows,created_count,updated_count,skipped_count,error_count,warning_count,failure_reason,created_at,completed_at,rolled_back_at,rollback_summary')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as ImportJobRecord[];
}

export async function listImportRowErrors(accountOwnerId: string, importJobId: string): Promise<ImportRowErrorRecord[]> {
  const { data, error } = await supabase
    .from('data_import_row_errors')
    .select('id,import_job_id,row_number,raw_row,error_message')
    .eq('user_id', accountOwnerId)
    .eq('import_job_id', importJobId)
    .order('row_number')
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []) as ImportRowErrorRecord[];
}

export { downloadTextFile, rowErrorsToCsv } from './importFile';
