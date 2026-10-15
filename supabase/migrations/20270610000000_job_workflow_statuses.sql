/*
  # Extended job workflow statuses

  Adds five statuses to `jobs.job_status`:
    on_hold · waiting_on_parts · waiting_on_customer · needs_follow_up · return_visit_needed

  ## Backward compatibility (read this before shipping)
  - `jobs.job_status` is plain `text` with NO check constraint, so no ALTER on `jobs` is needed
    and every existing row / status / trigger / RPC keeps working untouched.
  - Legacy status sets keep their meaning:
      * "live" sets  IN ('scheduled','en_route','in_progress')  (double-booking constraint,
        technician capacity, routing, ETA ...) do NOT include the new statuses, so a held job
        automatically RELEASES its time slot and technician. Resuming re-checks the slot
        (the EXCLUDE constraint) and the RPC reports `slot_conflict` instead of a raw error.
      * "open" sets  NOT IN ('completed','cancelled')  and  <> 'cancelled'  DO include them, so
        revenue-at-risk, emergency triage and pipeline reports still see held jobs as open work.
      * Completion/cancel automations only fire on 'completed'/'cancelled' and are unaffected.
  - Nothing is backfilled, nothing is renamed, nothing is dropped. Existing automations never
    write the new statuses, so they cannot trip the new guards.

  ## What this adds
  1. job_holds                — one row per "hold episode": required reason, SLA due time,
                                reminder schedule, resolution. One OPEN hold per job (unique index).
  2. job_workflow_policies    — optional per-account SLA / reminder overrides (defaults built in).
  3. set_job_workflow_status  — the ONLY supported way into a new status (validates the reason).
  4. resume_job_from_workflow — the supported way out (maps slot conflicts to a clean result).
  5. Guard triggers on jobs   — a new status can't be written without an open hold carrying a
                                reason, from ANY client (web, mobile, SQL editor, other RPCs).
  6. sweep_job_hold_reminders — auto-reminders + SLA-breach alerts into `notifications`,
                                scheduled every 10 minutes with pg_cron when available.

  ## Rollback
  Safe to leave in place. To disable enforcement only:
    DROP TRIGGER trg_enforce_job_workflow_reason ON jobs;
    DROP TRIGGER trg_enforce_job_workflow_reason_ins ON jobs;
*/

-- =============================================================
-- 1. Status helper (single source of truth for the SQL side)
-- =============================================================
CREATE OR REPLACE FUNCTION public.is_job_workflow_status(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_status IN ('on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed');
$$;

-- Allowed reason codes per status. 'other' is always allowed but requires a note.
-- Keep in sync with src/lib/jobWorkflow.ts (a unit test cross-checks both lists).
CREATE OR REPLACE FUNCTION public.is_job_workflow_reason_valid(p_status text, p_reason text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_reason = 'other' OR p_reason = ANY (
    CASE p_status
      WHEN 'on_hold' THEN ARRAY['customer_request', 'access_unavailable', 'weather', 'safety_concern', 'payment_pending', 'awaiting_approval', 'scheduling_conflict']
      WHEN 'waiting_on_parts' THEN ARRAY['part_ordered', 'part_backordered', 'wrong_part_delivered', 'supplier_delay', 'warranty_part_pending', 'part_not_identified']
      WHEN 'waiting_on_customer' THEN ARRAY['awaiting_quote_approval', 'awaiting_access', 'awaiting_deposit', 'awaiting_information', 'awaiting_decision_maker', 'customer_unreachable']
      WHEN 'needs_follow_up' THEN ARRAY['callback_required', 'quote_follow_up', 'quality_check', 'invoice_follow_up', 'warranty_follow_up']
      WHEN 'return_visit_needed' THEN ARRAY['additional_work_found', 'parts_arrived', 'incomplete_repair', 'specialist_required', 'equipment_needed', 'failed_test']
      ELSE ARRAY[]::text[]
    END
  );
$$;

-- =============================================================
-- 2. Per-account SLA / reminder policy overrides
-- =============================================================
CREATE TABLE IF NOT EXISTS job_workflow_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  status text NOT NULL CHECK (public.is_job_workflow_status(status)),
  sla_minutes integer CHECK (sla_minutes IS NULL OR sla_minutes BETWEEN 5 AND 525600),
  remind_after_minutes integer CHECK (remind_after_minutes IS NULL OR remind_after_minutes BETWEEN 5 AND 525600),
  remind_every_minutes integer CHECK (remind_every_minutes IS NULL OR remind_every_minutes BETWEEN 5 AND 525600),
  max_reminders integer NOT NULL DEFAULT 5 CHECK (max_reminders BETWEEN 0 AND 50),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, status)
);

ALTER TABLE job_workflow_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_job_workflow_policies" ON job_workflow_policies;
CREATE POLICY "select_job_workflow_policies" ON job_workflow_policies FOR SELECT TO authenticated
USING (user_id = public.get_account_owner_id());

-- Only the account owner edits policy.
DROP POLICY IF EXISTS "insert_job_workflow_policies" ON job_workflow_policies;
CREATE POLICY "insert_job_workflow_policies" ON job_workflow_policies FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_job_workflow_policies" ON job_workflow_policies;
CREATE POLICY "update_job_workflow_policies" ON job_workflow_policies FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_job_workflow_policies" ON job_workflow_policies;
CREATE POLICY "delete_job_workflow_policies" ON job_workflow_policies FOR DELETE TO authenticated
USING (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- Built-in defaults (minutes). An override row replaces ALL fields for that status.
CREATE OR REPLACE FUNCTION public.resolve_job_workflow_policy(p_user_id uuid, p_status text)
RETURNS TABLE (sla_minutes integer, remind_after_minutes integer, remind_every_minutes integer, max_reminders integer, enabled boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT p.sla_minutes, p.remind_after_minutes, p.remind_every_minutes, p.max_reminders, p.enabled
    FROM job_workflow_policies p
    WHERE p.user_id = p_user_id AND p.status = p_status;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT d.sla, d.after_m, d.every_m, d.max_r, true
    FROM (VALUES
      ('on_hold',             4320, 1440, 1440, 5),   -- SLA 3 d   · remind after 1 d, daily
      ('waiting_on_parts',    7200, 1440, 1440, 7),   -- SLA 5 d   · remind after 1 d, daily
      ('waiting_on_customer', 2880, 1440, 1440, 3),   -- SLA 2 d   · remind after 1 d, daily
      ('needs_follow_up',     1440,  240,  480, 6),   -- SLA 1 d   · remind after 4 h, every 8 h
      ('return_visit_needed', 2880,  720,  720, 6)    -- SLA 2 d   · remind after 12 h, every 12 h
    ) AS d(st, sla, after_m, every_m, max_r)
    WHERE d.st = p_status;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_job_workflow_policy(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_job_workflow_policy(uuid, text) TO authenticated, service_role;

-- =============================================================
-- 3. job_holds — one row per hold episode
-- =============================================================
CREATE TABLE IF NOT EXISTS job_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (public.is_job_workflow_status(status)),
  reason_code text NOT NULL CHECK (length(btrim(reason_code)) BETWEEN 1 AND 64),
  reason_note text CHECK (reason_note IS NULL OR length(reason_note) <= 1000),
  previous_status text,
  expected_resume_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  -- SLA timer
  sla_minutes integer,
  sla_due_at timestamptz,
  sla_breached_at timestamptz,
  -- auto-reminders
  reminder_every_minutes integer,
  max_reminders integer NOT NULL DEFAULT 0,
  reminders_sent integer NOT NULL DEFAULT 0,
  next_reminder_at timestamptz,
  last_reminded_at timestamptz,
  -- resolution
  resolved_at timestamptz,
  resolved_to_status text,
  resolved_by uuid,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_holds_other_needs_note
    CHECK (reason_code <> 'other' OR length(btrim(coalesce(reason_note, ''))) >= 3)
);

-- At most ONE open hold per job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_holds_one_open ON job_holds (job_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_holds_user_open ON job_holds (user_id, status) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_holds_job ON job_holds (job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_holds_sweep ON job_holds (next_reminder_at, sla_due_at) WHERE resolved_at IS NULL;

ALTER TABLE job_holds ENABLE ROW LEVEL SECURITY;

-- Read-only for clients. All writes go through the SECURITY DEFINER RPCs/triggers below.
DROP POLICY IF EXISTS "select_job_holds" ON job_holds;
CREATE POLICY "select_job_holds" ON job_holds FOR SELECT TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. Guard triggers on jobs
-- =============================================================

-- 4a. A job can't be CREATED already on hold (there'd be no reason on record).
CREATE OR REPLACE FUNCTION public.enforce_job_workflow_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'JOB_WORKFLOW_REASON_REQUIRED: create the job first, then move it to % with a reason.', NEW.job_status
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_workflow_reason_ins ON jobs;
CREATE TRIGGER trg_enforce_job_workflow_reason_ins
  BEFORE INSERT ON jobs
  FOR EACH ROW
  WHEN (public.is_job_workflow_status(NEW.job_status))
  EXECUTE FUNCTION public.enforce_job_workflow_insert();

-- 4b. Entering a workflow status requires an OPEN hold for that exact status with a reason.
CREATE OR REPLACE FUNCTION public.enforce_job_workflow_reason()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_holds h
    WHERE h.job_id = NEW.id AND h.status = NEW.job_status AND h.resolved_at IS NULL
      AND length(btrim(h.reason_code)) > 0
  ) THEN
    RAISE EXCEPTION 'JOB_WORKFLOW_REASON_REQUIRED: a reason is required to move this job to %', NEW.job_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_workflow_reason ON jobs;
CREATE TRIGGER trg_enforce_job_workflow_reason
  BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW
  WHEN (NEW.job_status IS DISTINCT FROM OLD.job_status AND public.is_job_workflow_status(NEW.job_status))
  EXECUTE FUNCTION public.enforce_job_workflow_reason();

-- 4c. Leaving a workflow status (to ANY other status) closes the open hold.
CREATE OR REPLACE FUNCTION public.close_job_holds_on_exit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE job_holds
     SET resolved_at = now(),
         resolved_to_status = NEW.job_status,
         resolved_by = auth.uid()
   WHERE job_id = NEW.id AND status = OLD.job_status AND resolved_at IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_job_holds_on_exit ON jobs;
CREATE TRIGGER trg_close_job_holds_on_exit
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW
  WHEN (NEW.job_status IS DISTINCT FROM OLD.job_status AND public.is_job_workflow_status(OLD.job_status))
  EXECUTE FUNCTION public.close_job_holds_on_exit();

-- =============================================================
-- 5. RPC: move a job INTO a workflow status (reason required)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_job_workflow_status(
  p_job_id uuid,
  p_status text,
  p_reason_code text,
  p_reason_note text DEFAULT NULL,
  p_expected_resume_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job jobs%ROWTYPE;
  v_role text;
  v_view_all boolean;
  v_member_id uuid;
  v_is_member boolean := false;
  v_note text := NULLIF(btrim(COALESCE(p_reason_note, '')), '');
  v_prev text;
  v_policy record;
  v_now timestamptz := now();
  v_sla_due timestamptz;
  v_next_remind timestamptz;
  v_hold_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_job_workflow_status(p_status) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Unknown workflow status.');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;
  IF v_job.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  -- Technicians may only act on their own jobs unless they can view all jobs.
  IF v_uid IS DISTINCT FROM v_job.user_id THEN
    SELECT tm.role, COALESCE((tm.permissions->>'can_view_all_jobs')::boolean, false), tm.id, true
      INTO v_role, v_view_all, v_member_id, v_is_member
      FROM team_members tm
     WHERE tm.account_owner_id = v_job.user_id
       AND tm.member_email = (SELECT email FROM auth.users WHERE id = v_uid)
     LIMIT 1;
    IF v_is_member AND v_role = 'technician' AND NOT v_view_all
       AND v_job.assigned_technician_id IS DISTINCT FROM v_member_id THEN
      RETURN jsonb_build_object('status', 'forbidden', 'reason', 'You can only update jobs assigned to you.');
    END IF;
  END IF;

  IF v_job.job_status IN ('completed', 'cancelled', 'no_show') THEN
    RETURN jsonb_build_object('status', 'invalid_transition', 'reason', 'A closed job can''t be moved to this status.');
  END IF;

  IF NOT public.is_job_workflow_reason_valid(p_status, p_reason_code) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Choose a valid reason for this status.');
  END IF;
  IF p_reason_code = 'other' AND (v_note IS NULL OR length(v_note) < 3) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Add a short note when the reason is "Other".');
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Note is too long (max 1000 characters).');
  END IF;
  IF p_expected_resume_at IS NOT NULL AND p_expected_resume_at < v_now - interval '1 minute' THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Expected resume time must be in the future.');
  END IF;
  IF v_job.job_status = p_status THEN
    RETURN jsonb_build_object('status', 'unchanged', 'reason', 'Job is already in this status.');
  END IF;

  -- Remember where the job came from so "resume" can send it back sensibly.
  IF public.is_job_workflow_status(v_job.job_status) THEN
    SELECT h.previous_status INTO v_prev FROM job_holds h WHERE h.job_id = p_job_id AND h.resolved_at IS NULL;
    UPDATE job_holds
       SET resolved_at = v_now, resolved_to_status = p_status, resolved_by = v_uid
     WHERE job_id = p_job_id AND resolved_at IS NULL;
  ELSE
    v_prev := v_job.job_status;
  END IF;

  SELECT * INTO v_policy FROM public.resolve_job_workflow_policy(v_job.user_id, p_status);
  v_sla_due := CASE WHEN v_policy.sla_minutes IS NOT NULL THEN v_now + make_interval(mins => v_policy.sla_minutes) END;
  v_next_remind := CASE
    WHEN COALESCE(v_policy.enabled, true) AND v_policy.remind_after_minutes IS NOT NULL AND v_policy.max_reminders > 0
      THEN v_now + make_interval(mins => v_policy.remind_after_minutes)
  END;
  -- If the user says when it should resume, nudge them at that time if it's sooner.
  IF p_expected_resume_at IS NOT NULL AND COALESCE(v_policy.enabled, true) AND v_policy.max_reminders > 0 THEN
    v_next_remind := LEAST(COALESCE(v_next_remind, p_expected_resume_at), GREATEST(p_expected_resume_at, v_now + interval '1 minute'));
  END IF;

  INSERT INTO job_holds (
    user_id, job_id, status, reason_code, reason_note, previous_status, expected_resume_at, started_at,
    sla_minutes, sla_due_at, reminder_every_minutes, max_reminders, next_reminder_at, created_by
  ) VALUES (
    v_job.user_id, p_job_id, p_status, p_reason_code, v_note, v_prev, p_expected_resume_at, v_now,
    v_policy.sla_minutes, v_sla_due, v_policy.remind_every_minutes,
    CASE WHEN COALESCE(v_policy.enabled, true) THEN v_policy.max_reminders ELSE 0 END, v_next_remind, v_uid
  ) RETURNING id INTO v_hold_id;

  UPDATE jobs SET job_status = p_status WHERE id = p_job_id;

  INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note)
  VALUES (p_job_id, v_job.assigned_technician_id, v_job.job_status, p_status,
          p_reason_code || COALESCE(': ' || v_note, ''));

  RETURN jsonb_build_object(
    'status', 'ok', 'hold_id', v_hold_id, 'job_status', p_status,
    'sla_due_at', v_sla_due, 'next_reminder_at', v_next_remind
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_job_workflow_status(uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_job_workflow_status(uuid, text, text, text, timestamptz) TO authenticated;

-- =============================================================
-- 6. RPC: move a job OUT of a workflow status
-- =============================================================
CREATE OR REPLACE FUNCTION public.resume_job_from_workflow(
  p_job_id uuid,
  p_to_status text DEFAULT 'scheduled',
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job jobs%ROWTYPE;
  v_role text;
  v_view_all boolean;
  v_member_id uuid;
  v_is_member boolean := false;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_to_status NOT IN ('scheduled', 'en_route', 'in_progress') THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Jobs can only resume to scheduled, en route or in progress.');
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Note is too long (max 1000 characters).');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;
  IF v_job.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  IF v_uid IS DISTINCT FROM v_job.user_id THEN
    SELECT tm.role, COALESCE((tm.permissions->>'can_view_all_jobs')::boolean, false), tm.id, true
      INTO v_role, v_view_all, v_member_id, v_is_member
      FROM team_members tm
     WHERE tm.account_owner_id = v_job.user_id
       AND tm.member_email = (SELECT email FROM auth.users WHERE id = v_uid)
     LIMIT 1;
    IF v_is_member AND v_role = 'technician' AND NOT v_view_all
       AND v_job.assigned_technician_id IS DISTINCT FROM v_member_id THEN
      RETURN jsonb_build_object('status', 'forbidden', 'reason', 'You can only update jobs assigned to you.');
    END IF;
  END IF;

  IF NOT public.is_job_workflow_status(v_job.job_status) THEN
    RETURN jsonb_build_object('status', 'invalid_transition', 'reason', 'This job isn''t on hold or waiting.');
  END IF;

  BEGIN
    -- Inside the block so a slot conflict rolls the note back with the failed update.
    UPDATE job_holds SET resolution_note = v_note WHERE job_id = p_job_id AND resolved_at IS NULL;
    UPDATE jobs SET job_status = p_to_status WHERE id = p_job_id;
  EXCEPTION WHEN exclusion_violation THEN
    -- The slot was taken while the job was on hold (jobs_no_double_booking).
    RETURN jsonb_build_object('status', 'slot_conflict',
      'reason', 'This job''s time slot is now taken. Reschedule it, then resume.');
  END;

  INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note)
  VALUES (p_job_id, v_job.assigned_technician_id, v_job.job_status, p_to_status, COALESCE(v_note, 'resumed'));

  RETURN jsonb_build_object('status', 'ok', 'job_status', p_to_status);
END;
$$;

REVOKE ALL ON FUNCTION public.resume_job_from_workflow(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_job_from_workflow(uuid, text, text) TO authenticated;

-- =============================================================
-- 7. Auto-reminders + SLA breach alerts
-- =============================================================
CREATE OR REPLACE FUNCTION public.sweep_job_hold_reminders(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_count integer := 0;
  v_notify boolean;
  v_label text;
  v_sent integer;
  v_next timestamptz;
  v_breach_at timestamptz;
BEGIN
  FOR r IN
    SELECT h.id, h.user_id, h.job_id, h.status, h.reminders_sent, h.max_reminders, h.reminder_every_minutes,
           h.next_reminder_at, h.sla_due_at, h.sla_breached_at, h.expected_resume_at, j.customer_name
      FROM job_holds h
      JOIN jobs j ON j.id = h.job_id
     WHERE h.resolved_at IS NULL
       AND ( (h.next_reminder_at IS NOT NULL AND h.next_reminder_at <= now() AND h.reminders_sent < h.max_reminders)
          OR (h.sla_due_at IS NOT NULL AND h.sla_due_at <= now() AND h.sla_breached_at IS NULL) )
     ORDER BY LEAST(COALESCE(h.next_reminder_at, 'infinity'::timestamptz), COALESCE(h.sla_due_at, 'infinity'::timestamptz))
     LIMIT p_limit
     FOR UPDATE OF h SKIP LOCKED
  LOOP
    SELECT COALESCE(p.notify_job_update, true) INTO v_notify FROM profiles p WHERE p.id = r.user_id;
    v_label := initcap(replace(r.status, '_', ' '));
    v_sent := r.reminders_sent;
    v_next := r.next_reminder_at;
    v_breach_at := r.sla_breached_at;

    IF r.sla_due_at IS NOT NULL AND r.sla_due_at <= now() AND r.sla_breached_at IS NULL THEN
      v_breach_at := now();
      IF COALESCE(v_notify, true) THEN
        INSERT INTO notifications (user_id, type, title, message, action_url)
        VALUES (r.user_id, 'job_sla_breach',
                'SLA breached: ' || r.customer_name,
                'The job for ' || r.customer_name || ' has been "' || v_label || '" past its SLA. Resolve it or reschedule.',
                '/dashboard/jobs/' || r.job_id);
      END IF;
      v_count := v_count + 1;
    END IF;

    IF r.next_reminder_at IS NOT NULL AND r.next_reminder_at <= now() AND r.reminders_sent < r.max_reminders THEN
      v_sent := r.reminders_sent + 1;
      v_next := CASE
        WHEN v_sent >= r.max_reminders OR r.reminder_every_minutes IS NULL THEN NULL
        ELSE now() + make_interval(mins => r.reminder_every_minutes)
      END;
      IF COALESCE(v_notify, true) THEN
        INSERT INTO notifications (user_id, type, title, message, action_url)
        VALUES (r.user_id, 'job_hold_reminder',
                'Still ' || lower(v_label) || ': ' || r.customer_name,
                'The job for ' || r.customer_name || ' is still "' || v_label || '". Reminder ' || v_sent || ' of ' || r.max_reminders || '.',
                '/dashboard/jobs/' || r.job_id);
      END IF;
      v_count := v_count + 1;
    END IF;

    UPDATE job_holds
       SET reminders_sent = v_sent,
           next_reminder_at = v_next,
           last_reminded_at = CASE WHEN v_sent > r.reminders_sent THEN now() ELSE last_reminded_at END,
           sla_breached_at = v_breach_at
     WHERE id = r.id;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_job_hold_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sweep_job_hold_reminders(integer) TO service_role;

-- Every 10 minutes. No-op (not an error) when pg_cron isn't enabled on this project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-job-hold-reminders');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-job-hold-reminders', '*/10 * * * *', 'select public.sweep_job_hold_reminders()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
