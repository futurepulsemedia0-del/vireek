/*
  # Staffing Forecast (calls + jobs -> hiring / overtime / CSR coverage)

  ## What this adds
  1. `staffing_forecast_settings` — one row per account: CSR throughput assumptions, optional
     wage inputs, average job length override, hire trigger, cached weather geocode.
  2. `staffing_forecast_runs`     — every forecast the Edge Function produced (last 60 kept).
  3. `can_manage_staffing_forecast()` — owner / active admin only (cost data is sensitive).
  4. `staffing_forecast_history()` — ONE aggregated read the engine needs: daily + hourly calls,
     daily jobs, already-booked jobs, technician capacity, CSR headcount, hours, region.
  5. `get_or_create_staffing_settings()` / `update_staffing_forecast_settings(jsonb)`.

  ## Reuse (no second source of truth)
  - Technician capacity and the low/full thresholds come from the existing Capacity Demand
    Control (`get_capacity_status` / `capacity_demand_policies`), called by the Edge Function.
  - Regional demand comes from the existing k-anonymous `regional_demand_snapshots`.

  ## Security
  All RPCs are SECURITY DEFINER, scoped by `public.get_account_owner_id()`, and refuse callers
  who cannot manage the forecast. Runs are written only by the service role (Edge Function).
*/

-- =============================================================
-- Permission helper
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_staffing_forecast()
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
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.invite_status = 'active'
        AND tm.role = 'admin'
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_staffing_forecast() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_staffing_forecast() TO authenticated;

-- =============================================================
-- Settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.staffing_forecast_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  calls_per_csr_hour numeric(5,2) NOT NULL DEFAULT 5 CHECK (calls_per_csr_hour BETWEEN 0.5 AND 30),
  csr_target_occupancy_pct integer NOT NULL DEFAULT 75 CHECK (csr_target_occupancy_pct BETWEEN 30 AND 95),
  csr_concurrent_override integer CHECK (csr_concurrent_override IS NULL OR csr_concurrent_override BETWEEN 0 AND 50),
  avg_job_minutes_override integer CHECK (avg_job_minutes_override IS NULL OR avg_job_minutes_override BETWEEN 10 AND 960),
  tech_hourly_cost_cents integer CHECK (tech_hourly_cost_cents IS NULL OR tech_hourly_cost_cents BETWEEN 0 AND 100000),
  csr_hourly_cost_cents integer CHECK (csr_hourly_cost_cents IS NULL OR csr_hourly_cost_cents BETWEEN 0 AND 100000),
  overtime_multiplier numeric(3,2) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier BETWEEN 1 AND 3),
  tech_paid_hours_per_day numeric(4,1) NOT NULL DEFAULT 8 CHECK (tech_paid_hours_per_day BETWEEN 4 AND 14),
  sustained_weeks_to_hire integer NOT NULL DEFAULT 3 CHECK (sustained_weeks_to_hire BETWEEN 1 AND 8),
  geo_zip text,
  geo_lat double precision,
  geo_lon double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staffing_forecast_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_staffing_forecast_settings" ON public.staffing_forecast_settings;
CREATE POLICY "select_own_staffing_forecast_settings" ON public.staffing_forecast_settings
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_staffing_forecast());
-- No client INSERT/UPDATE policy: writes go through the RPCs below so CHECKs can't be bypassed.

-- =============================================================
-- Runs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.staffing_forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by uuid,
  engine_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'insufficient_data')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  headline jsonb NOT NULL,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staffing_forecast_runs_user
  ON public.staffing_forecast_runs (user_id, created_at DESC);

ALTER TABLE public.staffing_forecast_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_staffing_forecast_runs" ON public.staffing_forecast_runs;
CREATE POLICY "select_own_staffing_forecast_runs" ON public.staffing_forecast_runs
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_staffing_forecast());
-- No client write policy: only the Edge Function (service role) inserts.

CREATE OR REPLACE FUNCTION public.trim_staffing_forecast_runs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.staffing_forecast_runs
  WHERE user_id = NEW.user_id
    AND id NOT IN (
      SELECT id FROM public.staffing_forecast_runs
      WHERE user_id = NEW.user_id ORDER BY created_at DESC LIMIT 60
    );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_trim_staffing_forecast_runs ON public.staffing_forecast_runs;
CREATE TRIGGER trg_trim_staffing_forecast_runs
  AFTER INSERT ON public.staffing_forecast_runs
  FOR EACH ROW EXECUTE FUNCTION public.trim_staffing_forecast_runs();

-- Helpful for the history aggregation (no-ops if equivalent indexes already exist).
CREATE INDEX IF NOT EXISTS idx_calls_user_datetime ON public.calls (user_id, call_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_scheduled ON public.jobs (user_id, scheduled_datetime);

-- =============================================================
-- RPC: settings
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_or_create_staffing_settings()
RETURNS public.staffing_forecast_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.staffing_forecast_settings;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_staffing_forecast() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.staffing_forecast_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.staffing_forecast_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_staffing_forecast_settings(p_patch jsonb)
RETURNS public.staffing_forecast_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.staffing_forecast_settings;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_staffing_forecast() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Patch must be a JSON object' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.staffing_forecast_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.staffing_forecast_settings s SET
    calls_per_csr_hour = CASE WHEN p_patch ? 'calls_per_csr_hour' THEN (p_patch ->> 'calls_per_csr_hour')::numeric ELSE s.calls_per_csr_hour END,
    csr_target_occupancy_pct = CASE WHEN p_patch ? 'csr_target_occupancy_pct' THEN (p_patch ->> 'csr_target_occupancy_pct')::integer ELSE s.csr_target_occupancy_pct END,
    csr_concurrent_override = CASE WHEN p_patch ? 'csr_concurrent_override' THEN (p_patch ->> 'csr_concurrent_override')::integer ELSE s.csr_concurrent_override END,
    avg_job_minutes_override = CASE WHEN p_patch ? 'avg_job_minutes_override' THEN (p_patch ->> 'avg_job_minutes_override')::integer ELSE s.avg_job_minutes_override END,
    tech_hourly_cost_cents = CASE WHEN p_patch ? 'tech_hourly_cost_cents' THEN (p_patch ->> 'tech_hourly_cost_cents')::integer ELSE s.tech_hourly_cost_cents END,
    csr_hourly_cost_cents = CASE WHEN p_patch ? 'csr_hourly_cost_cents' THEN (p_patch ->> 'csr_hourly_cost_cents')::integer ELSE s.csr_hourly_cost_cents END,
    overtime_multiplier = CASE WHEN p_patch ? 'overtime_multiplier' THEN (p_patch ->> 'overtime_multiplier')::numeric ELSE s.overtime_multiplier END,
    tech_paid_hours_per_day = CASE WHEN p_patch ? 'tech_paid_hours_per_day' THEN (p_patch ->> 'tech_paid_hours_per_day')::numeric ELSE s.tech_paid_hours_per_day END,
    sustained_weeks_to_hire = CASE WHEN p_patch ? 'sustained_weeks_to_hire' THEN (p_patch ->> 'sustained_weeks_to_hire')::integer ELSE s.sustained_weeks_to_hire END,
    updated_at = now()
  WHERE s.user_id = v_owner
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: aggregated history for the engine
-- =============================================================
CREATE OR REPLACE FUNCTION public.staffing_forecast_history()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tz text := 'America/New_York';
  v_hours jsonb;
  v_zip text;
  v_area text;
  v_industry text;
  v_today date;
  v_calls_daily jsonb;
  v_calls_hourly jsonb;
  v_jobs_daily jsonb;
  v_booked jsonb;
  v_tech jsonb;
  v_csr jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_staffing_forecast() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(bp.timezone, ''), 'America/New_York'), bp.business_hours,
         bp.weather_zip_code, bp.service_area, bp.primary_industry
    INTO v_tz, v_hours, v_zip, v_area, v_industry
  FROM public.business_profile bp WHERE bp.user_id = v_owner;
  v_tz := COALESCE(v_tz, 'America/New_York');
  v_today := (now() AT TIME ZONE v_tz)::date;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', x.d, 'calls', x.calls, 'human', x.human, 'emergency', x.emergency) ORDER BY x.d), '[]'::jsonb)
    INTO v_calls_daily
  FROM (
    SELECT (c.call_datetime AT TIME ZONE v_tz)::date AS d,
           count(*) AS calls,
           count(*) FILTER (WHERE c.human_transfer_requested) AS human,
           count(*) FILTER (WHERE c.is_emergency) AS emergency
    FROM public.calls c
    WHERE c.user_id = v_owner
      AND c.call_datetime >= ((v_today - 730)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', x.d, 'h', x.h, 'calls', x.calls, 'human', x.human, 'emergency', x.emergency) ORDER BY x.d, x.h), '[]'::jsonb)
    INTO v_calls_hourly
  FROM (
    SELECT (c.call_datetime AT TIME ZONE v_tz)::date AS d,
           extract(hour FROM (c.call_datetime AT TIME ZONE v_tz))::int AS h,
           count(*) AS calls,
           count(*) FILTER (WHERE c.human_transfer_requested) AS human,
           count(*) FILTER (WHERE c.is_emergency) AS emergency
    FROM public.calls c
    WHERE c.user_id = v_owner
      AND c.call_datetime >= ((v_today - 84)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1, 2
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', x.d, 'jobs', x.jobs, 'minutes', x.minutes) ORDER BY x.d), '[]'::jsonb)
    INTO v_jobs_daily
  FROM (
    SELECT (j.scheduled_datetime AT TIME ZONE v_tz)::date AS d,
           count(*) AS jobs,
           COALESCE(sum(j.duration_minutes), 0) AS minutes
    FROM public.jobs j
    WHERE j.user_id = v_owner
      AND j.scheduled_datetime IS NOT NULL
      AND j.job_status NOT IN ('cancelled', 'canceled')
      AND j.scheduled_datetime >= ((v_today - 730)::timestamp AT TIME ZONE v_tz)
      AND j.scheduled_datetime < (v_today::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', x.d, 'jobs', x.jobs) ORDER BY x.d), '[]'::jsonb)
    INTO v_booked
  FROM (
    SELECT (j.scheduled_datetime AT TIME ZONE v_tz)::date AS d, count(*) AS jobs
    FROM public.jobs j
    WHERE j.user_id = v_owner
      AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
      AND j.scheduled_datetime >= (v_today::timestamp AT TIME ZONE v_tz)
      AND j.scheduled_datetime < ((v_today + 60)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ) x;

  -- Same definition of technician capacity as get_capacity_status().
  SELECT jsonb_build_object('headcount', count(*), 'capacity_jobs_per_day', COALESCE(sum(tm.max_jobs_per_day), 0))
    INTO v_tech
  FROM public.team_members tm
  WHERE tm.account_owner_id = v_owner AND tm.role = 'technician' AND tm.dispatch_enabled = true;

  SELECT jsonb_build_object('headcount', count(*))
    INTO v_csr
  FROM public.team_members tm
  WHERE tm.account_owner_id = v_owner AND tm.invite_status = 'active' AND tm.role IN ('member', 'csr', 'dispatcher');

  RETURN jsonb_build_object(
    'timezone', v_tz,
    'today', v_today,
    'business_hours', COALESCE(v_hours, '{}'::jsonb),
    'weather_zip', v_zip,
    'service_area', v_area,
    'industry', v_industry,
    'calls_daily', v_calls_daily,
    'calls_hourly', v_calls_hourly,
    'jobs_daily', v_jobs_daily,
    'booked_ahead', v_booked,
    'tech', v_tech,
    'csr', v_csr
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_staffing_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_staffing_forecast_settings(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staffing_forecast_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_staffing_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_staffing_forecast_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staffing_forecast_history() TO authenticated;
