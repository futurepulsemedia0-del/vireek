/*
  # move_job — atomic drag-and-drop scheduling gateway

  ## Why
  Calendar, Dispatch Board and the Jobs Kanban now move jobs by drag-and-drop
  (time, technician, status). Until now a pure reschedule was a plain
  `UPDATE jobs` from the browser, which skipped two things
  `assign_technician_to_job` already enforces for assignment:
    - the per-technician, per-day capacity check (moving a job to another day
      for the SAME technician bypassed `max_jobs_per_day` completely),
    - the compliance gate.
  Two dispatchers dragging the same job at once could also silently overwrite
  each other.

  ## What this does
  One SECURITY DEFINER function applies any combination of
  scheduled_datetime / assigned_technician_id / job_status in ONE transaction:
    1. locks the job row, scopes it with get_account_owner_id()
       (same tenancy rule as every other RPC and RLS policy);
    2. optimistic-concurrency check: `p_expected` is the job state the
       browser saw. If it changed in the meantime the move is refused with
       status 'stale' and the CURRENT row is returned (no lost updates);
    3. locks the technician row, re-checks day capacity, compliance gaps and
       overlap with a friendly message (the `jobs_no_double_booking`
       EXCLUDE constraint is still the final guarantee and is caught);
    4. updates the job; existing triggers (quality gate, evidence chain,
       auto-dispatch) still fire, and their errors propagate unchanged.
  Returns jsonb: { status, reason?, job? }. It never throws for business
  rules, so the UI can explain WHY a drop was refused.

  Undo is the same call with the inverse patch and the post-move state as
  `p_expected`, so an undo can never clobber someone else's later change.

  No tables or columns are added or altered.
*/

CREATE OR REPLACE FUNCTION public.move_job(
  p_job_id uuid,
  p_patch jsonb,
  p_expected jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_updated jobs%ROWTYPE;
  v_uid uuid := auth.uid();
  v_role text;
  v_view_all boolean := false;
  v_is_member boolean := false;

  v_new_time timestamptz;
  v_new_tech uuid;
  v_new_status text;
  v_touch_time boolean := p_patch ? 'scheduled_datetime';
  v_touch_tech boolean := p_patch ? 'assigned_technician_id';
  v_touch_status boolean := p_patch ? 'job_status';

  v_tech record;
  v_load integer;
  v_capacity integer;
  v_gaps text[];
  v_clash record;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;

  IF v_job.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  -- Technicians who can't see every job may not reschedule/reassign.
  IF v_uid IS DISTINCT FROM v_job.user_id THEN
    SELECT tm.role, COALESCE((tm.permissions->>'can_view_all_jobs')::boolean, false), true
    INTO v_role, v_view_all, v_is_member
    FROM team_members tm
    WHERE tm.account_owner_id = v_job.user_id
      AND tm.member_email = (SELECT email FROM auth.users WHERE id = v_uid)
    LIMIT 1;

    IF v_is_member AND v_role = 'technician' AND NOT v_view_all THEN
      RETURN jsonb_build_object('status', 'forbidden', 'reason', 'You don''t have permission to move jobs.');
    END IF;
  END IF;

  -- Optimistic concurrency: refuse if the job moved under the caller's feet.
  IF (p_expected ? 'scheduled_datetime'
        AND v_job.scheduled_datetime IS DISTINCT FROM NULLIF(p_expected->>'scheduled_datetime', '')::timestamptz)
     OR (p_expected ? 'assigned_technician_id'
        AND v_job.assigned_technician_id IS DISTINCT FROM NULLIF(p_expected->>'assigned_technician_id', '')::uuid)
     OR (p_expected ? 'job_status'
        AND v_job.job_status IS DISTINCT FROM (p_expected->>'job_status')) THEN
    RETURN jsonb_build_object(
      'status', 'stale',
      'reason', 'Someone else changed this job — showing the latest version.',
      'job', to_jsonb(v_job)
    );
  END IF;

  v_new_time := CASE WHEN v_touch_time THEN NULLIF(p_patch->>'scheduled_datetime', '')::timestamptz ELSE v_job.scheduled_datetime END;
  v_new_tech := CASE WHEN v_touch_tech THEN NULLIF(p_patch->>'assigned_technician_id', '')::uuid ELSE v_job.assigned_technician_id END;
  v_new_status := CASE WHEN v_touch_status THEN p_patch->>'job_status' ELSE v_job.job_status END;

  IF v_new_status NOT IN ('scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show') THEN
    RETURN jsonb_build_object('status', 'blocked', 'reason', 'Unknown job status.');
  END IF;

  IF v_job.job_status IN ('completed', 'cancelled', 'no_show')
     AND (v_new_time IS DISTINCT FROM v_job.scheduled_datetime
          OR v_new_tech IS DISTINCT FROM v_job.assigned_technician_id
          OR v_new_status IS DISTINCT FROM v_job.job_status) THEN
    RETURN jsonb_build_object('status', 'blocked', 'reason', 'A finished job can''t be moved. Open the job to reopen it.');
  END IF;

  IF v_new_status IN ('en_route', 'in_progress') AND v_new_tech IS NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'reason', 'Assign a technician before starting this job.');
  END IF;

  -- Validate + lock the technician whenever the technician or time changes
  -- (also covers assigning a technician to a not-yet-scheduled job).
  IF v_new_tech IS NOT NULL
     AND (v_new_tech IS DISTINCT FROM v_job.assigned_technician_id OR v_new_time IS DISTINCT FROM v_job.scheduled_datetime) THEN
    SELECT id, member_name, member_email, max_jobs_per_day INTO v_tech
    FROM team_members
    WHERE id = v_new_tech AND account_owner_id = v_job.user_id AND role = 'technician' AND invite_status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'reason', 'Technician not found.');
    END IF;

    IF v_new_tech IS DISTINCT FROM v_job.assigned_technician_id THEN
      v_gaps := public.technician_compliance_gaps(v_new_tech, v_job.service_type);
      IF array_length(v_gaps, 1) > 0 THEN
        RETURN jsonb_build_object(
          'status', 'blocked_compliance',
          'reason', format('%s is missing required credentials for this job: %s.',
                           COALESCE(v_tech.member_name, v_tech.member_email), array_to_string(v_gaps, ', '))
        );
      END IF;
    END IF;
  END IF;

  -- Placement checks only when time or technician actually changes and the job stays "live".
  IF (v_new_time IS DISTINCT FROM v_job.scheduled_datetime OR v_new_tech IS DISTINCT FROM v_job.assigned_technician_id)
     AND v_new_status IN ('scheduled', 'en_route', 'in_progress')
     AND v_new_time IS NOT NULL THEN

    IF v_new_tech IS NOT NULL THEN
      v_capacity := COALESCE(v_tech.max_jobs_per_day, 6);
      -- Same day semantics as assign_technician_to_job (scheduled_datetime::date).
      SELECT count(*) INTO v_load FROM jobs
      WHERE assigned_technician_id = v_new_tech
        AND job_status IN ('scheduled', 'en_route', 'in_progress')
        AND scheduled_datetime::date = v_new_time::date
        AND id <> p_job_id;

      IF v_load >= v_capacity THEN
        INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
        VALUES (v_job.user_id, p_job_id, v_new_tech, COALESCE(v_tech.member_name, v_tech.member_email), 'at_capacity', v_load, v_capacity);
        RETURN jsonb_build_object(
          'status', 'at_capacity',
          'reason', format('%s already has %s of %s jobs that day.', COALESCE(v_tech.member_name, v_tech.member_email), v_load, v_capacity)
        );
      END IF;
    END IF;

    -- Friendly overlap message (the EXCLUDE constraint below stays the hard guarantee).
    SELECT j.customer_name, j.scheduled_datetime INTO v_clash
    FROM jobs j
    WHERE j.id <> p_job_id
      AND j.user_id = v_job.user_id
      AND COALESCE(j.assigned_technician_id::text, 'business:' || j.user_id::text)
        = COALESCE(v_new_tech::text, 'business:' || v_job.user_id::text)
      AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
      AND j.scheduled_datetime IS NOT NULL
      AND tstzrange(j.scheduled_datetime, j.scheduled_datetime + (COALESCE(j.duration_minutes, 60) || ' minutes')::interval, '[)')
       && tstzrange(v_new_time, v_new_time + (COALESCE(v_job.duration_minutes, 60) || ' minutes')::interval, '[)')
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('status', 'conflict', 'reason', format('Overlaps %s for the same %s.',
        v_clash.customer_name, CASE WHEN v_new_tech IS NULL THEN 'calendar' ELSE 'technician' END));
    END IF;
  END IF;

  BEGIN
    UPDATE jobs
    SET scheduled_datetime = v_new_time,
        assigned_technician_id = v_new_tech,
        job_status = v_new_status
    WHERE id = p_job_id
    RETURNING * INTO v_updated;
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('status', 'conflict',
        'reason', 'That time slot is already booked for this technician — pick a different time or technician.');
  END;

  IF v_new_tech IS NOT NULL AND v_new_tech IS DISTINCT FROM v_job.assigned_technician_id THEN
    INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
    VALUES (v_job.user_id, p_job_id, v_new_tech, COALESCE(v_tech.member_name, v_tech.member_email), 'assigned',
            COALESCE(v_load, 0) + 1, COALESCE(v_capacity, 6));
  END IF;

  RETURN jsonb_build_object('status', 'moved', 'job', to_jsonb(v_updated));
END;
$$;

REVOKE ALL ON FUNCTION public.move_job(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_job(uuid, jsonb, jsonb) TO authenticated;
