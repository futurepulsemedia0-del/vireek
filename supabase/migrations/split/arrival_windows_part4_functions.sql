-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

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
