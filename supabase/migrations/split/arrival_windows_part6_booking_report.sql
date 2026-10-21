-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

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
