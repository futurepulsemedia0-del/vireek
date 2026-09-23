/*
  # Compliance-Driven Dispatch Gate

  ## Why
  jobs.assigned_technician_id is set through exactly one choke point today:
  public.assign_technician_to_job() (SECURITY DEFINER, 20260925000000 /
  20261013000000) — called by the manual "Assign" button on the Dispatch
  Board, by the trg_auto_dispatch_technician BEFORE INSERT/UPDATE trigger
  on jobs, AND by the dispatch-auto-assign edge function (which calls the
  same RPC via _shared/dispatch/assign.ts). There was no concept anywhere
  of a technician's license/certification/permit/training being valid —
  meaning an uncertified tech could get auto-dispatched to, say, a gas
  leak or an EPA-regulated refrigerant job.

  ## What this does
  - `technician_credentials`: one row per license/cert/permit/training a
    technician holds. `status = 'active'` + `expires_at` in the future
    (or null = doesn't expire) is what counts as currently valid.
  - `compliance_requirements`: the business's own rules — "service_type X
    requires credential_type Y"; `is_blocking = true` means dispatch is
    hard-blocked without it, `false` means it's tracked but advisory only
    (this migration only enforces blocking rules in the SQL gate itself;
    non-blocking rules are informational, surfaced on the Compliance
    Center page for the office to watch).
  - `technician_compliance_gaps(p_technician_id, p_service_type)`: returns
    the list of missing/expired blocking credential_types for that
    tech+service combo. Empty array = clear to dispatch.
  - `pick_best_technician` and `assign_technician_to_job` are replaced
    (SAME signatures) to skip/reject technicians with a blocking gap —
    same shape as the existing at-capacity check, just one more filter.
  - `technician_capacity_events.outcome` CHECK widened to add
    'blocked_compliance', so the manual-assign path returns a proper
    audited status the existing DispatchBoardPage.tsx toast
    (`toast(data.reason)`) already displays without any UI change.
  - `technician_compliance_flags` view: one boolean per technician —
    "has a blocking gap for at least one of their listed skills" — for a
    quick badge on the Dispatch Board (optional, see notes at bottom of
    this file).
  - Expiry alerts: `notify_credential_expiry` on profiles,
    `credential_id` on notifications, same pattern as
    20260928000000_warranty_intelligence.sql. Actual detection lives in
    supabase/functions/check-credential-expirations/index.ts (scheduled,
    same as check-warranty-alerts).

  ## RLS
  Same ownership pattern as every other per-tenant table in this project.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- TECHNICIAN_CREDENTIALS
-- =============================================================

CREATE TABLE IF NOT EXISTS technician_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  credential_type text NOT NULL,
  credential_name text,
  issuing_authority text,
  credential_number text,
  issued_at date,
  expires_at date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'pending_renewal')),
  expiry_alert_stage text CHECK (expiry_alert_stage IN ('expiring_soon', 'expired')),
  expiry_alert_sent_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_technician_credentials_technician ON technician_credentials(technician_id, credential_type);
CREATE INDEX IF NOT EXISTS idx_technician_credentials_user ON technician_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_technician_credentials_expires
  ON technician_credentials(expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

DROP TRIGGER IF EXISTS trg_technician_credentials_updated_at ON technician_credentials;
CREATE TRIGGER trg_technician_credentials_updated_at
  BEFORE UPDATE ON technician_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION reset_credential_alert_stage()
RETURNS trigger AS $$
BEGIN
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.expiry_alert_stage := NULL;
    NEW.expiry_alert_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reset_credential_alert_stage ON technician_credentials;
CREATE TRIGGER trg_reset_credential_alert_stage
  BEFORE UPDATE ON technician_credentials
  FOR EACH ROW EXECUTE FUNCTION reset_credential_alert_stage();

ALTER TABLE technician_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_technician_credentials" ON technician_credentials;
CREATE POLICY "select_own_technician_credentials" ON technician_credentials FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_technician_credentials" ON technician_credentials;
CREATE POLICY "insert_own_technician_credentials" ON technician_credentials FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_technician_credentials" ON technician_credentials;
CREATE POLICY "update_own_technician_credentials" ON technician_credentials FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_technician_credentials" ON technician_credentials;
CREATE POLICY "delete_own_technician_credentials" ON technician_credentials FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- COMPLIANCE_REQUIREMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS compliance_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  service_type text NOT NULL,
  credential_type text NOT NULL,
  credential_label text,
  is_blocking boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, service_type, credential_type)
);

CREATE INDEX IF NOT EXISTS idx_compliance_requirements_user ON compliance_requirements(user_id);

ALTER TABLE compliance_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_compliance_requirements" ON compliance_requirements;
CREATE POLICY "select_own_compliance_requirements" ON compliance_requirements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_compliance_requirements" ON compliance_requirements;
CREATE POLICY "insert_own_compliance_requirements" ON compliance_requirements FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_compliance_requirements" ON compliance_requirements;
CREATE POLICY "update_own_compliance_requirements" ON compliance_requirements FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_compliance_requirements" ON compliance_requirements;
CREATE POLICY "delete_own_compliance_requirements" ON compliance_requirements FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- THE GATE — technician_compliance_gaps()
-- =============================================================

CREATE OR REPLACE FUNCTION public.technician_compliance_gaps(
  p_technician_id uuid,
  p_service_type text
)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT cr.credential_type ORDER BY cr.credential_type), '{}')
  FROM compliance_requirements cr
  WHERE cr.user_id = (SELECT tm.account_owner_id FROM team_members tm WHERE tm.id = p_technician_id)
    AND cr.is_blocking = true
    AND cr.service_type = p_service_type
    AND NOT EXISTS (
      SELECT 1 FROM technician_credentials tc
      WHERE tc.technician_id = p_technician_id
        AND tc.credential_type = cr.credential_type
        AND tc.status = 'active'
        AND (tc.expires_at IS NULL OR tc.expires_at >= CURRENT_DATE)
    );
$$;

-- Quick per-technician badge: does this tech have a blocking gap for ANY
-- of their listed skills (not tied to one specific job)? Used on the
-- Dispatch Board suggestion list — see notes at the bottom of this file.
CREATE OR REPLACE VIEW technician_compliance_flags
WITH (security_invoker = true) AS
SELECT
  tm.id AS technician_id,
  tm.account_owner_id AS user_id,
  tm.member_name,
  EXISTS (
    SELECT 1 FROM unnest(tm.skills) AS s(service_type)
    WHERE array_length(public.technician_compliance_gaps(tm.id, s.service_type), 1) > 0
  ) AS has_compliance_gap
FROM team_members tm
WHERE tm.role = 'technician';

COMMENT ON VIEW technician_compliance_flags IS
  'One row per technician: whether they have a blocking compliance gap for at least one of their listed skills. security_invoker=true so it always applies the querying user''s own RLS.';

-- =============================================================
-- pick_best_technician -- same signature, + compliance filter
-- (full body copied from 20261013000000_advanced_routing.sql with one
-- added line, since CREATE OR REPLACE needs the complete function)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pick_best_technician(
  p_user_id uuid,
  p_service_type text,
  p_address text,
  p_scheduled_datetime timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_best_id uuid;
BEGIN
  IF p_scheduled_datetime IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM team_members
  WHERE account_owner_id = p_user_id AND role = 'technician' AND dispatch_enabled = true
  ORDER BY id
  FOR UPDATE;

  SELECT c.id INTO v_best_id
  FROM (
    SELECT
      tm.id,
      tm.max_jobs_per_day,
      tm.skills,
      tm.service_area,
      (
        SELECT count(*) FROM jobs j
        WHERE j.assigned_technician_id = tm.id
          AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
          AND date_trunc('day', j.scheduled_datetime) = date_trunc('day', p_scheduled_datetime)
      ) AS today_load,
      COALESCE(tm.current_latitude, tm.home_latitude) AS tech_lat,
      COALESCE(tm.current_longitude, tm.home_longitude) AS tech_lon
    FROM team_members tm
    WHERE tm.account_owner_id = p_user_id AND tm.role = 'technician' AND tm.dispatch_enabled = true
  ) c
  LEFT JOIN LATERAL (
    SELECT j.latitude, j.longitude FROM jobs j
    WHERE j.address = p_address AND j.latitude IS NOT NULL
    ORDER BY j.geocoded_at DESC NULLS LAST
    LIMIT 1
  ) job_loc ON true
  WHERE c.today_load < c.max_jobs_per_day
    -- COMPLIANCE GATE: skip any technician missing a blocking credential
    -- for this job's service type.
    AND COALESCE(array_length(public.technician_compliance_gaps(c.id, p_service_type), 1), 0) = 0
  ORDER BY
    (
      (c.max_jobs_per_day - c.today_load) * 2
      + CASE WHEN p_service_type IS NOT NULL AND p_service_type = ANY(c.skills) THEN 10 ELSE 0 END
      + CASE WHEN c.service_area IS NOT NULL AND p_address IS NOT NULL AND p_address ILIKE '%' || c.service_area || '%' THEN 5 ELSE 0 END
      + CASE WHEN c.tech_lat IS NOT NULL AND job_loc.latitude IS NOT NULL
          THEN GREATEST(0, 20 - public.haversine_miles(c.tech_lat, c.tech_lon, job_loc.latitude, job_loc.longitude))
          ELSE 0
        END
    ) DESC
  LIMIT 1;

  RETURN v_best_id;
END;
$$;

-- =============================================================
-- technician_capacity_events.outcome -- widen CHECK for the new status
-- =============================================================

ALTER TABLE technician_capacity_events DROP CONSTRAINT IF EXISTS technician_capacity_events_outcome_check;
ALTER TABLE technician_capacity_events ADD CONSTRAINT technician_capacity_events_outcome_check
  CHECK (outcome IN ('assigned', 'at_capacity', 'no_technician_available', 'not_found', 'blocked_compliance'));

-- =============================================================
-- assign_technician_to_job -- same signature, + compliance gate on both
-- the explicit-technician branch and the auto-pick loop
-- =============================================================

CREATE OR REPLACE FUNCTION public.assign_technician_to_job(p_job_id uuid, p_technician_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  v_day date;
  v_tech record;
  v_load integer;
  v_capacity integer;
  v_gaps text[];
  v_best_id uuid;
  v_best_name text;
  v_best_load integer;
  v_best_capacity integer;
  v_best_score numeric := -1;
  v_score numeric;
  v_any_tech boolean := false;
  v_result jsonb;
BEGIN
  SELECT id, user_id, service_type, address, scheduled_datetime, job_status, latitude, longitude
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;

  IF v_job.user_id <> public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  v_day := COALESCE(v_job.scheduled_datetime, now())::date;

  IF p_technician_id IS NOT NULL THEN
    SELECT id, member_name, max_jobs_per_day
    INTO v_tech
    FROM team_members
    WHERE id = p_technician_id AND account_owner_id = v_job.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'reason', 'Technician not found.');
    END IF;

    v_capacity := COALESCE(v_tech.max_jobs_per_day, 6);
    SELECT count(*) INTO v_load FROM jobs
    WHERE assigned_technician_id = p_technician_id
      AND job_status IN ('scheduled', 'en_route', 'in_progress')
      AND scheduled_datetime::date = v_day
      AND id <> p_job_id;

    IF v_load >= v_capacity THEN
      v_result := jsonb_build_object(
        'status', 'at_capacity', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
        'day_load', v_load, 'capacity', v_capacity,
        'reason', format('%s already has %s of %s jobs for that day.', v_tech.member_name, v_load, v_capacity)
      );
      INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
      VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'at_capacity', v_load, v_capacity);
      RETURN v_result;
    END IF;

    -- COMPLIANCE GATE: block manual assignment if this technician is
    -- missing a blocking credential for this job's service type.
    v_gaps := public.technician_compliance_gaps(p_technician_id, v_job.service_type);
    IF array_length(v_gaps, 1) > 0 THEN
      v_result := jsonb_build_object(
        'status', 'blocked_compliance', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
        'gaps', to_jsonb(v_gaps),
        'reason', format('%s is missing required credentials for this job: %s.', v_tech.member_name, array_to_string(v_gaps, ', '))
      );
      INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
      VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'blocked_compliance', v_load, v_capacity);
      RETURN v_result;
    END IF;

    UPDATE jobs SET assigned_technician_id = p_technician_id WHERE id = p_job_id;
    INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
    VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'assigned', v_load + 1, v_capacity);

    RETURN jsonb_build_object(
      'status', 'assigned', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
      'day_load', v_load + 1, 'capacity', v_capacity
    );
  END IF;

  FOR v_tech IN
    SELECT id, member_name, skills, service_area, max_jobs_per_day,
           COALESCE(current_latitude, home_latitude) AS tech_lat,
           COALESCE(current_longitude, home_longitude) AS tech_lon
    FROM team_members
    WHERE account_owner_id = v_job.user_id AND role = 'technician' AND invite_status = 'active' AND dispatch_enabled = true
    ORDER BY id
    FOR UPDATE
  LOOP
    v_any_tech := true;
    v_capacity := COALESCE(v_tech.max_jobs_per_day, 6);
    SELECT count(*) INTO v_load FROM jobs
    WHERE assigned_technician_id = v_tech.id
      AND job_status IN ('scheduled', 'en_route', 'in_progress')
      AND scheduled_datetime::date = v_day
      AND id <> p_job_id;

    CONTINUE WHEN v_load >= v_capacity;

    -- COMPLIANCE GATE: never auto-pick a technician with a blocking gap.
    CONTINUE WHEN array_length(public.technician_compliance_gaps(v_tech.id, v_job.service_type), 1) > 0;

    v_score := (v_capacity - v_load) * 2;
    IF v_job.service_type IS NOT NULL AND v_job.service_type = ANY(v_tech.skills) THEN v_score := v_score + 10; END IF;
    IF v_tech.service_area IS NOT NULL AND v_job.address IS NOT NULL AND v_job.address ILIKE '%' || v_tech.service_area || '%' THEN
      v_score := v_score + 5;
    END IF;

    IF v_tech.tech_lat IS NOT NULL AND v_job.latitude IS NOT NULL THEN
      v_score := v_score + GREATEST(0, 20 - public.haversine_miles(v_tech.tech_lat, v_tech.tech_lon, v_job.latitude, v_job.longitude));
    END IF;

    IF v_score > v_best_score THEN
      v_best_score := v_score;
      v_best_id := v_tech.id;
      v_best_name := v_tech.member_name;
      v_best_load := v_load;
      v_best_capacity := v_capacity;
    END IF;
  END LOOP;

  IF NOT v_any_tech THEN
    INSERT INTO technician_capacity_events (user_id, job_id, outcome)
    VALUES (v_job.user_id, p_job_id, 'no_technician_available');
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'No dispatch-enabled technicians on the team.');
  END IF;

  IF v_best_id IS NULL THEN
    INSERT INTO technician_capacity_events (user_id, job_id, outcome)
    VALUES (v_job.user_id, p_job_id, 'no_technician_available');
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'Every technician is either at capacity or missing a required credential for this job.');
  END IF;

  UPDATE jobs SET assigned_technician_id = v_best_id WHERE id = p_job_id;
  INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
  VALUES (v_job.user_id, p_job_id, v_best_id, v_best_name, 'assigned', v_best_load + 1, v_best_capacity);

  RETURN jsonb_build_object(
    'status', 'assigned', 'technician_id', v_best_id, 'technician_name', v_best_name,
    'day_load', v_best_load + 1, 'capacity', v_best_capacity,
    'reason', 'Assigned by AI Dispatcher -- best skill/service-area/capacity/proximity match, compliance-checked.'
  );
END;
$$;

-- =============================================================
-- Expiry alerts (profiles / notifications)
-- =============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_credential_expiry boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS credential_id uuid REFERENCES technician_credentials(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_credential_id
  ON notifications(credential_id)
  WHERE credential_id IS NOT NULL;

/*
  ## Optional: Dispatch Board badge (frontend, not required for the gate)
  technician_compliance_flags (above) can be fetched once per board load
  and used to show a red "Compliance hold" badge next to a technician's
  name in the suggestion list — purely cosmetic, since the real block
  already happens server-side inside assign_technician_to_job() no matter
  which button/trigger/edge-function calls it.
*/
