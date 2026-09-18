import { supabase } from './supabase';
import { parseCsv, type ParsedCsvPreview } from './csvPreview';

export type ImportSource = 'csv' | 'service_titan' | 'jobber';
export type ImportType = 'customers' | 'jobs';
export type ImportStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface DataImportJob {
  id: string;
  user_id: string;
  source: ImportSource;
  import_type: ImportType;
  status: ImportStatus;
  file_name: string | null;
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface DataImportRowError {
  id: string;
  import_job_id: string;
  row_number: number;
  raw_row: Record<string, string>;
  error_message: string;
  created_at: string;
}

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  pending: 'Pending',
  running: 'Importing…',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
};

export interface CustomerColumnMapping {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  customer_type?: string;
  notes?: string;
  external_id?: string;
}

export interface JobColumnMapping {
  customer_name: string;
  customer_phone?: string;
  service_type?: string;
  address?: string;
  scheduled_datetime?: string;
  job_status?: string;
  invoice_amount?: string;
  invoice_status?: string;
  external_id?: string;
}

export interface RunImportResult {
  import_job_id: string;
  status: ImportStatus;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  errors: { row_number: number; error_message: string }[];
}

/** Parses a CSV file client-side just to show the wizard's mapping/preview step — the real import always re-parses server-side. */
export function previewCsv(text: string, maxPreviewRows = 5): ParsedCsvPreview {
  return parseCsv(text, maxPreviewRows);
}

export async function runCsvImport(params: {
  importType: ImportType;
  fileName?: string;
  csvText: string;
  columnMapping: CustomerColumnMapping | JobColumnMapping;
}): Promise<RunImportResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('Not signed in.');

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/data-import-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      source: 'csv',
      import_type: params.importType,
      file_name: params.fileName,
      csv_text: params.csvText,
      column_mapping: params.columnMapping,
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Import failed.');
  return json as RunImportResult;
}

export async function listImportJobs(): Promise<DataImportJob[]> {
  const { data, error } = await supabase
    .from('data_import_jobs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listImportRowErrors(importJobId: string): Promise<DataImportRowError[]> {
  const { data, error } = await supabase
    .from('data_import_row_errors')
    .select('*')
    .eq('import_job_id', importJobId)
    .order('row_number');
  if (error) throw error;
  return data ?? [];
}
