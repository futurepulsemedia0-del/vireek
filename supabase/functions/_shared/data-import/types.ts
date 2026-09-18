// supabase/functions/_shared/data-import/types.ts

export type ImportSource = "csv" | "service_titan" | "jobber";
export type ImportType = "customers" | "jobs";
export type ImportStatus = "pending" | "running" | "completed" | "completed_with_errors" | "failed";

/** Our canonical field names for a customer row, mapped FROM the source CSV's own headers. */
export interface CustomerColumnMapping {
  name: string; // required — the CSV header that holds the customer's name
  phone?: string;
  email?: string;
  address?: string;
  customer_type?: string; // CSV header holding 'residential' | 'commercial' (best-effort parsed)
  notes?: string;
  external_id?: string; // CSV header holding the source platform's own record id (strongly recommended)
}

/** Our canonical field names for a job row, mapped FROM the source CSV's own headers. */
export interface JobColumnMapping {
  customer_name: string; // required
  customer_phone?: string; // used to link to an existing customer, best-effort
  service_type?: string;
  address?: string;
  scheduled_datetime?: string;
  job_status?: string;
  invoice_amount?: string;
  invoice_status?: string;
  external_id?: string;
}

export type ColumnMapping = CustomerColumnMapping | JobColumnMapping;

export interface RunImportRequest {
  source: "csv";
  import_type: ImportType;
  file_name?: string;
  csv_text: string;
  column_mapping: ColumnMapping;
}

export interface RowErrorSummary {
  row_number: number;
  error_message: string;
}

export interface RunImportResult {
  import_job_id: string;
  status: ImportStatus;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  /** First 50 row errors only — the rest are in data_import_row_errors. */
  errors: RowErrorSummary[];
}
