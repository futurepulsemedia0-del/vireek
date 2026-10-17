/*
  # Technician time clock — GPS clock in/out, breaks, job-linked hours

  Powers /tech/timesheet. A shift is clocked in/out with a GPS fix, can hold
  breaks, and is split into job segments ("switch job"). On clock-out the
  worked time (breaks removed) is written into the existing payroll
  `timesheets` table — one row per job, weekly overtime split using the
  employee's standard_hours_per_week — so approvals and pay runs work
  unchanged.

  Offline-first: the app queues events on the device and replays them through
  apply_time_events(), which is idempotent (event ids), validates ordering and
  rejects impossible sequences instead of corrupting hours.

  - New tables: time_shifts, time_shift_breaks, time_shift_jobs, time_event_log.
  - Technicians can READ their own rows; all writes go through the RPC.
    Managers (owner, or can_view_billing) can read the whole account.
  - Additive columns on timesheets: shift_id, source.
  - Requires the technician to be a team member linked to an active
    `employees` row (Payroll → Employees).
*/

-- =============================================================
-- HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.time_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.time_is_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.time_is_manager() TO authenticated;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS time_shifts (
  id uuid PRIMARY KEY,                       -- client-generated so offline chains can reference it
  user_id uuid NOT NULL,                     -- account owner
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  clock_in_at timestamptz NOT NULL,
  clock_out_at timestamptz,
  in_lat double precision CHECK (in_lat IS NULL OR in_lat BETWEEN -90 AND 90),
  in_lng double precision CHECK (in_lng IS NULL OR in_lng BETWEEN -180 AND 180),
  in_accuracy_m real CHECK (in_accuracy_m IS NULL OR in_accuracy_m >= 0),
  in_gps_error text,
  out_lat double precision CHECK (out_lat IS NULL OR out_lat BETWEEN -90 AND 90),
  out_lng double precision CHECK (out_lng IS NULL OR out_lng BETWEEN -180 AND 180),
  out_accuracy_m real CHECK (out_accuracy_m IS NULL OR out_accuracy_m >= 0),
  out_gps_error text,
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  net_minutes integer CHECK (net_minutes IS NULL OR net_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at),
  CHECK ((status = 'open') = (clock_out_at IS NULL))
);

-- The database itself guarantees one open shift per technician (no double clock-in, even under races).
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_shifts_one_open ON time_shifts(team_member_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_time_shifts_member_date ON time_shifts(team_member_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_time_shifts_owner_date ON time_shifts(user_id, work_date DESC);

CREATE TABLE IF NOT EXISTS time_shift_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  shift_id uuid NOT NULL REFERENCES time_shifts(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_breaks_one_open ON time_shift_breaks(shift_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_time_breaks_shift ON time_shift_breaks(shift_id, started_at);

CREATE TABLE IF NOT EXISTS time_shift_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  shift_id uuid NOT NULL REFERENCES time_shifts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,   -- NULL = not tied to a job (shop, travel, admin)
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_jobs_one_open ON time_shift_jobs(shift_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_time_jobs_shift ON time_shift_jobs(shift_id, started_at);

CREATE TABLE IF NOT EXISTS time_event_log (
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'rejected')),
  code text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_member_id, event_id)
);

-- Link written hours back to the shift that produced them.
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES time_shifts(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheets_shift_job
  ON timesheets(shift_id, COALESCE(job_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE shift_id IS NOT NULL;

-- =============================================================
-- ROW LEVEL SECURITY — read-only from the client, scoped to the account
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['time_shifts', 'time_shift_breaks', 'time_shift_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
  END LOOP;
  ALTER TABLE time_event_log ENABLE ROW LEVEL SECURITY;   -- no policies: RPC-only
END $$;

CREATE POLICY time_shifts_select ON time_shifts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (team_member_id = public.get_my_team_member_id() OR public.time_is_manager()));

CREATE POLICY time_shift_breaks_select ON time_shift_breaks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM time_shifts s WHERE s.id = shift_id));

CREATE POLICY time_shift_jobs_select ON time_shift_jobs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM time_shifts s WHERE s.id = shift_id));

-- =============================================================
-- READ RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_my_time_profile()
RETURNS TABLE (team_member_id uuid, employee_id uuid, owner_id uuid, full_name text, standard_hours_per_week numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id, e.id, tm.account_owner_id, COALESCE(e.full_name, tm.member_email), e.standard_hours_per_week
  FROM team_members tm
  LEFT JOIN employees e ON e.team_member_id = tm.id AND e.active
  WHERE tm.user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_open_shift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', s.id,
    'work_date', s.work_date,
    'clock_in_at', s.clock_in_at,
    'breaks', COALESCE((SELECT jsonb_agg(jsonb_build_object('started_at', b.started_at, 'ended_at', b.ended_at) ORDER BY b.started_at)
                        FROM time_shift_breaks b WHERE b.shift_id = s.id), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object('job_id', j.job_id, 'started_at', j.started_at, 'ended_at', j.ended_at) ORDER BY j.started_at)
                          FROM time_shift_jobs j WHERE j.shift_id = s.id), '[]'::jsonb))
  FROM time_shifts s
  WHERE s.team_member_id = public.get_my_team_member_id() AND s.status = 'open'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_my_time_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_open_shift() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_time_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_open_shift() TO authenticated;

-- =============================================================
-- TIMESHEET WRITER — one row per job, weekly overtime
-- =============================================================

CREATE OR REPLACE FUNCTION public._tc_write_timesheets(p_shift_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s time_shifts%ROWTYPE;
  v_std numeric;
  v_week_start date;
  v_prior numeric;
  r record;
  v_hours numeric;
  v_regular numeric;
  v_total_sec numeric := 0;
  v_rows integer := 0;
BEGIN
  SELECT * INTO s FROM time_shifts WHERE id = p_shift_id;
  SELECT standard_hours_per_week INTO v_std FROM employees WHERE id = s.employee_id;
  v_std := COALESCE(v_std, 40);
  v_week_start := date_trunc('week', s.work_date::timestamp)::date;   -- Monday

  SELECT COALESCE(SUM(regular_hours + overtime_hours), 0) INTO v_prior
    FROM timesheets
   WHERE employee_id = s.employee_id AND work_date >= v_week_start AND work_date < v_week_start + 7
     AND status <> 'rejected';

  FOR r IN
    SELECT j.job_id,
           MIN(j.started_at) AS first_start,
           SUM(GREATEST(0,
                 EXTRACT(EPOCH FROM (j.ended_at - j.started_at))
                 - COALESCE((SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(j.ended_at, b.ended_at) - GREATEST(j.started_at, b.started_at)))))
                               FROM time_shift_breaks b
                              WHERE b.shift_id = j.shift_id AND b.started_at < j.ended_at AND b.ended_at > j.started_at), 0)
               )) AS net_sec
      FROM time_shift_jobs j
     WHERE j.shift_id = p_shift_id AND j.ended_at IS NOT NULL
     GROUP BY j.job_id
     ORDER BY MIN(j.started_at)
  LOOP
    v_total_sec := v_total_sec + r.net_sec;
    v_hours := round(r.net_sec / 3600.0, 2);
    CONTINUE WHEN v_hours <= 0;
    v_regular := GREATEST(0, LEAST(v_hours, v_std - v_prior));
    INSERT INTO timesheets (user_id, employee_id, work_date, regular_hours, overtime_hours, job_id, notes, status, shift_id, source)
    VALUES (s.user_id, s.employee_id, s.work_date, v_regular, v_hours - v_regular, r.job_id,
            'Time clock · ' || to_char(s.clock_in_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'pending', s.id, 'time_clock');
    v_prior := v_prior + v_hours;
    v_rows := v_rows + 1;
  END LOOP;

  UPDATE time_shifts
     SET net_minutes = round(v_total_sec / 60.0)::integer,
         break_minutes = round(COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) FROM time_shift_breaks WHERE shift_id = p_shift_id AND ended_at IS NOT NULL), 0) / 60.0)::integer
   WHERE id = p_shift_id;
  RETURN v_rows;
END $$;

REVOKE ALL ON FUNCTION public._tc_write_timesheets(uuid) FROM PUBLIC;

-- =============================================================
-- EVENT APPLIER (raises 'tc_*' codes for impossible sequences)
-- =============================================================

CREATE OR REPLACE FUNCTION public._tc_apply_event(p_tm uuid, p_emp uuid, p_owner uuid, p_ev jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text := p_ev->>'type';
  v_at timestamptz := (p_ev->>'at')::timestamptz;
  v_shift_id uuid := NULLIF(p_ev->>'shift_id', '')::uuid;
  v_job uuid := NULLIF(p_ev->>'job_id', '')::uuid;
  v_lat double precision := NULLIF(p_ev->>'lat', '')::double precision;
  v_lng double precision := NULLIF(p_ev->>'lng', '')::double precision;
  v_acc real := NULLIF(p_ev->>'accuracy', '')::real;
  v_gps_err text := NULLIF(left(p_ev->>'gps_error', 40), '');
  s time_shifts%ROWTYPE;
  v_last timestamptz;
  v_seg_job uuid;
  v_work_date date;
BEGIN
  IF v_type IS NULL OR v_type NOT IN ('clock_in', 'clock_out', 'break_start', 'break_end', 'switch_job') THEN RAISE EXCEPTION 'tc_invalid_event'; END IF;
  IF v_at IS NULL THEN RAISE EXCEPTION 'tc_invalid_event'; END IF;
  IF v_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'tc_clock_skew'; END IF;
  IF v_at < now() - interval '14 days' THEN RAISE EXCEPTION 'tc_too_old'; END IF;
  IF (v_lat IS NOT NULL AND abs(v_lat) > 90) OR (v_lng IS NOT NULL AND abs(v_lng) > 180) OR (v_acc IS NOT NULL AND v_acc < 0) THEN
    RAISE EXCEPTION 'tc_invalid_event';
  END IF;
  IF v_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = p_owner) THEN RAISE EXCEPTION 'tc_invalid_job'; END IF;

  IF v_type = 'clock_in' THEN
    IF v_shift_id IS NULL THEN RAISE EXCEPTION 'tc_invalid_event'; END IF;
    v_work_date := (p_ev->>'work_date')::date;
    IF v_work_date IS NULL OR abs(v_work_date - (v_at AT TIME ZONE 'UTC')::date) > 1 THEN RAISE EXCEPTION 'tc_invalid_event'; END IF;
    IF EXISTS (SELECT 1 FROM time_shifts WHERE team_member_id = p_tm AND status = 'open') THEN RAISE EXCEPTION 'tc_already_clocked_in'; END IF;
    IF EXISTS (SELECT 1 FROM time_shifts WHERE id = v_shift_id) THEN RAISE EXCEPTION 'tc_duplicate_shift'; END IF;
    IF EXISTS (SELECT 1 FROM time_shifts WHERE team_member_id = p_tm AND clock_out_at > v_at) THEN RAISE EXCEPTION 'tc_overlaps_previous_shift'; END IF;
    INSERT INTO time_shifts (id, user_id, team_member_id, employee_id, work_date, clock_in_at, in_lat, in_lng, in_accuracy_m, in_gps_error)
    VALUES (v_shift_id, p_owner, p_tm, p_emp, v_work_date, v_at, v_lat, v_lng, v_acc, v_gps_err);
    INSERT INTO time_shift_jobs (user_id, shift_id, job_id, started_at) VALUES (p_owner, v_shift_id, v_job, v_at);
    RETURN;
  END IF;

  SELECT * INTO s FROM time_shifts WHERE team_member_id = p_tm AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tc_no_open_shift'; END IF;
  IF v_shift_id IS NOT NULL AND v_shift_id <> s.id THEN RAISE EXCEPTION 'tc_wrong_shift'; END IF;

  SELECT GREATEST(s.clock_in_at,
                  COALESCE((SELECT MAX(GREATEST(started_at, COALESCE(ended_at, started_at))) FROM time_shift_breaks WHERE shift_id = s.id), s.clock_in_at),
                  COALESCE((SELECT MAX(GREATEST(started_at, COALESCE(ended_at, started_at))) FROM time_shift_jobs WHERE shift_id = s.id), s.clock_in_at))
    INTO v_last;
  IF v_at < v_last THEN RAISE EXCEPTION 'tc_out_of_order'; END IF;

  IF v_type = 'break_start' THEN
    IF EXISTS (SELECT 1 FROM time_shift_breaks WHERE shift_id = s.id AND ended_at IS NULL) THEN RAISE EXCEPTION 'tc_already_on_break'; END IF;
    INSERT INTO time_shift_breaks (user_id, shift_id, started_at) VALUES (p_owner, s.id, v_at);

  ELSIF v_type = 'break_end' THEN
    UPDATE time_shift_breaks SET ended_at = v_at WHERE shift_id = s.id AND ended_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'tc_not_on_break'; END IF;

  ELSIF v_type = 'switch_job' THEN
    SELECT job_id INTO v_seg_job FROM time_shift_jobs WHERE shift_id = s.id AND ended_at IS NULL;
    IF v_seg_job IS NOT DISTINCT FROM v_job THEN RAISE EXCEPTION 'tc_same_job'; END IF;
    UPDATE time_shift_jobs SET ended_at = v_at WHERE shift_id = s.id AND ended_at IS NULL;
    INSERT INTO time_shift_jobs (user_id, shift_id, job_id, started_at) VALUES (p_owner, s.id, v_job, v_at);

  ELSE -- clock_out
    IF v_at <= s.clock_in_at THEN RAISE EXCEPTION 'tc_zero_length'; END IF;
    UPDATE time_shift_breaks SET ended_at = v_at WHERE shift_id = s.id AND ended_at IS NULL;
    UPDATE time_shift_jobs SET ended_at = v_at WHERE shift_id = s.id AND ended_at IS NULL;
    UPDATE time_shifts
       SET status = 'closed', clock_out_at = v_at, out_lat = v_lat, out_lng = v_lng, out_accuracy_m = v_acc, out_gps_error = v_gps_err, updated_at = now()
     WHERE id = s.id;
    PERFORM public._tc_write_timesheets(s.id);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public._tc_apply_event(uuid, uuid, uuid, jsonb) FROM PUBLIC;

-- =============================================================
-- BATCH RPC — idempotent, ordered, per-event outcomes
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_time_events(p_events jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm uuid;
  v_emp uuid;
  v_owner uuid;
  v_ev jsonb;
  v_id uuid;
  v_prev record;
  v_outcome text;
  v_code text;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN RAISE EXCEPTION 'tc_invalid_event'; END IF;
  IF jsonb_array_length(p_events) > 200 THEN RAISE EXCEPTION 'tc_batch_too_large'; END IF;

  SELECT tm.id, e.id, tm.account_owner_id INTO v_tm, v_emp, v_owner
    FROM team_members tm LEFT JOIN employees e ON e.team_member_id = tm.id AND e.active
   WHERE tm.user_id = auth.uid() LIMIT 1;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'tc_not_a_team_member'; END IF;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'tc_no_employee'; END IF;

  FOR v_ev IN SELECT value FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(value, ord) ORDER BY ord LOOP
    v_id := NULL; v_outcome := 'applied'; v_code := NULL;
    BEGIN
      v_id := (v_ev->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object('id', v_ev->>'id', 'outcome', 'rejected', 'code', 'tc_invalid_event');
      CONTINUE;
    END;

    SELECT outcome, code INTO v_prev FROM time_event_log WHERE team_member_id = v_tm AND event_id = v_id;
    IF FOUND THEN
      v_results := v_results || jsonb_build_object('id', v_id, 'outcome', 'duplicate', 'code', v_prev.code);
      CONTINUE;
    END IF;

    BEGIN
      PERFORM public._tc_apply_event(v_tm, v_emp, v_owner, v_ev);
    EXCEPTION
      WHEN serialization_failure OR deadlock_detected THEN
        v_outcome := 'error'; v_code := 'tc_retry';
      WHEN OTHERS THEN
        v_outcome := 'rejected';
        v_code := CASE WHEN SQLERRM LIKE 'tc\_%' THEN SQLERRM ELSE 'tc_invalid_event' END;
    END;

    IF v_outcome <> 'error' THEN
      INSERT INTO time_event_log (team_member_id, event_id, outcome, code) VALUES (v_tm, v_id, v_outcome, v_code)
      ON CONFLICT DO NOTHING;
    END IF;
    v_results := v_results || jsonb_build_object('id', v_id, 'outcome', v_outcome, 'code', v_code);
    -- A transient failure stops the batch: later events depend on this one, so they must not run first.
    -- The client keeps every event without a result and retries in order.
    EXIT WHEN v_outcome = 'error';
  END LOOP;

  RETURN v_results;
END $$;

REVOKE ALL ON FUNCTION public.apply_time_events(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_time_events(jsonb) TO authenticated;
