/*
  # Competitor Data Migration / Import Engine

  Generic, source-agnostic import pipeline for bringing a new customer's
  existing Customers and Job History into Vireek from wherever they are
  today — a CSV export from ServiceTitan, Jobber, Housecall Pro,
  FieldEdge, Service Fusion, or any spreadsheet. Column-mapping based,
  so it never depends on knowing another platform's export format ahead
  of time.

  ## New columns (mirrors the source/external_id dedup pattern already
  used by price_book_items)
  - customers.external_source, customers.external_id
  - jobs.external_source, jobs.external_id
  All nullable; a partial unique index enforces "one row per (account,
  external_source, external_id)" only when both are set, so manually
  created rows are never affected and re-running an import is safe
  (upsert, not duplicate).

  ## New tables
  - data_import_jobs       — one row per import run: source, type,
                              status, row counts
  - data_import_row_errors — one row per record that failed to import,
                              with the raw input and why, so the import
                              wizard can show "12 rows need attention"

  ## Access model
  Same team-account model as customers/jobs themselves: user_id =
  get_account_owner_id() (see create_profiles_and_team_members
  migration), so a staff member running an import scopes to their
  account owner's data exactly like creating a job by hand does.
*/

-- =============================================================
-- DEDUP COLUMNS ON EXISTING TABLES
-- =============================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user_extsource_extid_unique
  ON customers(user_id, external_source, external_id)
  WHERE external_id IS NOT NULL AND external_source IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_extsource_extid_unique
  ON jobs(user_id, external_source, external_id)
  WHERE external_id IS NOT NULL AND external_source IS NOT NULL;

-- =============================================================
-- DATA_IMPORT_JOBS  (one row per import run)
-- =============================================================

CREATE TABLE IF NOT EXISTS data_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source text NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'service_titan', 'jobber')),
  import_type text NOT NULL CHECK (import_type IN ('customers', 'jobs')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed')),
  file_name text,
  column_mapping jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  started_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_import_jobs_user_id ON data_import_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_data_import_jobs_created_at ON data_import_jobs(created_at DESC);

ALTER TABLE data_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_data_import_jobs"
  ON data_import_jobs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_data_import_jobs"
  ON data_import_jobs FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_data_import_jobs"
  ON data_import_jobs FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- DATA_IMPORT_ROW_ERRORS
-- =============================================================

CREATE TABLE IF NOT EXISTS data_import_row_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id uuid NOT NULL REFERENCES data_import_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  row_number integer NOT NULL,
  raw_row jsonb NOT NULL,
  error_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_import_row_errors_job ON data_import_row_errors(import_job_id);
CREATE INDEX IF NOT EXISTS idx_data_import_row_errors_user_id ON data_import_row_errors(user_id);

ALTER TABLE data_import_row_errors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_data_import_row_errors"
  ON data_import_row_errors FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_data_import_row_errors"
  ON data_import_row_errors FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

-- Defensive: this function already exists (create_profiles_and_team_members
-- migration) but functions are occasionally created without an explicit
-- grant — this is a harmless no-op if it's already granted.
GRANT EXECUTE ON FUNCTION public.get_account_owner_id() TO authenticated;

COMMENT ON TABLE data_import_jobs IS
  'One row per competitor-data import run (CSV today; service_titan/jobber reserved for a future direct-API path). Drives the import wizard''s progress UI.';
COMMENT ON TABLE data_import_row_errors IS
  'Per-row failures from a data_import_jobs run, with the raw input preserved so the wizard can let the user fix and retry just the bad rows.';
