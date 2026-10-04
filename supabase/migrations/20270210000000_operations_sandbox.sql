/*
  # Vireek Operations Sandbox

  ## Why
  "Run the business before changing the business." Owners simulate a decision
  (hire, reprice, new region, AI call coverage, SLA change) against a digital
  twin of the operation, then save the scenario so it can be reviewed, compared
  and revisited. The simulation itself runs in the browser from real data
  (see src/lib/operationsSandbox.ts); only the saved scenarios live here.

  ## Table
  operations_sandbox_runs
    - levers       the what-if inputs (array of { type, params })
    - assumptions  the calibration used (cost per technician, elasticity, ...)
    - verdict      recommended | proceed_with_guardrails | not_recommended | inconclusive
    - summary      compact result (confidence, probability of uplift, payback, key deltas)

  ## Safety
  - Saved runs are immutable evidence: clients can SELECT, INSERT and DELETE, never UPDATE.
  - Scenarios hold revenue and cost projections, so access is limited to the
    account owner and team members with can_view_billing.
  - Payload sizes are bounded by CHECK constraints.
*/

CREATE TABLE IF NOT EXISTS operations_sandbox_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  created_by uuid DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  levers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(levers) = 'array' AND jsonb_array_length(levers) <= 10),
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(assumptions) = 'object' AND pg_column_size(assumptions) <= 4096),
  verdict text NOT NULL
    CHECK (verdict IN ('recommended', 'proceed_with_guardrails', 'not_recommended', 'inconclusive')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object' AND pg_column_size(summary) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operations_sandbox_runs_user_created
  ON operations_sandbox_runs(user_id, created_at DESC);

ALTER TABLE operations_sandbox_runs ENABLE ROW LEVEL SECURITY;

-- Owner, or a team member who may view billing.
CREATE OR REPLACE FUNCTION public.can_use_operations_sandbox()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE lower(tm.member_email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false) = true
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_use_operations_sandbox() TO authenticated;

DROP POLICY IF EXISTS "select_own_operations_sandbox_runs" ON operations_sandbox_runs;
CREATE POLICY "select_own_operations_sandbox_runs" ON operations_sandbox_runs
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_use_operations_sandbox());

DROP POLICY IF EXISTS "insert_own_operations_sandbox_runs" ON operations_sandbox_runs;
CREATE POLICY "insert_own_operations_sandbox_runs" ON operations_sandbox_runs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_use_operations_sandbox());

DROP POLICY IF EXISTS "delete_own_operations_sandbox_runs" ON operations_sandbox_runs;
CREATE POLICY "delete_own_operations_sandbox_runs" ON operations_sandbox_runs
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_use_operations_sandbox());

GRANT SELECT, INSERT, DELETE ON operations_sandbox_runs TO authenticated;

COMMENT ON TABLE operations_sandbox_runs IS
  'Saved what-if scenarios from the Operations Sandbox (digital twin). Immutable: select / insert / delete only.';
