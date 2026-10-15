/*
  # Import Wizard v2 — presets, dedupe strategy, validation, rollback

  Builds on 20260929000000_competitor_data_import_engine.sql (data_import_jobs,
  data_import_row_errors, customers/jobs external_source + external_id).

  ## Changes
  - data_import_jobs: source now also allows 'housecall_pro'; status adds
    'rolling_back' / 'rolled_back'; new columns for the wizard (preset,
    file_type, dedupe_strategy, warning_count, timezone, who ran / rolled back,
    rollback_summary).
  - data_import_row_effects: one row per record an import CREATED or UPDATED
    (with the previous values for updates). This is what makes rollback exact.
  - public.can_run_data_imports(): single source of truth for "who may import
    or roll back": the account owner, or a member whose effective
    can_edit_business_profile is true (custom role overrides the base flag,
    same as the client's AuthContext). Enforced by a trigger on
    data_import_jobs, so it holds no matter which client calls the API.

  ## Access model
  Identical to the rest of the import engine: user_id = get_account_owner_id().
*/

-- =============================================================
-- data_import_jobs: widen constraints + wizard columns
-- =============================================================

ALTER TABLE data_import_jobs DROP CONSTRAINT IF EXISTS data_import_jobs_source_check;
ALTER TABLE data_import_jobs
  ADD CONSTRAINT data_import_jobs_source_check
  CHECK (source IN ('csv', 'service_titan', 'jobber', 'housecall_pro'));

ALTER TABLE data_import_jobs DROP CONSTRAINT IF EXISTS data_import_jobs_status_check;
ALTER TABLE data_import_jobs
  ADD CONSTRAINT data_import_jobs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'rolling_back', 'rolled_back'));

ALTER TABLE data_import_jobs
  ADD COLUMN IF NOT EXISTS file_type text CHECK (file_type IN ('csv', 'xlsx')),
  ADD COLUMN IF NOT EXISTS dedupe_strategy text NOT NULL DEFAULT 'fill_blanks'
    CHECK (dedupe_strategy IN ('skip', 'fill_blanks', 'overwrite')),
  ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS started_by_user uuid,
  ADD COLUMN IF NOT EXISTS rollback_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS rolled_back_by_user uuid,
  ADD COLUMN IF NOT EXISTS rollback_summary jsonb;

-- =============================================================
-- data_import_row_effects  (what an import changed — drives rollback)
-- =============================================================

CREATE TABLE IF NOT EXISTS data_import_row_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id uuid NOT NULL REFERENCES data_import_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  entity_type text NOT NULL CHECK (entity_type IN ('customer', 'job')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated')),
  before_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_import_row_effects_job ON data_import_row_effects(import_job_id);
CREATE INDEX IF NOT EXISTS idx_data_import_row_effects_user_id ON data_import_row_effects(user_id);

ALTER TABLE data_import_row_effects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_data_import_row_effects" ON data_import_row_effects;
CREATE POLICY "select_own_data_import_row_effects"
  ON data_import_row_effects FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_data_import_row_effects" ON data_import_row_effects;
CREATE POLICY "insert_own_data_import_row_effects"
  ON data_import_row_effects FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_data_import_row_effects" ON data_import_row_effects;
CREATE POLICY "delete_own_data_import_row_effects"
  ON data_import_row_effects FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- The original migration only allowed row-error INSERT/SELECT; the wizard's
-- "retry / clear" flows need DELETE on the account's own rows.
DROP POLICY IF EXISTS "delete_own_data_import_row_errors" ON data_import_row_errors;
CREATE POLICY "delete_own_data_import_row_errors"
  ON data_import_row_errors FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Permission gate
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_run_data_imports()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_flag text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  IF auth.uid() = v_owner THEN
    RETURN true;
  END IF;

  SELECT coalesce(cr.permissions ->> 'can_edit_business_profile', tm.permissions ->> 'can_edit_business_profile')
    INTO v_flag
    FROM team_members tm
    LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
   WHERE tm.account_owner_id = v_owner
     AND tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
   LIMIT 1;

  RETURN coalesce(v_flag::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_run_data_imports() TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_data_import_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service-role / internal callers have no auth.uid(); they are trusted.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.can_run_data_imports() THEN
    RAISE EXCEPTION 'Only the account owner or a member who can edit the business profile may run or roll back data imports'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_data_import_permission ON data_import_jobs;
CREATE TRIGGER trg_enforce_data_import_permission
  BEFORE INSERT OR UPDATE ON data_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_data_import_permission();

COMMENT ON TABLE data_import_row_effects IS
  'Records created/updated by an import run (with previous values for updates). Rollback replays this exactly: created rows are deleted, updated rows are restored.';
