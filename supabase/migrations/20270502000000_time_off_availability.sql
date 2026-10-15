/*
  # Time Off, Availability & Blackouts — /dashboard/time-off

  ## Why
  Dispatch, capacity and auto-assign knew nothing about people being away. This adds three account-scoped
  sources of truth and makes the database refuse (or skip) unavailable technicians everywhere:

    technician_time_off      — approved PTO / sick / training / personal days (cancel, never delete)
    technician_availability  — optional weekly working days per technician
                               (NO row = available every day, so nothing changes until a manager configures it)
    company_blackout_dates   — dates when nobody is dispatched (holidays, shutdowns)

  ## Enforcement (day granularity, same as the existing per-day capacity logic)
  - technician_unavailable_reason(technician, day): blackout > time off > weekly pattern. Internal only.
  - assign_technician_to_job(): rebuilt from the latest definition in 20261122000000_compliance_dispatch_gate.sql
    with an availability gate on the explicit-technician branch (status 'blocked_time_off') and on the
    auto-pick loop (unavailable technicians are skipped).
  - Trigger on jobs.assigned_technician_id: any other path that assigns a technician on an unavailable day
    gets a clear exception instead of silently creating a conflict. Re-scheduling an already assigned job
    is NOT blocked (customers must keep being able to reschedule); the page flags it as a conflict.

  ## Security
  - RLS: every member of the account can read; only owner / can_manage_team members can write.
  - Time-off and blackout rows are append-only: the guard trigger only lets status move approved/active -> cancelled.
  - Inserts must reference a technician that belongs to the same account.

  ## IMPORTANT before applying
  assign_technician_to_job() is replaced as a whole. If you changed it after 20261122000000, compare first:
    select pg_get_functiondef('public.assign_technician_to_job(uuid, uuid)'::regprocedure);
  and port your changes into the function below (the two gates are marked "AVAILABILITY GATE").
*/

-- =============================================================
-- Permission helper (owner, else can_manage_team; custom role overrides the member flag)
-- =============================================================

CREATE OR REPLACE FUNCTION public.time_off_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      OR EXISTS (
        SELECT 1
        FROM team_members tm
        LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
        WHERE tm.user_id = auth.uid()
          AND COALESCE(
            CASE WHEN cr.permissions ? 'can_manage_team' THEN (cr.permissions -> 'can_manage_team') = 'true'::jsonb END,
            (tm.permissions -> 'can_manage_team') = 'true'::jsonb,
            false
          )
      );
$$;

-- =============================================================
-- TECHNICIAN_TIME_OFF
-- =============================================================

CREATE TABLE IF NOT EXISTS technician_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'pto' CHECK (kind IN ('pto', 'sick', 'training', 'personal', 'other')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'cancelled')),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_time_off_range CHECK (end_date >= start_date AND end_date - start_date < 366)
);

CREATE INDEX IF NOT EXISTS idx_technician_time_off_account
  ON technician_time_off (user_id, start_date, end_date) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_technician_time_off_technician
  ON technician_time_off (technician_id, start_date, end_date) WHERE status = 'approved';

ALTER TABLE technician_time_off ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_time_off" ON technician_time_off;
CREATE POLICY "select_account_time_off" ON technician_time_off FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_time_off" ON technician_time_off;
CREATE POLICY "insert_account_time_off" ON technician_time_off FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND status = 'approved'
    AND public.time_off_can_manage()
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = technician_time_off.technician_id AND tm.account_owner_id = technician_time_off.user_id)
  );

DROP POLICY IF EXISTS "update_account_time_off" ON technician_time_off;
CREATE POLICY "update_account_time_off" ON technician_time_off FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
-- No DELETE policy on purpose: cancel instead, so there is always an audit trail.

CREATE OR REPLACE FUNCTION public.guard_time_off_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled entry cannot be reinstated. Create a new one instead.' USING ERRCODE = '55000';
    END IF;
    -- Only the status may change.
    NEW.user_id := OLD.user_id;
    NEW.technician_id := OLD.technician_id;
    NEW.kind := OLD.kind;
    NEW.start_date := OLD.start_date;
    NEW.end_date := OLD.end_date;
    NEW.note := OLD.note;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_time_off_row ON technician_time_off;
CREATE TRIGGER trg_guard_time_off_row
  BEFORE INSERT OR UPDATE ON technician_time_off
  FOR EACH ROW EXECUTE FUNCTION public.guard_time_off_row();

-- =============================================================
-- COMPANY_BLACKOUT_DATES
-- =============================================================

CREATE TABLE IF NOT EXISTS company_blackout_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_blackout_dates_range CHECK (end_date >= start_date AND end_date - start_date < 366)
);

CREATE INDEX IF NOT EXISTS idx_company_blackout_dates_account
  ON company_blackout_dates (user_id, start_date, end_date) WHERE status = 'active';

ALTER TABLE company_blackout_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_blackouts" ON company_blackout_dates;
CREATE POLICY "select_account_blackouts" ON company_blackout_dates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_blackouts" ON company_blackout_dates;
CREATE POLICY "insert_account_blackouts" ON company_blackout_dates FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND status = 'active'
    AND public.time_off_can_manage()
  );

DROP POLICY IF EXISTS "update_account_blackouts" ON company_blackout_dates;
CREATE POLICY "update_account_blackouts" ON company_blackout_dates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());

CREATE OR REPLACE FUNCTION public.guard_blackout_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.label := btrim(NEW.label);
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled blackout cannot be reinstated. Create a new one instead.' USING ERRCODE = '55000';
    END IF;
    NEW.user_id := OLD.user_id;
    NEW.label := OLD.label;
    NEW.start_date := OLD.start_date;
    NEW.end_date := OLD.end_date;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_blackout_row ON company_blackout_dates;
CREATE TRIGGER trg_guard_blackout_row
  BEFORE INSERT OR UPDATE ON company_blackout_dates
  FOR EACH ROW EXECUTE FUNCTION public.guard_blackout_row();

-- =============================================================
-- TECHNICIAN_AVAILABILITY (weekly working days; 0 = Sunday, matching extract(dow))
-- =============================================================

CREATE TABLE IF NOT EXISTS technician_availability (
  technician_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  working_days smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_availability_days CHECK (working_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

CREATE INDEX IF NOT EXISTS idx_technician_availability_account ON technician_availability (user_id);

ALTER TABLE technician_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_availability" ON technician_availability;
CREATE POLICY "select_account_availability" ON technician_availability FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_availability" ON technician_availability;
CREATE POLICY "insert_account_availability" ON technician_availability FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.time_off_can_manage()
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = technician_availability.technician_id AND tm.account_owner_id = technician_availability.user_id)
  );

DROP POLICY IF EXISTS "update_account_availability" ON technician_availability;
CREATE POLICY "update_account_availability" ON technician_availability FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());

CREATE OR REPLACE FUNCTION public.guard_availability_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  IF TG_OP = 'UPDATE' THEN
    NEW.technician_id := OLD.technician_id;
    NEW.user_id := OLD.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_availability_row ON technician_availability;
CREATE TRIGGER trg_guard_availability_row
  BEFORE INSERT OR UPDATE ON technician_availability
  FOR EACH ROW EXECUTE FUNCTION public.guard_availability_row();

-- =============================================================
-- Resolver (mirrors unavailability() in src/lib/timeOff.ts). Internal: not callable by clients.
-- =============================================================

CREATE OR REPLACE FUNCTION public.technician_unavailable_reason(p_technician_id uuid, p_day date)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_label text;
  v_kind text;
  v_days smallint[];
BEGIN
  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = p_technician_id;
  IF v_owner IS NULL OR p_day IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT label INTO v_label FROM company_blackout_dates
  WHERE user_id = v_owner AND status = 'active' AND p_day BETWEEN start_date AND end_date
  ORDER BY start_date LIMIT 1;
  IF FOUND THEN
    RETURN 'Company blackout: ' || v_label;
  END IF;

  SELECT kind INTO v_kind FROM technician_time_off
  WHERE technician_id = p_technician_id AND status = 'approved' AND p_day BETWEEN start_date AND end_date
  ORDER BY start_date LIMIT 1;
  IF FOUND THEN
    RETURN CASE v_kind
      WHEN 'pto' THEN 'On PTO'
      WHEN 'sick' THEN 'Out sick'
      WHEN 'training' THEN 'In training'
      WHEN 'personal' THEN 'Personal day'
      ELSE 'Out of office'
    END;
  END IF;

  SELECT working_days INTO v_days FROM technician_availability WHERE technician_id = p_technician_id;
  IF FOUND AND NOT (extract(dow FROM p_day)::smallint = ANY (v_days)) THEN
    RETURN 'Not scheduled on ' || (ARRAY['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])[extract(dow FROM p_day)::int + 1] || 's';
  END IF;

  RETURN NULL;
END;
$$;

-- =============================================================
-- Safety net: any path that assigns a technician on an unavailable day is refused with a clear message
-- =============================================================

CREATE OR REPLACE FUNCTION public.enforce_technician_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
  v_name text;
BEGIN
  IF NEW.assigned_technician_id IS NULL OR NEW.scheduled_datetime IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_technician_id IS NOT DISTINCT FROM OLD.assigned_technician_id THEN
    RETURN NEW;
  END IF;
  IF NEW.job_status NOT IN ('scheduled', 'en_route', 'in_progress') THEN
    RETURN NEW;
  END IF;

  v_reason := public.technician_unavailable_reason(NEW.assigned_technician_id, NEW.scheduled_datetime::date);
  IF v_reason IS NOT NULL THEN
    SELECT member_name INTO v_name FROM team_members WHERE id = NEW.assigned_technician_id;
    RAISE EXCEPTION '% is unavailable on %: %.', COALESCE(v_name, 'This technician'), NEW.scheduled_datetime::date, v_reason
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_technician_availability ON jobs;
CREATE TRIGGER trg_enforce_technician_availability
  BEFORE INSERT OR UPDATE OF assigned_technician_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_technician_availability();

-- =============================================================
-- technician_capacity_events.outcome — allow the new status.
-- NOT VALID: new rows are checked, existing rows are not re-scanned (safe if your live data has extra values).
-- If you added other outcomes in your live project, add them to this list.
-- =============================================================

ALTER TABLE technician_capacity_events DROP CONSTRAINT IF EXISTS technician_capacity_events_outcome_check;
ALTER TABLE technician_capacity_events ADD CONSTRAINT technician_capacity_events_outcome_check
  CHECK (outcome IN ('assigned', 'at_capacity', 'no_technician_available', 'not_found', 'blocked_compliance', 'blocked_time_off'))
  NOT VALID;

-- =============================================================
-- assign_technician_to_job — same signature, + availability gate on both branches
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
  v_unavail text;
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

    -- AVAILABILITY GATE: company blackout, approved time off, or a non-working weekday.
    v_unavail := public.technician_unavailable_reason(p_technician_id, v_day);
    IF v_unavail IS NOT NULL THEN
      v_result := jsonb_build_object(
        'status', 'blocked_time_off', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
        'reason', format('%s is unavailable that day: %s.', v_tech.member_name, v_unavail)
      );
      INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome)
      VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'blocked_time_off');
      RETURN v_result;
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

    -- AVAILABILITY GATE: never auto-pick a technician who is off, blacked out or not scheduled that day.
    CONTINUE WHEN public.technician_unavailable_reason(v_tech.id, v_day) IS NOT NULL;

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
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'Every technician is at capacity, unavailable that day (time off, blackout or not scheduled), or missing a required credential for this job.');
  END IF;

  UPDATE jobs SET assigned_technician_id = v_best_id WHERE id = p_job_id;
  INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
  VALUES (v_job.user_id, p_job_id, v_best_id, v_best_name, 'assigned', v_best_load + 1, v_best_capacity);

  RETURN jsonb_build_object(
    'status', 'assigned', 'technician_id', v_best_id, 'technician_name', v_best_name,
    'day_load', v_best_load + 1, 'capacity', v_best_capacity,
    'reason', 'Assigned by AI Dispatcher -- best skill/service-area/capacity/proximity match, compliance- and availability-checked.'
  );
END;
$$;

-- =============================================================
-- Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.time_off_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.technician_unavailable_reason(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_technician_availability() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.time_off_can_manage() TO authenticated;

COMMENT ON TABLE technician_time_off IS 'Approved/cancelled technician days off. Append-only: only status may change (approved -> cancelled).';
COMMENT ON TABLE technician_availability IS 'Optional weekly working days per technician. No row = available every day.';
COMMENT ON TABLE company_blackout_dates IS 'Dates when no technician is dispatched. Append-only: only status may change (active -> cancelled).';
