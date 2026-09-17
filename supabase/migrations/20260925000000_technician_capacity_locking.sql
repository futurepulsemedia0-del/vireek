/*
  # Technician Capacity Locking

  ## The race condition this fixes
  Two assignment paths already exist in this project, and neither one is
  safe against concurrent job creation:

  1. `auto_dispatch_technician()` (20260913050000_ai_dispatcher.sql) — a
     BEFORE INSERT/UPDATE trigger on `jobs` that calls `pick_best_technician()`
     to auto-assign the instant a live call books an appointment. That
     function is a plain `STABLE SQL` query with no locking at all: if two
     calls book a job for the same business at (nearly) the same instant,
     both transactions read the same `today_load` for the same technician
     before either commits, both decide that technician still has room,
     and both assign them — silently exceeding `max_jobs_per_day`.
  2. `assignBestTechnician()` (supabase/functions/_shared/dispatch/assign.ts,
     used by the "Auto-assign" button and manual technician picks on the
     Dispatch Board / Jobs / Calendar pages) has the same shape of bug:
     SELECT current load in JS, decide, then UPDATE — with nothing in
     between stopping a second, simultaneous call from doing the exact
     same read-decide-write sequence against the same technician.

  ## The fix
  Both paths now take a real row lock on the technician(s) being
  considered — `SELECT ... FOR UPDATE` on `team_members` — *before*
  counting that day's load. A second, truly concurrent transaction trying
  to assign against the same technician blocks at that lock until the
  first transaction commits, then re-reads the now-accurate (committed)
  load. That's the actual "capacity lock": nobody can read a load count
  that's about to be invalidated by another in-flight assignment.

  - `pick_best_technician()` is replaced (same signature — the existing
    trigger needs no changes) with a locking `plpgsql` version. While at
    it, the load count now correctly excludes `completed` jobs too (the
    old `<> 'cancelled'` check counted completed jobs as still occupying
    a slot), so "capacity" reflects a technician's actual open workload.
  - `assign_technician_to_job(p_job_id, p_technician_id default null)` is
    a new RPC that becomes the single, atomic gateway for every *manual*
    or *bulk* assignment path (Dispatch Board, Jobs page, Calendar
    drag-and-drop, the "Auto-assign unassigned jobs" button). Pass a
    specific technician to capacity-check + lock just that one; pass
    none to run the same locked best-match search `pick_best_technician`
    uses. Returns a small JSON result (`assigned` / `at_capacity` /
    `no_technician_available` / `not_found`) instead of throwing, so the
    UI can show *why* an assignment didn't happen.
  - `technician_capacity_events` logs every call to that RPC (who, which
    job, which technician, the outcome, and the load/capacity numbers at
    decision time) so the new Technician Capacity page can show the
    locking system actually working, not just trust it silently.
*/

-- =============================================================
-- pick_best_technician: same signature, now locks before counting
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

  -- Lock every dispatch-eligible technician for this account, in a
  -- stable order (by id), before reading anyone's load. A second,
  -- simultaneous job insert for the same business blocks right here
  -- instead of reading the same stale load this transaction is about
  -- to invalidate.
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
      ) AS today_load
    FROM team_members tm
    WHERE tm.account_owner_id = p_user_id AND tm.role = 'technician' AND tm.dispatch_enabled = true
  ) c
  WHERE c.today_load < c.max_jobs_per_day
  ORDER BY
    (
      (c.max_jobs_per_day - c.today_load) * 2
      + CASE WHEN p_service_type IS NOT NULL AND p_service_type = ANY(c.skills) THEN 10 ELSE 0 END
      + CASE WHEN c.service_area IS NOT NULL AND p_address IS NOT NULL AND p_address ILIKE '%' || c.service_area || '%' THEN 5 ELSE 0 END
    ) DESC
  LIMIT 1;

  RETURN v_best_id;
END;
$$;

-- =============================================================
-- TECHNICIAN_CAPACITY_EVENTS — audit trail for assign_technician_to_job
-- =============================================================

CREATE TABLE IF NOT EXISTS technician_capacity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text,
  outcome text NOT NULL CHECK (outcome IN ('assigned', 'at_capacity', 'no_technician_available', 'not_found')),
  day_load integer,
  capacity integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_technician_capacity_events_user ON technician_capacity_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_technician_capacity_events_tech ON technician_capacity_events(technician_id);

ALTER TABLE technician_capacity_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_technician_capacity_events" ON technician_capacity_events;
CREATE POLICY "select_own_technician_capacity_events" ON technician_capacity_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No INSERT/UPDATE/DELETE policy for `authenticated` — only
-- assign_technician_to_job() (SECURITY DEFINER) writes here.

-- =============================================================
-- RPC: assign_technician_to_job
-- The single, locked gateway for manual + bulk assignment.
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
  v_best_id uuid;
  v_best_name text;
  v_best_load integer;
  v_best_capacity integer;
  v_best_score numeric := -1;
  v_score numeric;
  v_any_tech boolean := false;
  v_result jsonb;
BEGIN
  -- Lock the job row itself too, so two clicks on the same job (or a
  -- click racing a drag-and-drop) can't both "succeed" against it.
  SELECT id, user_id, service_type, address, scheduled_datetime, job_status
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

  -- ---- A specific technician was requested (manual assign) ----------
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

    UPDATE jobs SET assigned_technician_id = p_technician_id WHERE id = p_job_id;
    INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
    VALUES (v_job.user_id, p_job_id, p_technician_id, v_tech.member_name, 'assigned', v_load + 1, v_capacity);

    RETURN jsonb_build_object(
      'status', 'assigned', 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
      'day_load', v_load + 1, 'capacity', v_capacity
    );
  END IF;

  -- ---- No technician specified — locked best-match search ------------
  FOR v_tech IN
    SELECT id, member_name, skills, service_area, max_jobs_per_day
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

    v_score := (v_capacity - v_load) * 2;
    IF v_job.service_type IS NOT NULL AND v_job.service_type = ANY(v_tech.skills) THEN v_score := v_score + 10; END IF;
    IF v_tech.service_area IS NOT NULL AND v_job.address IS NOT NULL AND v_job.address ILIKE '%' || v_tech.service_area || '%' THEN
      v_score := v_score + 5;
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
    RETURN jsonb_build_object('status', 'no_technician_available', 'reason', 'Every technician is at capacity for that day.');
  END IF;

  UPDATE jobs SET assigned_technician_id = v_best_id WHERE id = p_job_id;
  INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
  VALUES (v_job.user_id, p_job_id, v_best_id, v_best_name, 'assigned', v_best_load + 1, v_best_capacity);

  RETURN jsonb_build_object(
    'status', 'assigned', 'technician_id', v_best_id, 'technician_name', v_best_name,
    'day_load', v_best_load + 1, 'capacity', v_best_capacity,
    'reason', 'Assigned by AI Dispatcher — best skill/service-area/capacity match.'
  );
END;
$$;
