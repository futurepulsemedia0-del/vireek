/*
  Vireek First-Time-Fix Autopilot

  Adds: ftf_settings, service_tool_requirements, technician_tools, ftf_predictions.
  Purely additive. Reads are open to the whole account (so dispatchers get the
  gate); writes are limited to owners/admins/billing managers.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

CREATE OR REPLACE FUNCTION public.ftf_is_manager()
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

REVOKE ALL ON FUNCTION public.ftf_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ftf_is_manager() TO authenticated;

-- 1) Settings (one row per account) -------------------------------------------
CREATE TABLE IF NOT EXISTS ftf_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  threshold smallint NOT NULL DEFAULT 75 CHECK (threshold BETWEEN 40 AND 95),
  enforcement text NOT NULL DEFAULT 'warn' CHECK (enforcement IN ('off', 'warn', 'hold')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) Special tools required per service type ----------------------------------
CREATE TABLE IF NOT EXISTS service_tool_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  service_type text NOT NULL CHECK (length(btrim(service_type)) > 0),
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_tool_requirements
  ON service_tool_requirements (account_owner_id, lower(btrim(service_type)), lower(btrim(tool_name)));

-- 3) Special tools each technician holds --------------------------------------
CREATE TABLE IF NOT EXISTS technician_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_tools
  ON technician_tools (team_member_id, lower(btrim(tool_name)));

-- 4) Saved predictions (for calibration) --------------------------------------
CREATE TABLE IF NOT EXISTS ftf_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  probability smallint NOT NULL CHECK (probability BETWEEN 0 AND 100),
  verdict text NOT NULL CHECK (verdict IN ('go', 'review', 'hold')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, technician_id)
);
CREATE INDEX IF NOT EXISTS idx_ftf_predictions_owner ON ftf_predictions (account_owner_id, updated_at DESC);

-- RLS -------------------------------------------------------------------------
ALTER TABLE ftf_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_tool_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE ftf_predictions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ftf_settings', 'service_tool_requirements', 'technician_tools']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id())', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager())', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager()) WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager())', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager())', t || '_delete', t);
  END LOOP;
END $$;

-- Predictions: managers only (they contain per-technician performance signals); no DELETE.
DROP POLICY IF EXISTS "ftf_predictions_read" ON ftf_predictions;
CREATE POLICY "ftf_predictions_read" ON ftf_predictions FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager());

DROP POLICY IF EXISTS "ftf_predictions_insert" ON ftf_predictions;
CREATE POLICY "ftf_predictions_insert" ON ftf_predictions FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.ftf_is_manager()
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM team_members m WHERE m.id = technician_id AND m.account_owner_id = public.get_account_owner_id())
  );

DROP POLICY IF EXISTS "ftf_predictions_update" ON ftf_predictions;
CREATE POLICY "ftf_predictions_update" ON ftf_predictions FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.ftf_is_manager());
