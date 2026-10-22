/*
  Job-duration prediction model — persistence layer.

  The model itself runs in src/lib/durationModel.ts (pure, tested). This migration
  stores what the app must remember between sessions:

    job_duration_predictions    the prediction AS MADE before work began (P10..P90),
                                later settled with the measured actual -> honest
                                "predicted vs actual" that cannot be back-filled.
    job_duration_drift_alerts   persistent drift alerts (open / acknowledged / resolved)
                                deduped on a stable key.
    job_duration_settings       per-account switches: slot policy, feed dispatch,
                                feed public booking (OFF by default — customer facing).
    job_duration_service_stats  learned per-service slot lengths, readable by the
                                public booking page through ONE aggregate-only RPC.

  Extends (does not replace): jobs.duration_minutes, jobs.expected_duration_minutes,
  service twin baseline, job_templates, service_catalog. Nothing existing is altered.

  Depends on: jobs (started_at, completed_at, job_status — 20261212000000_technician_mobile_os.sql),
  team_members, business_profile (booking_slug, booking_enabled),
  public.get_account_owner_id().
*/

-- ============================================================
-- 1. Predictions as made (immutable except settlement)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.job_duration_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  job_type_key text NOT NULL,
  model_version text NOT NULL,
  predicted_at timestamptz NOT NULL DEFAULT now(),
  p10 integer NOT NULL CHECK (p10 BETWEEN 5 AND 1440),
  p25 integer NOT NULL CHECK (p25 BETWEEN 5 AND 1440),
  p50 integer NOT NULL CHECK (p50 BETWEEN 5 AND 1440),
  p75 integer NOT NULL CHECK (p75 BETWEEN 5 AND 1440),
  p90 integer NOT NULL CHECK (p90 BETWEEN 5 AND 1440),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  source text NOT NULL CHECK (source IN ('model', 'blend', 'prior')),
  existing_minutes integer CHECK (existing_minutes IS NULL OR existing_minutes BETWEEN 1 AND 10080),
  existing_source text,
  slot_minutes integer CHECK (slot_minutes IS NULL OR slot_minutes BETWEEN 1 AND 1440),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- settlement (filled by trigger when the job completes)
  actual_minutes integer CHECK (actual_minutes IS NULL OR actual_minutes BETWEEN 1 AND 1440),
  scored boolean NOT NULL DEFAULT false,
  within_range boolean,
  settled_at timestamptz,
  CONSTRAINT job_duration_quantiles_ordered CHECK (p10 <= p25 AND p25 <= p50 AND p50 <= p75 AND p75 <= p90)
);

CREATE INDEX IF NOT EXISTS idx_jdp_user_scored ON public.job_duration_predictions (user_id, settled_at DESC) WHERE scored;
CREATE INDEX IF NOT EXISTS idx_jdp_job ON public.job_duration_predictions (job_id, predicted_at DESC);

ALTER TABLE public.job_duration_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jdp_select_own" ON public.job_duration_predictions;
CREATE POLICY "jdp_select_own" ON public.job_duration_predictions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy on purpose: writes go through the SECURITY DEFINER RPC / trigger below.

-- ============================================================
-- 2. Drift alerts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.job_duration_drift_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  alert_key text NOT NULL CHECK (char_length(alert_key) BETWEEN 3 AND 200),
  scope text NOT NULL CHECK (scope IN ('overall', 'job_type', 'technician')),
  scope_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bias', 'calibration', 'shift')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  direction text NOT NULL CHECK (direction IN ('longer', 'shorter', 'narrow', 'wide')),
  message text NOT NULL CHECK (char_length(message) <= 500),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

-- one live alert per key
CREATE UNIQUE INDEX IF NOT EXISTS uq_jdda_live_key
  ON public.job_duration_drift_alerts (user_id, alert_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_jdda_user_status ON public.job_duration_drift_alerts (user_id, status, last_detected_at DESC);

ALTER TABLE public.job_duration_drift_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jdda_select_own" ON public.job_duration_drift_alerts;
CREATE POLICY "jdda_select_own" ON public.job_duration_drift_alerts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- 3. Settings (owner only)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.job_duration_settings (
  user_id uuid PRIMARY KEY,
  slot_policy text NOT NULL DEFAULT 'balanced' CHECK (slot_policy IN ('tight', 'balanced', 'safe')),
  feed_dispatch boolean NOT NULL DEFAULT true,
  feed_booking boolean NOT NULL DEFAULT false,
  drift_alerts_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_duration_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jds_select_own" ON public.job_duration_settings;
CREATE POLICY "jds_select_own" ON public.job_duration_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "jds_insert_owner" ON public.job_duration_settings;
CREATE POLICY "jds_insert_owner" ON public.job_duration_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "jds_update_owner" ON public.job_duration_settings;
CREATE POLICY "jds_update_owner" ON public.job_duration_settings
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- ============================================================
-- 4. Learned per-service slot lengths (feeds public booking)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.job_duration_service_stats (
  user_id uuid NOT NULL,
  service_key text NOT NULL CHECK (char_length(service_key) BETWEEN 1 AND 200),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  p50 integer NOT NULL CHECK (p50 BETWEEN 5 AND 1440),
  p75 integer NOT NULL CHECK (p75 BETWEEN 5 AND 1440),
  p90 integer NOT NULL CHECK (p90 BETWEEN 5 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service_key)
);

ALTER TABLE public.job_duration_service_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jdss_select_own" ON public.job_duration_service_stats;
CREATE POLICY "jdss_select_own" ON public.job_duration_service_stats
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- ============================================================
-- 5. RPC: record predictions (made BEFORE work starts)
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_job_duration_predictions(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r jsonb;
  v_job jobs%ROWTYPE;
  v_p10 int; v_p25 int; v_p50 int; v_p75 int; v_p90 int;
  v_version text;
  v_count int := 0;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF jsonb_array_length(p_rows) > 200 THEN RAISE EXCEPTION 'too_many_rows'; END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      SELECT * INTO v_job FROM jobs WHERE id = (r->>'job_id')::uuid AND user_id = v_owner;
      CONTINUE WHEN NOT FOUND;
      -- A prediction only counts if it was made before the work began.
      CONTINUE WHEN v_job.started_at IS NOT NULL OR v_job.job_status IN ('completed', 'cancelled', 'no_show');

      v_p10 := (r->>'p10')::int; v_p25 := (r->>'p25')::int; v_p50 := (r->>'p50')::int;
      v_p75 := (r->>'p75')::int; v_p90 := (r->>'p90')::int;
      v_version := left(coalesce(r->>'model_version', 'unknown'), 40);

      -- identical numbers carry no new information
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM job_duration_predictions
        WHERE job_id = v_job.id AND actual_minutes IS NULL AND p50 = v_p50 AND p10 = v_p10 AND p90 = v_p90
          AND model_version = v_version
      );

      INSERT INTO job_duration_predictions (
        user_id, job_id, technician_id, job_type_key, model_version,
        p10, p25, p50, p75, p90, confidence, source,
        existing_minutes, existing_source, slot_minutes, context
      ) VALUES (
        v_owner, v_job.id, v_job.assigned_technician_id,
        left(coalesce(nullif(r->>'job_type_key', ''), 'unspecified'), 200), v_version,
        v_p10, v_p25, v_p50, v_p75, v_p90,
        r->>'confidence', r->>'source',
        nullif(r->>'existing_minutes', '')::int, left(r->>'existing_source', 40),
        nullif(r->>'slot_minutes', '')::int,
        CASE WHEN jsonb_typeof(r->'context') = 'object' THEN r->'context' ELSE '{}'::jsonb END
      );
      v_count := v_count + 1;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range OR not_null_violation THEN
      -- one malformed row must not poison the batch
      CONTINUE;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_job_duration_predictions(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_job_duration_predictions(jsonb) TO authenticated;

-- ============================================================
-- 6. Trigger: settle predictions with the measured actual
-- ============================================================

CREATE OR REPLACE FUNCTION public.job_duration_settle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actual numeric;
  v_row uuid;
BEGIN
  IF NEW.job_status IS DISTINCT FROM 'completed' OR NEW.started_at IS NULL OR NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  v_actual := extract(epoch FROM (NEW.completed_at - NEW.started_at)) / 60;
  IF v_actual < 5 OR v_actual > 1440 THEN RETURN NEW; END IF;

  UPDATE job_duration_predictions SET actual_minutes = round(v_actual)::int WHERE job_id = NEW.id;

  -- the prediction that counts is the LAST one made before work began
  SELECT id INTO v_row FROM job_duration_predictions
  WHERE job_id = NEW.id AND predicted_at <= NEW.started_at
  ORDER BY predicted_at DESC LIMIT 1;

  IF v_row IS NOT NULL THEN
    UPDATE job_duration_predictions
       SET scored = true,
           within_range = (round(v_actual)::int BETWEEN p10 AND p90),
           settled_at = now()
     WHERE id = v_row;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_duration_settle ON public.jobs;
CREATE TRIGGER trg_job_duration_settle
  AFTER UPDATE OF job_status, started_at, completed_at ON public.jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed')
  EXECUTE FUNCTION public.job_duration_settle();

-- ============================================================
-- 7. RPC: sync drift alerts (idempotent, dedupes on key)
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_duration_drift_alerts(p_alerts jsonb, p_full boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  a jsonb;
  v_keys text[] := '{}';
  v_opened int := 0;
  v_updated int := 0;
  v_resolved int := 0;
  v_inserted boolean;
  v_enabled boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_alerts IS NULL OR jsonb_typeof(p_alerts) <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF jsonb_array_length(p_alerts) > 200 THEN RAISE EXCEPTION 'too_many_alerts'; END IF;

  SELECT drift_alerts_enabled INTO v_enabled FROM job_duration_settings WHERE user_id = v_owner;
  IF coalesce(v_enabled, true) = false THEN
    RETURN jsonb_build_object('opened', 0, 'updated', 0, 'resolved', 0, 'disabled', true);
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(p_alerts) LOOP
    CONTINUE WHEN nullif(a->>'key', '') IS NULL;
    BEGIN
      v_keys := v_keys || (a->>'key');
      INSERT INTO job_duration_drift_alerts (user_id, alert_key, scope, scope_key, kind, severity, direction, message, metrics)
      VALUES (
        v_owner, a->>'key', a->>'scope', left(a->>'scope_key', 200), a->>'kind', a->>'severity', a->>'direction',
        left(a->>'message', 500),
        CASE WHEN jsonb_typeof(a->'metrics') = 'object' THEN a->'metrics' ELSE '{}'::jsonb END
      )
      ON CONFLICT (user_id, alert_key) WHERE status <> 'resolved' DO UPDATE SET
        severity = EXCLUDED.severity,
        direction = EXCLUDED.direction,
        message = EXCLUDED.message,
        metrics = EXCLUDED.metrics,
        last_detected_at = now(),
        -- an acknowledged alert that gets WORSE re-opens
        status = CASE
          WHEN job_duration_drift_alerts.status = 'acknowledged'
           AND array_position(ARRAY['info', 'warning', 'critical'], EXCLUDED.severity)
             > array_position(ARRAY['info', 'warning', 'critical'], job_duration_drift_alerts.severity)
          THEN 'open' ELSE job_duration_drift_alerts.status END,
        acknowledged_at = CASE
          WHEN job_duration_drift_alerts.status = 'acknowledged'
           AND array_position(ARRAY['info', 'warning', 'critical'], EXCLUDED.severity)
             > array_position(ARRAY['info', 'warning', 'critical'], job_duration_drift_alerts.severity)
          THEN NULL ELSE job_duration_drift_alerts.acknowledged_at END
      RETURNING (xmax = 0) INTO v_inserted;
      IF v_inserted THEN v_opened := v_opened + 1; ELSE v_updated := v_updated + 1; END IF;
    EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
      CONTINUE;
    END;
  END LOOP;

  -- a complete evaluation also closes alerts whose condition has cleared
  IF p_full THEN
    UPDATE job_duration_drift_alerts
       SET status = 'resolved', resolved_at = now()
     WHERE user_id = v_owner AND status <> 'resolved' AND NOT (alert_key = ANY (v_keys));
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('opened', v_opened, 'updated', v_updated, 'resolved', v_resolved);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_duration_drift_alerts(jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_duration_drift_alerts(jsonb, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_duration_alert_status(p_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_status NOT IN ('acknowledged', 'resolved') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  UPDATE job_duration_drift_alerts
     SET status = p_status,
         acknowledged_at = CASE WHEN p_status = 'acknowledged' THEN now() ELSE acknowledged_at END,
         resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END
   WHERE id = p_id AND user_id = v_owner AND status <> 'resolved';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.set_duration_alert_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_duration_alert_status(uuid, text) TO authenticated;

-- ============================================================
-- 8. RPC: publish learned service durations (client computes, server validates)
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_duration_service_stats(p_stats jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s jsonb;
  v_keys text[] := '{}';
  v_n int := 0;
  v_p50 int; v_p75 int; v_p90 int; v_size int;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_stats IS NULL OR jsonb_typeof(p_stats) <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF jsonb_array_length(p_stats) > 300 THEN RAISE EXCEPTION 'too_many_rows'; END IF;

  FOR s IN SELECT * FROM jsonb_array_elements(p_stats) LOOP
    BEGIN
      v_size := (s->>'sample_size')::int;
      v_p50 := (s->>'p50')::int; v_p75 := (s->>'p75')::int; v_p90 := (s->>'p90')::int;
      -- never publish a number the model is not sure about
      CONTINUE WHEN v_size < 8 OR NOT (v_p50 <= v_p75 AND v_p75 <= v_p90);
      INSERT INTO job_duration_service_stats (user_id, service_key, sample_size, p50, p75, p90, updated_at)
      VALUES (v_owner, left(s->>'service_key', 200), v_size, v_p50, v_p75, v_p90, now())
      ON CONFLICT (user_id, service_key) DO UPDATE SET
        sample_size = EXCLUDED.sample_size, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90, updated_at = now();
      v_keys := v_keys || left(s->>'service_key', 200);
      v_n := v_n + 1;
    EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
      CONTINUE;
    END;
  END LOOP;

  DELETE FROM job_duration_service_stats WHERE user_id = v_owner AND NOT (service_key = ANY (v_keys));
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.save_duration_service_stats(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_duration_service_stats(jsonb) TO authenticated;

-- ============================================================
-- 9. Public, aggregate-only: slot length per service for the booking page
--    Returns NULL unless booking is enabled AND the owner switched the feed on,
--    so a disabled page / disabled feed leaks nothing.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_booking_predicted_durations(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    jsonb_object_agg(
      st.service_key,
      (CEIL(
        (CASE s.slot_policy WHEN 'tight' THEN st.p50 WHEN 'safe' THEN st.p90 ELSE st.p75 END)::numeric / 15
      ) * 15)::int
    ),
    '{}'::jsonb
  )
  FROM business_profile bp
  JOIN job_duration_settings s ON s.user_id = bp.user_id AND s.feed_booking
  JOIN job_duration_service_stats st ON st.user_id = bp.user_id
  WHERE bp.booking_slug = p_slug AND bp.booking_enabled
  HAVING count(*) > 0;
$$;

REVOKE ALL ON FUNCTION public.get_booking_predicted_durations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_booking_predicted_durations(text) TO anon, authenticated;
