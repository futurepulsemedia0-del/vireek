/*
  Vireek Resolution Probability Engine

  Adds: rpe_settings (target, floor, failed-visit cost) and rpe_assessments
  (saved pre-dispatch assessments, used to calibrate the model against real
  outcomes). Purely additive; independent of First-Time-Fix Autopilot.
  Reads are open to the whole account; writes are limited to owners, admins
  and billing managers.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

CREATE OR REPLACE FUNCTION public.rpe_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.rpe_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpe_is_manager() TO authenticated;

-- 1) Settings (one row per account) -------------------------------------------
CREATE TABLE IF NOT EXISTS rpe_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  threshold smallint NOT NULL DEFAULT 80 CHECK (threshold BETWEEN 50 AND 95),
  floor smallint NOT NULL DEFAULT 60 CHECK (floor BETWEEN 20 AND 90),
  truck_roll_cost_cents integer NOT NULL DEFAULT 18000 CHECK (truck_roll_cost_cents BETWEEN 0 AND 10000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (floor < threshold)
);

-- 2) Saved assessments (for calibration) --------------------------------------
CREATE TABLE IF NOT EXISTS rpe_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  probability smallint NOT NULL CHECK (probability BETWEEN 0 AND 100),
  verdict text NOT NULL CHECK (verdict IN ('dispatch', 'improve', 'hold')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  recommendation text NOT NULL DEFAULT '',
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, technician_id)
);
CREATE INDEX IF NOT EXISTS idx_rpe_assessments_owner ON rpe_assessments (account_owner_id, updated_at DESC);

-- RLS -------------------------------------------------------------------------
ALTER TABLE rpe_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpe_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rpe_settings_read" ON rpe_settings;
CREATE POLICY "rpe_settings_read" ON rpe_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "rpe_settings_insert" ON rpe_settings;
CREATE POLICY "rpe_settings_insert" ON rpe_settings FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager());

DROP POLICY IF EXISTS "rpe_settings_update" ON rpe_settings;
CREATE POLICY "rpe_settings_update" ON rpe_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager());

-- Assessments: managers only (they carry per-technician performance signals); no DELETE.
DROP POLICY IF EXISTS "rpe_assessments_read" ON rpe_assessments;
CREATE POLICY "rpe_assessments_read" ON rpe_assessments FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager());

DROP POLICY IF EXISTS "rpe_assessments_insert" ON rpe_assessments;
CREATE POLICY "rpe_assessments_insert" ON rpe_assessments FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.rpe_is_manager()
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM team_members m WHERE m.id = technician_id AND m.account_owner_id = public.get_account_owner_id())
  );

DROP POLICY IF EXISTS "rpe_assessments_update" ON rpe_assessments;
CREATE POLICY "rpe_assessments_update" ON rpe_assessments FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.rpe_is_manager());
