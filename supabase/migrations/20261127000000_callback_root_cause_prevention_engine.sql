/*
  # Callback Root-Cause & Prevention Engine

  ## Why
  jobs.is_rework / jobs.rework_of_job_id (20260923000000_rework_intelligence.sql)
  already flags a "callback" the moment a second job comes in for the same
  customer + service type within the configured window — that detection is
  ground truth and is never re-done here. What's missing is WHY it happened
  and what to do about it. This links each callback to the technician who
  did the original visit, the equipment involved (job_equipment ->
  equipment), the parts installed (job_parts_required, status='installed'),
  and the job type (service_type), then uses an AI narrative layer (same
  shape as capacity_demand_narrative) to assign a root-cause category and a
  concrete prevention action — grounded ONLY in facts fetched under RLS,
  never invented.

  ## What this does
  - `jobs.technician_diagnosis`: free-text field the technician fills in at
    job completion — what they found and did. Optional. This is the
    primary signal the AI compares between the original and callback visit.
  - `callback_root_cause_analyses`: one row per analyzed callback — the AI's
    root_cause_category + confidence + summary + recommended action, plus
    the technician/equipment/part/service_type it's linked to so patterns
    can be aggregated client-side (src/lib/callbackRootCause.ts).
  - `callback_prevention_workflows`: manager-created action items, one per
    recurring pattern (e.g. "Tech X + misdiagnosis, seen 3 times"), created
    on demand from the UI — not an automatic trigger, matching this
    project's existing snapshot-on-demand pattern (technician_scorecards).

  ## RLS
  Same ownership pattern as every other per-tenant table in this project
  (public.get_account_owner_id()).
*/

-- =============================================================
-- JOBS: technician's own diagnosis note
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS technician_diagnosis text;

COMMENT ON COLUMN jobs.technician_diagnosis IS
  'Free-text: what the technician found and did on this visit. Optional. Primary input to the callback root-cause engine.';

-- =============================================================
-- CALLBACK_ROOT_CAUSE_ANALYSES
-- =============================================================

CREATE TABLE IF NOT EXISTS callback_root_cause_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  callback_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  original_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  service_type text,
  root_cause_category text NOT NULL CHECK (root_cause_category IN (
    'misdiagnosis', 'incomplete_repair', 'defective_part', 'wrong_part_installed',
    'installation_error', 'missed_related_issue', 'customer_misuse',
    'pre_existing_unrelated', 'unknown'
  )),
  confidence numeric(4,2) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  ai_summary text,
  recommended_prevention_action text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (callback_job_id)
);

CREATE INDEX IF NOT EXISTS idx_callback_rca_user ON callback_root_cause_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_callback_rca_technician ON callback_root_cause_analyses(technician_id);
CREATE INDEX IF NOT EXISTS idx_callback_rca_part ON callback_root_cause_analyses(part_id);
CREATE INDEX IF NOT EXISTS idx_callback_rca_equipment ON callback_root_cause_analyses(equipment_id);
CREATE INDEX IF NOT EXISTS idx_callback_rca_category ON callback_root_cause_analyses(user_id, root_cause_category);

ALTER TABLE callback_root_cause_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_callback_rca" ON callback_root_cause_analyses;
CREATE POLICY "select_own_callback_rca" ON callback_root_cause_analyses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_callback_rca" ON callback_root_cause_analyses;
CREATE POLICY "insert_own_callback_rca" ON callback_root_cause_analyses FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_callback_rca" ON callback_root_cause_analyses;
CREATE POLICY "update_own_callback_rca" ON callback_root_cause_analyses FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_callback_rca" ON callback_root_cause_analyses;
CREATE POLICY "delete_own_callback_rca" ON callback_root_cause_analyses FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CALLBACK_PREVENTION_WORKFLOWS
-- =============================================================

CREATE TABLE IF NOT EXISTS callback_prevention_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  pattern_key text NOT NULL,
  pattern_type text NOT NULL CHECK (pattern_type IN ('technician', 'part', 'equipment_type', 'job_type')),
  title text NOT NULL,
  description text NOT NULL,
  recommended_action text NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_callback_prevention_workflows_user ON callback_prevention_workflows(user_id, status);

ALTER TABLE callback_prevention_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_callback_prevention_workflows" ON callback_prevention_workflows;
CREATE POLICY "select_own_callback_prevention_workflows" ON callback_prevention_workflows FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_callback_prevention_workflows" ON callback_prevention_workflows;
CREATE POLICY "insert_own_callback_prevention_workflows" ON callback_prevention_workflows FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_callback_prevention_workflows" ON callback_prevention_workflows;
CREATE POLICY "update_own_callback_prevention_workflows" ON callback_prevention_workflows FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_callback_prevention_workflows" ON callback_prevention_workflows;
CREATE POLICY "delete_own_callback_prevention_workflows" ON callback_prevention_workflows FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());
