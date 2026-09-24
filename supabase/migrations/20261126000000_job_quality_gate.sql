/*
  # Job Quality Gate — No Proof, No Close

  ## Why
  Nothing today stops a technician from dragging a job to "Completed" or an
  office admin from sending an invoice with zero proof of work. This adds a
  hard, server-side gate on BOTH of those transitions, reusing data that
  mostly already exists rather than duplicating it:
  - Photos          -> job_evidence_checks.photo_paths (20261122000000)
  - Part usage      -> job_parts_required.status = 'installed' (20260928000000)
  - Serial number   -> equipment.serial_number via job_equipment (20260927000001)
  - Safety evidence -> jobs.evidence_verified_at (20261122000000)
  Only signature and completion notes are genuinely new columns — this
  project has no e-signature capture yet (explicitly flagged as future
  scope in 20260912060000_quote_followups_and_financing.sql).

  ## What this does
  - Adds `completion_notes`, `customer_signature_data_url`,
    `customer_signature_name`, `customer_signature_at` to `jobs`.
  - `job_quality_requirements`: per-service_type config of which of the 7
    proof categories are required (mirrors `compliance_requirements`'
    shape from 20261122000000_compliance_dispatch_gate.sql). If a
    service_type has no row, sensible defaults apply (photos, signature,
    notes required out of the box; checklist/parts/serial/safety opt-in)
    so protection works immediately with zero setup.
  - `job_quality_checklist_templates` / `job_checklist_completions`: a
    business defines a per-service_type checklist; a job's checklist is
    "done" once every template item for its service_type has a
    completion row.
  - `job_quality_gate_report_for_row(jobs)` / `job_quality_gate_report(uuid)`:
    ONE function computing the full per-category ready/not-ready report,
    reused by both the trigger (source of truth) and the UI (live status,
    read-only, no way for the client to fake it).
  - `trg_enforce_job_quality_gate`: BEFORE UPDATE ON jobs. Fires only when
    job_status is transitioning INTO 'completed', or invoice_status is
    transitioning OUT of 'not_sent' for the first time. Raises an
    exception with a parseable "JOB_QUALITY_GATE_BLOCKED: <gap>,<gap>"
    message the client turns into a friendly checklist (see
    src/lib/jobQualityGate.ts). Already-completed historical jobs are
    never re-validated (OLD.job_status = 'completed' short-circuits it).
    invoice_status moving from 'sent' -> 'paid' is NOT re-gated — only the
    first move away from 'not_sent' is, so payment webhooks keep working.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, same as every other
  tenant-scoped table in this project.
*/

-- =============================================================
-- JOBS: new proof columns
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS completion_notes text,
  ADD COLUMN IF NOT EXISTS customer_signature_data_url text,
  ADD COLUMN IF NOT EXISTS customer_signature_name text,
  ADD COLUMN IF NOT EXISTS customer_signature_at timestamptz;

COMMENT ON COLUMN jobs.customer_signature_data_url IS
  'Base64 PNG data URL captured on a signature pad. Internal proof-of-work only — never expose in customer-portal selects.';

-- =============================================================
-- JOB_QUALITY_REQUIREMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS job_quality_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  service_type text NOT NULL,
  require_photos boolean NOT NULL DEFAULT true,
  require_checklist boolean NOT NULL DEFAULT false,
  require_part_usage boolean NOT NULL DEFAULT false,
  require_signature boolean NOT NULL DEFAULT true,
  require_serial_number boolean NOT NULL DEFAULT false,
  require_notes boolean NOT NULL DEFAULT true,
  require_safety_evidence boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, service_type)
);

CREATE INDEX IF NOT EXISTS idx_job_quality_requirements_user ON job_quality_requirements(user_id);

-- public.set_updated_at() already exists (20261122000000_compliance_dispatch_gate.sql)
DROP TRIGGER IF EXISTS trg_job_quality_requirements_updated_at ON job_quality_requirements;
CREATE TRIGGER trg_job_quality_requirements_updated_at
  BEFORE UPDATE ON job_quality_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE job_quality_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_quality_requirements" ON job_quality_requirements;
CREATE POLICY "select_own_job_quality_requirements" ON job_quality_requirements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_job_quality_requirements" ON job_quality_requirements;
CREATE POLICY "insert_own_job_quality_requirements" ON job_quality_requirements FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_job_quality_requirements" ON job_quality_requirements;
CREATE POLICY "update_own_job_quality_requirements" ON job_quality_requirements FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_job_quality_requirements" ON job_quality_requirements;
CREATE POLICY "delete_own_job_quality_requirements" ON job_quality_requirements FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB_QUALITY_CHECKLIST_TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS job_quality_checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  service_type text NOT NULL,
  item_label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_quality_checklist_templates_lookup
  ON job_quality_checklist_templates(user_id, service_type, sort_order);

ALTER TABLE job_quality_checklist_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_quality_checklist_templates" ON job_quality_checklist_templates;
CREATE POLICY "select_own_job_quality_checklist_templates" ON job_quality_checklist_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_job_quality_checklist_templates" ON job_quality_checklist_templates;
CREATE POLICY "insert_own_job_quality_checklist_templates" ON job_quality_checklist_templates FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_job_quality_checklist_templates" ON job_quality_checklist_templates;
CREATE POLICY "delete_own_job_quality_checklist_templates" ON job_quality_checklist_templates FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB_CHECKLIST_COMPLETIONS (per-job, which template items are checked)
-- =============================================================

CREATE TABLE IF NOT EXISTS job_checklist_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  template_item_id uuid NOT NULL REFERENCES job_quality_checklist_templates(id) ON DELETE CASCADE,
  completed_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, template_item_id)
);

CREATE INDEX IF NOT EXISTS idx_job_checklist_completions_job ON job_checklist_completions(job_id);

ALTER TABLE job_checklist_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_checklist_completions" ON job_checklist_completions;
CREATE POLICY "select_own_job_checklist_completions" ON job_checklist_completions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "insert_own_job_checklist_completions" ON job_checklist_completions;
CREATE POLICY "insert_own_job_checklist_completions" ON job_checklist_completions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "delete_own_job_checklist_completions" ON job_checklist_completions;
CREATE POLICY "delete_own_job_checklist_completions" ON job_checklist_completions FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));

-- =============================================================
-- THE REPORT — single source of truth, used by trigger AND the UI
-- =============================================================

CREATE OR REPLACE FUNCTION public.job_quality_gate_report_for_row(v_job jobs)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_req job_quality_requirements%ROWTYPE;
  v_checklist_total integer := 0;
  v_checklist_done integer := 0;
  v_parts_total integer := 0;
  v_parts_installed integer := 0;
  v_has_serial boolean := false;
  v_has_photos boolean := false;
  v_categories jsonb;
  v_gaps text[];
BEGIN
  SELECT * INTO v_req FROM job_quality_requirements
  WHERE user_id = v_job.user_id AND service_type = v_job.service_type;

  IF NOT FOUND THEN
    v_req.require_photos := true;
    v_req.require_checklist := false;
    v_req.require_part_usage := false;
    v_req.require_signature := true;
    v_req.require_serial_number := false;
    v_req.require_notes := true;
    v_req.require_safety_evidence := false;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM job_evidence_checks
    WHERE job_id = v_job.id AND COALESCE(array_length(photo_paths, 1), 0) > 0
  ) INTO v_has_photos;

  SELECT count(*) INTO v_checklist_total FROM job_quality_checklist_templates
  WHERE user_id = v_job.user_id AND service_type = v_job.service_type;
  IF v_checklist_total > 0 THEN
    SELECT count(*) INTO v_checklist_done FROM job_checklist_completions c
    WHERE c.job_id = v_job.id
      AND c.template_item_id IN (
        SELECT id FROM job_quality_checklist_templates
        WHERE user_id = v_job.user_id AND service_type = v_job.service_type
      );
  END IF;

  SELECT count(*) INTO v_parts_total FROM job_parts_required WHERE job_id = v_job.id;
  IF v_parts_total > 0 THEN
    SELECT count(*) INTO v_parts_installed FROM job_parts_required
    WHERE job_id = v_job.id AND status = 'installed';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM job_equipment je JOIN equipment e ON e.id = je.equipment_id
    WHERE je.job_id = v_job.id AND e.serial_number IS NOT NULL AND btrim(e.serial_number) <> ''
  ) INTO v_has_serial;

  v_categories := jsonb_build_object(
    'photos', jsonb_build_object('required', v_req.require_photos, 'satisfied', v_has_photos),
    'checklist', jsonb_build_object(
      'required', v_req.require_checklist,
      'satisfied', (v_checklist_total = 0 OR v_checklist_done >= v_checklist_total),
      'total', v_checklist_total, 'done', v_checklist_done
    ),
    'part_usage', jsonb_build_object(
      'required', v_req.require_part_usage,
      'satisfied', (v_parts_total = 0 OR v_parts_installed >= v_parts_total),
      'total', v_parts_total, 'installed', v_parts_installed
    ),
    'signature', jsonb_build_object('required', v_req.require_signature, 'satisfied', v_job.customer_signature_data_url IS NOT NULL),
    'serial_number', jsonb_build_object('required', v_req.require_serial_number, 'satisfied', v_has_serial),
    'notes', jsonb_build_object('required', v_req.require_notes, 'satisfied', (v_job.completion_notes IS NOT NULL AND btrim(v_job.completion_notes) <> '')),
    'safety_evidence', jsonb_build_object('required', v_req.require_safety_evidence, 'satisfied', v_job.evidence_verified_at IS NOT NULL)
  );

  SELECT array_agg(key ORDER BY key) INTO v_gaps
  FROM jsonb_each(v_categories) AS c(key, val)
  WHERE (val->>'required')::boolean = true AND (val->>'satisfied')::boolean = false;

  RETURN jsonb_build_object(
    'ready_to_close', COALESCE(array_length(v_gaps, 1), 0) = 0,
    'gaps', COALESCE(to_jsonb(v_gaps), '[]'::jsonb),
    'categories', v_categories
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.job_quality_gate_report(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT public.job_quality_gate_report_for_row(j) FROM jobs j WHERE j.id = p_job_id;
$$;

-- =============================================================
-- THE GATE — trigger on jobs
-- =============================================================

CREATE OR REPLACE FUNCTION public.enforce_job_quality_gate()
RETURNS trigger AS $$
DECLARE
  v_report jsonb;
  v_closing boolean;
  v_invoicing boolean;
  v_gap_list text;
BEGIN
  v_closing := NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed';
  v_invoicing := OLD.invoice_status = 'not_sent'
    AND NEW.invoice_status IS DISTINCT FROM OLD.invoice_status
    AND NEW.invoice_status <> 'not_sent';

  IF NOT (v_closing OR v_invoicing) THEN
    RETURN NEW;
  END IF;

  v_report := public.job_quality_gate_report_for_row(NEW);

  IF NOT (v_report->>'ready_to_close')::boolean THEN
    SELECT string_agg(x, ',') INTO v_gap_list FROM jsonb_array_elements_text(v_report->'gaps') AS x;
    RAISE EXCEPTION 'JOB_QUALITY_GATE_BLOCKED: %', v_gap_list USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_job_quality_gate ON jobs;
CREATE TRIGGER trg_enforce_job_quality_gate
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_job_quality_gate();
