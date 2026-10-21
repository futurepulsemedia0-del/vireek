/*
  # Arrival-window management

  ## What this adds
  1. Booking: the public page can offer 1-4 hour ARRIVAL WINDOWS ("9-11 AM") instead of exact times.
  2. Dispatch: when a technician is assigned, the window is NARROWED automatically (default 4h -> 2h) around the
     planned slot. A reschedule that leaves the promised window re-bases it. Both are done by ONE trigger on
     `jobs`, so every write path is covered (dispatch board, AI auto-assign, assign_technician_to_job RPC,
     customer self-reschedule, calendar drag) without editing any of those.
  3. Customer notification: every window change is written to an outbox (arrival_window_notifications).
     The `arrival-window-notify` edge function drains it through sendCompliantSms (A2P / STOP / quiet hours).
  4. Reporting: get_technician_on_time_report() -> on-time rate per technician.

  ## Design rules
  - Additive + idempotent: safe to run twice. Nothing existing is replaced (assign_technician_to_job,
    create_public_booking and create_public_booking_with_settings are CALLED, never redefined).
  - Opt-in per business (arrival_windows_enabled DEFAULT false): zero behaviour change until switched on.
  - `jobs.scheduled_datetime` stays the planned arrival ("anchor"), so jobs_no_double_booking, buffers,
    capacity and every existing query keep working unchanged.
  - `jobs.arrived_at` is stamped when a tech goes EN ROUTE (see advance_job_status), so it is NOT used for
    on-time measurement. Arrival = telematics geofence arrival, else the first moment the job became
    'in_progress' (arrival_confirmed_at, stamped by the trigger below).

  ## Keep in sync
  arrival_window_narrow() mirrors narrowArrivalWindow() in src/lib/arrivalWindows.ts.
*/

-- ---------------------------------------------------------------------------
-- 1. Settings (business_profile)
-- ---------------------------------------------------------------------------
ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS arrival_windows_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arrival_window_options_minutes integer[] NOT NULL DEFAULT '{60,120,180,240}',
  ADD COLUMN IF NOT EXISTS arrival_window_narrow_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS arrival_window_grace_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_window_notify_customer boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_arrival_window_ranges') THEN
    ALTER TABLE business_profile ADD CONSTRAINT business_profile_arrival_window_ranges CHECK (
      arrival_window_narrow_minutes BETWEEN 60 AND 240
      AND arrival_window_narrow_minutes % 15 = 0
      AND arrival_window_grace_minutes BETWEEN 0 AND 60
      AND cardinality(arrival_window_options_minutes) BETWEEN 1 AND 4
      AND arrival_window_options_minutes <@ ARRAY[60, 120, 180, 240]
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Job columns
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS arrival_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_end timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_original_start timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_original_end timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_window_narrowed_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_confirmed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_arrival_window_shape') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_arrival_window_shape CHECK (
      (arrival_window_start IS NULL AND arrival_window_end IS NULL)
      OR (
        arrival_window_start IS NOT NULL AND arrival_window_end IS NOT NULL
        AND arrival_window_end - arrival_window_start BETWEEN interval '60 minutes' AND interval '240 minutes'
      )
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_arrival_window_report
  ON jobs (user_id, arrival_window_end)
  WHERE arrival_window_start IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Customer-notification outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arrival_window_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('confirmed', 'narrowed', 'changed')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  previous_start timestamptz,
  previous_end timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  send_after timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_arrival_window_notif_dedupe
  ON arrival_window_notifications (job_id, kind, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_arrival_window_notif_queue
  ON arrival_window_notifications (send_after) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_arrival_window_notif_job
  ON arrival_window_notifications (job_id, created_at DESC);

ALTER TABLE arrival_window_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "arrival_window_notifications_select_own" ON arrival_window_notifications;
CREATE POLICY "arrival_window_notifications_select_own" ON arrival_window_notifications
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies on purpose: only SECURITY DEFINER code below writes here.

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_arrival_window_notification(
  p_job_id uuid, p_user_id uuid, p_kind text,
  p_start timestamptz, p_end timestamptz,
  p_prev_start timestamptz DEFAULT NULL, p_prev_end timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
BEGIN
  SELECT arrival_window_notify_customer INTO v_notify FROM business_profile WHERE user_id = p_user_id;
  IF NOT COALESCE(v_notify, true) THEN RETURN; END IF;

  -- 'confirmed' goes out right away; changes wait 2 minutes so a dispatcher
  -- fiddling with a window does not text the customer three times.
  INSERT INTO arrival_window_notifications
    (user_id, job_id, kind, window_start, window_end, previous_start, previous_end, send_after)
  VALUES
    (p_user_id, p_job_id, p_kind, p_start, p_end, p_prev_start, p_prev_end,
     CASE WHEN p_kind = 'confirmed' THEN now() ELSE now() + interval '2 minutes' END)
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_arrival_window_notification(uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;

-- Narrow [start, end) to `target` minutes, centred on the planned arrival, snapped to 15 minutes and clamped
-- inside the current window. Never widens. Mirrors narrowArrivalWindow() in src/lib/arrivalWindows.ts.
CREATE OR REPLACE FUNCTION public.arrival_window_narrow(
  p_start timestamptz, p_end timestamptz, p_anchor timestamptz, p_target_minutes integer
)
RETURNS TABLE (window_start timestamptz, window_end timestamptz)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_len integer;
  v_target integer;
  v_desired timestamptz;
  v_s timestamptz;
BEGIN
  v_len := round(extract(epoch FROM (p_end - p_start)) / 60)::integer;
  v_target := LEAST(v_len, GREATEST(60, COALESCE(p_target_minutes, v_len)));
  IF v_target >= v_len OR p_anchor IS NULL THEN
    RETURN QUERY SELECT p_start, p_end;
    RETURN;
  END IF;
  v_desired := to_timestamp(
    floor(extract(epoch FROM (p_anchor - make_interval(secs => v_target * 30))) / 900) * 900
  );
  v_s := LEAST(GREATEST(v_desired, p_start), p_end - make_interval(mins => v_target));
  RETURN QUERY SELECT v_s, v_s + make_interval(mins => v_target);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Trigger: arrival stamp + automatic narrowing / re-basing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jobs_arrival_window_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target integer;
  v_len integer;
  v_rebased boolean := false;
  v_narrow record;
BEGIN
  -- First moment work began = measured arrival (only for a real transition, never a back-fill).
  IF NEW.job_status = 'in_progress' AND OLD.job_status IS DISTINCT FROM 'in_progress'
     AND NEW.arrival_confirmed_at IS NULL THEN
    NEW.arrival_confirmed_at := COALESCE(NEW.started_at, now());
  END IF;

  IF NEW.arrival_window_start IS NULL
     OR NEW.job_status NOT IN ('scheduled', 'en_route')
     OR OLD.job_status NOT IN ('scheduled', 'en_route') THEN
    RETURN NEW;
  END IF;

  -- (a) Moved outside the promised window -> new promise starting at the new slot (same length as the original).
  IF NEW.scheduled_datetime IS NOT NULL
     AND NEW.scheduled_datetime IS DISTINCT FROM OLD.scheduled_datetime
     AND (NEW.scheduled_datetime < NEW.arrival_window_start OR NEW.scheduled_datetime >= NEW.arrival_window_end) THEN
    v_len := round(extract(epoch FROM (
      COALESCE(NEW.arrival_window_original_end, NEW.arrival_window_end)
      - COALESCE(NEW.arrival_window_original_start, NEW.arrival_window_start)
    )) / 60)::integer;
    NEW.arrival_window_start := to_timestamp(floor(extract(epoch FROM NEW.scheduled_datetime) / 900) * 900);
    NEW.arrival_window_end := NEW.arrival_window_start + make_interval(mins => v_len);
    NEW.arrival_window_original_start := NEW.arrival_window_start;
    NEW.arrival_window_original_end := NEW.arrival_window_end;
    NEW.arrival_window_narrowed_at := NULL;
    v_rebased := true;
  END IF;

  -- (b) Dispatched (technician newly assigned / changed) -> narrow around the planned arrival.
  IF NEW.assigned_technician_id IS NOT NULL
     AND NEW.scheduled_datetime IS NOT NULL
     AND NEW.scheduled_datetime >= NEW.arrival_window_start
     AND NEW.scheduled_datetime < NEW.arrival_window_end
     AND (v_rebased OR NEW.assigned_technician_id IS DISTINCT FROM OLD.assigned_technician_id) THEN
    SELECT arrival_window_narrow_minutes INTO v_target FROM business_profile WHERE user_id = NEW.user_id;
    SELECT * INTO v_narrow FROM public.arrival_window_narrow(
      NEW.arrival_window_start, NEW.arrival_window_end, NEW.scheduled_datetime, COALESCE(v_target, 120));
    IF v_narrow.window_start IS DISTINCT FROM NEW.arrival_window_start
       OR v_narrow.window_end IS DISTINCT FROM NEW.arrival_window_end THEN
      NEW.arrival_window_original_start := COALESCE(NEW.arrival_window_original_start, NEW.arrival_window_start);
      NEW.arrival_window_original_end := COALESCE(NEW.arrival_window_original_end, NEW.arrival_window_end);
      NEW.arrival_window_start := v_narrow.window_start;
      NEW.arrival_window_end := v_narrow.window_end;
      NEW.arrival_window_narrowed_at := now();
    END IF;
  END IF;

  IF NEW.arrival_window_start IS DISTINCT FROM OLD.arrival_window_start
     OR NEW.arrival_window_end IS DISTINCT FROM OLD.arrival_window_end THEN
    PERFORM public.enqueue_arrival_window_notification(
      NEW.id, NEW.user_id,
      CASE WHEN v_rebased THEN 'changed' ELSE 'narrowed' END,
      NEW.arrival_window_start, NEW.arrival_window_end,
      OLD.arrival_window_start, OLD.arrival_window_end);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_arrival_window_sync ON jobs;
CREATE TRIGGER trg_jobs_arrival_window_sync
  BEFORE UPDATE OF assigned_technician_id, scheduled_datetime, job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_arrival_window_sync();

-- ---------------------------------------------------------------------------
-- 6. Public booking with an arrival window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_arrival_window_public_config(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'options_minutes', to_jsonb(bp.arrival_window_options_minutes),
    'narrow_minutes', bp.arrival_window_narrow_minutes
  )
  FROM business_profile bp
  WHERE bp.booking_slug = p_slug AND bp.booking_enabled AND bp.arrival_windows_enabled
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_arrival_window_public_config(text) TO anon, authenticated;

-- Thin wrapper: validates the window, delegates the real insert to the existing
-- create_public_booking_with_settings (lead time, buffers, intake, referral, double-booking all still apply),
-- then stamps the window. Raises 'arrival_windows_disabled' so the client can fall back to the exact-time flow.
CREATE OR REPLACE FUNCTION public.create_public_booking_windowed(
  p_slug text, p_customer_name text, p_customer_phone text, p_customer_email text,
  p_service_type text, p_window_start timestamptz, p_window_end timestamptz, p_anchor timestamptz,
  p_notes text, p_channel text,
  p_ref_code text DEFAULT NULL,
  p_intake_answers jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  v_len integer;
  v_res jsonb;
  v_job_id uuid;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE booking_slug = p_slug;
  IF NOT FOUND OR NOT bp.booking_enabled THEN
    RAISE EXCEPTION 'booking_not_available';
  END IF;
  IF NOT bp.arrival_windows_enabled THEN
    RAISE EXCEPTION 'arrival_windows_disabled';
  END IF;

  IF p_window_start IS NULL OR p_window_end IS NULL OR p_anchor IS NULL THEN
    RAISE EXCEPTION 'window_invalid';
  END IF;
  v_len := round(extract(epoch FROM (p_window_end - p_window_start)) / 60)::integer;
  IF NOT (v_len = ANY (bp.arrival_window_options_minutes))
     OR p_anchor < p_window_start OR p_anchor >= p_window_end THEN
    RAISE EXCEPTION 'window_invalid';
  END IF;
  IF p_window_start < now() THEN
    RAISE EXCEPTION 'too_soon';
  END IF;

  v_res := public.create_public_booking_with_settings(
    p_slug => p_slug,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    p_service_type => p_service_type,
    p_scheduled_datetime => p_anchor,
    p_notes => p_notes,
    p_channel => p_channel,
    p_ref_code => p_ref_code,
    p_intake_answers => p_intake_answers
  );
  v_job_id := (v_res ->> 'job_id')::uuid;

  UPDATE jobs
  SET arrival_window_start = p_window_start,
      arrival_window_end = p_window_end,
      arrival_window_original_start = p_window_start,
      arrival_window_original_end = p_window_end
  WHERE id = v_job_id;

  PERFORM public.enqueue_arrival_window_notification(v_job_id, bp.user_id, 'confirmed', p_window_start, p_window_end);

  RETURN v_res || jsonb_build_object('window_start', p_window_start, 'window_end', p_window_end);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_public_booking_windowed(
  text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, text, text, jsonb
) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Customer view (by the job's existing reschedule_token) + dispatcher override
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_job_arrival_window(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'window_start', j.arrival_window_start,
    'window_end', j.arrival_window_end,
    'original_start', j.arrival_window_original_start,
    'original_end', j.arrival_window_original_end,
    'narrowed', j.arrival_window_narrowed_at IS NOT NULL,
    'job_status', j.job_status
  )
  FROM jobs j
  WHERE j.reschedule_token = p_token AND j.arrival_window_start IS NOT NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_job_arrival_window(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_job_arrival_window(p_job_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  v_old_len integer;
  v_new_len integer;
BEGIN
  SELECT id, user_id, job_status, scheduled_datetime, arrival_window_start, arrival_window_end,
         arrival_window_original_start, arrival_window_original_end
  INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_job.user_id <> public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;
  IF v_job.arrival_window_start IS NULL THEN
    RETURN jsonb_build_object('status', 'no_window');
  END IF;
  IF v_job.job_status NOT IN ('scheduled', 'en_route') THEN
    RETURN jsonb_build_object('status', 'not_editable');
  END IF;

  v_new_len := round(extract(epoch FROM (p_end - p_start)) / 60)::integer;
  IF p_start IS NULL OR p_end IS NULL OR v_new_len < 60 OR v_new_len > 240 THEN
    RETURN jsonb_build_object('status', 'invalid_window');
  END IF;
  IF v_job.scheduled_datetime IS NOT NULL
     AND (v_job.scheduled_datetime < p_start OR v_job.scheduled_datetime >= p_end) THEN
    RETURN jsonb_build_object('status', 'anchor_outside_window');
  END IF;
  IF p_start = v_job.arrival_window_start AND p_end = v_job.arrival_window_end THEN
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;

  v_old_len := round(extract(epoch FROM (v_job.arrival_window_end - v_job.arrival_window_start)) / 60)::integer;

  UPDATE jobs
  SET arrival_window_original_start = COALESCE(arrival_window_original_start, arrival_window_start),
      arrival_window_original_end = COALESCE(arrival_window_original_end, arrival_window_end),
      arrival_window_start = p_start,
      arrival_window_end = p_end,
      arrival_window_narrowed_at = CASE WHEN v_new_len < v_old_len THEN now() ELSE arrival_window_narrowed_at END
  WHERE id = p_job_id;

  PERFORM public.enqueue_arrival_window_notification(
    p_job_id, v_job.user_id,
    CASE WHEN v_new_len < v_old_len THEN 'narrowed' ELSE 'changed' END,
    p_start, p_end, v_job.arrival_window_start, v_job.arrival_window_end);

  RETURN jsonb_build_object('status', 'ok', 'window_start', p_start, 'window_end', p_end);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_job_arrival_window(uuid, timestamptz, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Notification worker RPCs (service_role only, same pattern as service_guarantee_messages)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_arrival_window_notifications(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  -- A crashed worker must not strand rows.
  UPDATE arrival_window_notifications SET status = 'pending', updated_at = now()
  WHERE status = 'sending' AND updated_at < now() - interval '15 minutes';

  -- Superseded: a newer notification exists for the same job.
  UPDATE arrival_window_notifications n
  SET status = 'skipped', error = 'superseded', updated_at = now()
  WHERE n.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM arrival_window_notifications n2
      WHERE n2.job_id = n.job_id AND n2.created_at > n.created_at AND n2.status <> 'skipped'
    );

  -- Stale: job finished / cancelled, or the window has changed again since.
  UPDATE arrival_window_notifications n
  SET status = 'skipped', error = 'stale', updated_at = now()
  FROM jobs j
  WHERE j.id = n.job_id AND n.status = 'pending'
    AND (j.job_status NOT IN ('scheduled', 'en_route')
         OR j.arrival_window_start IS DISTINCT FROM n.window_start
         OR j.arrival_window_end IS DISTINCT FROM n.window_end);

  WITH picked AS (
    UPDATE arrival_window_notifications m
    SET status = 'sending', attempts = m.attempts + 1, updated_at = now()
    WHERE m.id IN (
      SELECT m2.id FROM arrival_window_notifications m2
      WHERE m2.status = 'pending' AND m2.attempts < 3 AND m2.send_after <= now()
      ORDER BY m2.created_at
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING m.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'user_id', p.user_id, 'job_id', p.job_id, 'kind', p.kind,
    'window_start', p.window_start, 'window_end', p.window_end,
    'previous_start', p.previous_start, 'previous_end', p.previous_end,
    'customer_id', j.customer_id,
    'customer_name', j.customer_name,
    'customer_phone', COALESCE(NULLIF(btrim(j.customer_phone), ''), c.phone),
    'customer_email', COALESCE(NULLIF(btrim(c.email), ''), NULLIF(btrim(l.email), '')),
    'service_type', j.service_type,
    'token', j.reschedule_token,
    'technician_name', t.member_name,
    'business_name', pr.company_name,
    'timezone', bp.timezone
  )), '[]'::jsonb)
  INTO v_out
  FROM picked p
  JOIN jobs j ON j.id = p.job_id
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN leads l ON l.id = j.lead_id
  LEFT JOIN team_members t ON t.id = j.assigned_technician_id
  LEFT JOIN profiles pr ON pr.id = p.user_id
  LEFT JOIN business_profile bp ON bp.user_id = p.user_id;

  RETURN v_out;
END;
$$;

/* p_status: sent | skipped | failed | retry (retry -> failed automatically after 3 attempts). */
CREATE OR REPLACE FUNCTION public.complete_arrival_window_notification(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;

  UPDATE arrival_window_notifications
  SET status = CASE
        WHEN p_status = 'retry' AND attempts >= 3 THEN 'failed'
        WHEN p_status = 'retry' THEN 'pending'
        ELSE p_status
      END,
      send_after = CASE WHEN p_status = 'retry' THEN now() + interval '5 minutes' ELSE send_after END,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      error = left(p_error, 500),
      updated_at = now()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_arrival_window_notifications(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_arrival_window_notification(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_arrival_window_notifications(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_arrival_window_notification(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. On-time report (per technician)
-- ---------------------------------------------------------------------------
/*
  On time   = arrived at or before (window end + grace).     Early = arrived before window start (still on time).
  Late      = arrived after (window end + grace), OR the window has passed with no arrival ("missed").
  Measured against the LAST window the customer was told; kept_original_jobs is the stricter "original promise" view.
  Jobs with no arrival evidence (e.g. marked completed straight from 'scheduled') are not counted at all —
  guessing an arrival time would flatter or punish technicians unfairly.
*/
CREATE OR REPLACE FUNCTION public.get_technician_on_time_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  technician_id uuid, technician_name text,
  windowed_jobs integer, measured_jobs integer, on_time_jobs integer, late_jobs integer,
  early_jobs integer, missed_jobs integer, kept_original_jobs integer,
  total_minutes_late numeric, max_minutes_late numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cfg AS (
    SELECT make_interval(mins => COALESCE(
      (SELECT arrival_window_grace_minutes FROM business_profile WHERE user_id = public.get_account_owner_id()), 0)) AS g
  ),
  classified AS (
    SELECT j.assigned_technician_id AS tech_id,
           j.arrival_window_start AS ws,
           j.arrival_window_end AS we,
           COALESCE(j.arrival_window_original_end, j.arrival_window_end) AS oe,
           COALESCE(j.telematics_arrived_at, j.arrival_confirmed_at) AS arr,
           (COALESCE(j.telematics_arrived_at, j.arrival_confirmed_at) IS NULL
             AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
             AND now() > j.arrival_window_end + (SELECT g FROM cfg)) AS is_missed,
           (SELECT g FROM cfg) AS g
    FROM jobs j
    WHERE j.user_id = public.get_account_owner_id()
      AND j.assigned_technician_id IS NOT NULL
      AND j.arrival_window_start IS NOT NULL
      AND j.arrival_window_end >= p_from AND j.arrival_window_end < p_to
      AND j.job_status NOT IN ('cancelled', 'no_show')
  )
  SELECT t.id, t.member_name,
    count(*)::integer,
    count(*) FILTER (WHERE c.arr IS NOT NULL OR c.is_missed)::integer,
    count(*) FILTER (WHERE c.arr IS NOT NULL AND c.arr <= c.we + c.g)::integer,
    count(*) FILTER (WHERE (c.arr IS NOT NULL AND c.arr > c.we + c.g) OR c.is_missed)::integer,
    count(*) FILTER (WHERE c.arr IS NOT NULL AND c.arr < c.ws)::integer,
    count(*) FILTER (WHERE c.is_missed)::integer,
    count(*) FILTER (WHERE c.arr IS NOT NULL AND c.arr <= c.oe + c.g)::integer,
    COALESCE(sum(extract(epoch FROM (c.arr - c.we)) / 60) FILTER (WHERE c.arr IS NOT NULL AND c.arr > c.we + c.g), 0)::numeric,
    COALESCE(max(extract(epoch FROM (c.arr - c.we)) / 60) FILTER (WHERE c.arr IS NOT NULL AND c.arr > c.we + c.g), 0)::numeric
  FROM classified c
  JOIN team_members t ON t.id = c.tech_id
  GROUP BY t.id, t.member_name
  ORDER BY t.member_name;
$$;
REVOKE ALL ON FUNCTION public.get_technician_on_time_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_on_time_report(timestamptz, timestamptz) TO authenticated;
