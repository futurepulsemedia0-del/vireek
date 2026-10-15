// supabase/functions/_shared/data-import/v2types.ts
//
// Types for the import wizard API (validate / run / rollback). The original
// types.ts is left untouched so the legacy request shape keeps working.

export type ImportSourceV2 = "csv" | "service_titan" | "jobber" | "housecall_pro";
export type ImportTypeV2 = "customers" | "jobs";
export type DedupeStrategy = "skip" | "fill_blanks" | "overwrite";
export type ImportActionV2 = "validate" | "run" | "rollback";

/** canonical field key → CSV header that holds it. Flat so presets/UI can add fields without server changes. */
export type FieldMap = Record<string, string | undefined>;

export interface ImportRequestV2 {
  action: ImportActionV2;
  // validate + run
  source?: ImportSourceV2;
  import_type?: ImportTypeV2;
  file_name?: string;
  file_type?: "csv" | "xlsx";
  csv_text?: string;
  column_mapping?: FieldMap;
  dedupe_strategy?: DedupeStrategy;
  timezone?: string;
  // rollback
  import_job_id?: string;
}

export type IssueSeverity = "error" | "warning" | "info";
export interface RowIssue {
  severity: IssueSeverity;
  field?: string;
  message: string;
}

export type PlanAction = "create" | "update" | "skip" | "error";
export type MatchedBy = "external_id" | "phone" | "email" | "name_address" | "fingerprint" | "in_file";

export interface PlannedRow {
  rowNumber: number; // spreadsheet row (header = 1)
  action: PlanAction;
  label: string; // human label for previews
  matchedBy?: MatchedBy;
  targetId?: string; // existing record id for update/skip-by-match
  duplicateOfRow?: number;
  issues: RowIssue[];
  /** create: full insert payload (without user_id). update: only the changed columns. */
  values: Record<string, unknown>;
  /** update: previous values of the changed columns (powers rollback). */
  before?: Record<string, unknown>;
  display: Record<string, string>;
}

export interface PlanSummary {
  total: number;
  create: number;
  update: number;
  skip: number;
  error: number;
  warnings: number;
  duplicates: number;
}

export interface ExistingCustomer {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  customer_type: string | null;
  external_source: string | null;
  external_id: string | null;
  updated_at?: string | null;
}

export interface ExistingJob {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  job_status: string | null;
  invoice_amount: number | string | null;
  invoice_status: string | null;
  external_source: string | null;
  external_id: string | null;
}

export interface ValidateRowResult {
  row_number: number;
  action: PlanAction;
  label: string;
  matched_by?: MatchedBy;
  duplicate_of_row?: number;
  issues: RowIssue[];
  display: Record<string, string>;
}

export interface ValidateResultV2 {
  summary: PlanSummary;
  rows: ValidateRowResult[];
  /** true when `rows` is a capped sample of the file (counts in `summary` are always complete). */
  rows_truncated: boolean;
  can_import: boolean;
  blocking_reason?: string;
}

export interface RunResultV2 {
  import_job_id: string;
  status: "completed" | "completed_with_errors" | "failed";
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  warning_count: number;
  errors: { row_number: number; error_message: string }[];
}

export interface RollbackResultV2 {
  import_job_id: string;
  deleted: number;
  restored: number;
  kept_modified: number;
  blocked: number;
  failures: string[];
}
