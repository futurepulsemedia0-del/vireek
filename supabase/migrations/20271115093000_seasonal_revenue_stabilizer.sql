/*
  # Seasonal Revenue Stabilizer

  Flattens demand and cash flow across the year: forecasts peak/valley weeks per service line from the
  account's own job history (+ weather-event frequency and the k-anonymous regional trend), proposes
  smoothing actions, routes each through an approval step and measures the result afterwards.

  ## What this adds
  1. `seasonal_stabilizer_settings` — one row per account: thresholds, incentive + valley-discount caps,
     staffing cost assumptions, reserve buffer, deferrable service lines.
  2. `seasonal_stabilizer_runs`     — every forecast the dashboard saved (last 24 kept) so results can be compared.
  3. `seasonal_stabilizer_actions`  — proposed -> approved|rejected -> launched -> measured|cancelled.
     Every action carries an estimated revenue + margin impact, a margin-guardrail verdict and, later, measured results.
  4. `seasonal_deferral_offers`     — customer opt-in offers to move a deferrable job from a peak week into a valley week.
  5. RPCs: history aggregation, settings, save run, propose / decide / launch / measure actions, deferral offers.

  ## Reuse (no second source of truth)
  - Margin floor + fallback cost ratio  -> business_profile.margin_floor_pct / default_cost_ratio_pct (Margin Guardrails).
  - Per-line margin                      -> job_profitability view (when present).
  - Fixed costs / cash balance / 13-week outlook -> cash_flow_fixed_expenses / cash_flow_settings / cash_flow_snapshots.
  - Membership counts + plan prices      -> memberships / membership_plans.
  - Weather signal                       -> weather_surge_events.  Regional signal -> regional_demand_snapshots.
  - Technician headcount                 -> team_members (same definition as Capacity Demand Control).

  ## Security
  Every table has RLS (SELECT only, owner/admin of the account). All writes go through SECURITY DEFINER RPCs
  scoped by public.get_account_owner_id(), so CHECK constraints and the approval workflow cannot be bypassed.
  Optional columns of other tables are read through to_jsonb(row) so this migration never depends on a column
  that may not exist in a given environment.
*/

-- =============================================================
-- Permission helper (owner / active admin only: cost + margin data is sensitive)
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_seasonal_stabilizer()
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

REVOKE ALL ON FUNCTION public.can_manage_seasonal_stabilizer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_seasonal_stabilizer() TO authenticated;

CREATE OR REPLACE FUNCTION public.seasonal_owner_timezone(p_owner uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
BEGIN
  SELECT NULLIF(to_jsonb(bp) ->> 'timezone', '') INTO v_tz
  FROM public.business_profile bp WHERE bp.user_id = p_owner;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = v_tz) THEN
    RETURN 'America/New_York';
  END IF;
  RETURN v_tz;
END;
$$;

-- Internal helper: callable only by the other SECURITY DEFINER functions below.
REVOKE ALL ON FUNCTION public.seasonal_owner_timezone(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- Settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.seasonal_stabilizer_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  valley_threshold_pct integer NOT NULL DEFAULT 85 CHECK (valley_threshold_pct BETWEEN 50 AND 98),
  peak_threshold_pct integer NOT NULL DEFAULT 115 CHECK (peak_threshold_pct BETWEEN 102 AND 200),
  max_valley_discount_pct numeric(4,1) NOT NULL DEFAULT 10 CHECK (max_valley_discount_pct BETWEEN 0 AND 25),
  incentive_pct numeric(4,1) NOT NULL DEFAULT 5 CHECK (incentive_pct BETWEEN 0 AND 20),
  shift_share_pct integer NOT NULL DEFAULT 20 CHECK (shift_share_pct BETWEEN 5 AND 60),
  valley_sunk_labor_pct integer NOT NULL DEFAULT 40 CHECK (valley_sunk_labor_pct BETWEEN 0 AND 90),
  subcontractor_margin_share_pct integer NOT NULL DEFAULT 30 CHECK (subcontractor_margin_share_pct BETWEEN 0 AND 60),
  temp_help_cost_multiplier numeric(3,2) NOT NULL DEFAULT 1.30 CHECK (temp_help_cost_multiplier BETWEEN 1 AND 3),
  overtime_multiplier numeric(3,2) NOT NULL DEFAULT 1.50 CHECK (overtime_multiplier BETWEEN 1 AND 3),
  tech_hourly_cost_cents integer CHECK (tech_hourly_cost_cents IS NULL OR tech_hourly_cost_cents BETWEEN 0 AND 100000),
  paid_hours_per_tech_week numeric(4,1) NOT NULL DEFAULT 40 CHECK (paid_hours_per_tech_week BETWEEN 20 AND 80),
  reserve_buffer_weeks integer NOT NULL DEFAULT 6 CHECK (reserve_buffer_weeks BETWEEN 0 AND 26),
  deferrable_service_lines text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valley_threshold_pct < peak_threshold_pct)
);

ALTER TABLE public.seasonal_stabilizer_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_seasonal_stabilizer_settings" ON public.seasonal_stabilizer_settings;
CREATE POLICY "select_own_seasonal_stabilizer_settings" ON public.seasonal_stabilizer_settings
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_seasonal_stabilizer());
-- No client INSERT/UPDATE policy: writes go through the RPCs below so CHECKs can't be bypassed.

-- =============================================================
-- Runs (saved forecasts)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.seasonal_stabilizer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by uuid,
  engine_version text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  stability_score integer NOT NULL CHECK (stability_score BETWEEN 0 AND 100),
  stability_score_with_actions integer CHECK (stability_score_with_actions IS NULL OR stability_score_with_actions BETWEEN 0 AND 100),
  headline jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seasonal_stabilizer_runs_user
  ON public.seasonal_stabilizer_runs (user_id, created_at DESC);

ALTER TABLE public.seasonal_stabilizer_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_seasonal_stabilizer_runs" ON public.seasonal_stabilizer_runs;
CREATE POLICY "select_own_seasonal_stabilizer_runs" ON public.seasonal_stabilizer_runs
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_seasonal_stabilizer());

CREATE OR REPLACE FUNCTION public.trim_seasonal_stabilizer_runs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.seasonal_stabilizer_runs
  WHERE user_id = NEW.user_id
    AND id NOT IN (
      SELECT id FROM public.seasonal_stabilizer_runs
      WHERE user_id = NEW.user_id ORDER BY created_at DESC LIMIT 24
    );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_trim_seasonal_stabilizer_runs ON public.seasonal_stabilizer_runs;
CREATE TRIGGER trg_trim_seasonal_stabilizer_runs
  AFTER INSERT ON public.seasonal_stabilizer_runs
  FOR EACH ROW EXECUTE FUNCTION public.trim_seasonal_stabilizer_runs();

-- =============================================================
-- Actions (proposal -> approval -> launch -> measurement)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.seasonal_stabilizer_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 200),
  action_type text NOT NULL CHECK (action_type IN (
    'pre_season_campaign', 'early_booking_incentive', 'membership_push',
    'defer_to_valley', 'valley_pricing', 'peak_surge_staffing'
  )),
  service_line text NOT NULL CHECK (char_length(service_line) BETWEEN 1 AND 120),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  rationale text NOT NULL DEFAULT '' CHECK (char_length(rationale) <= 2000),
  window_start date NOT NULL,
  window_end date NOT NULL,
  est_revenue_cents bigint NOT NULL DEFAULT 0,
  est_margin_cents bigint NOT NULL DEFAULT 0,
  shifted_revenue_cents bigint NOT NULL DEFAULT 0,
  est_labor_hours numeric(10,1) NOT NULL DEFAULT 0,
  margin_pct_after numeric(6,1),
  margin_floor_pct numeric(5,1),
  guardrail_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (guardrail_status IN ('not_applicable', 'within_floor', 'blocked', 'overridden')),
  override_reason text,
  override_by uuid,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'launched', 'measured', 'cancelled')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  measure_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  launched_at timestamptz,
  launch_ref text,
  measured_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start),
  CONSTRAINT seasonal_stabilizer_actions_fp_unique UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_stabilizer_actions_user_status
  ON public.seasonal_stabilizer_actions (user_id, status, window_start);

ALTER TABLE public.seasonal_stabilizer_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_seasonal_stabilizer_actions" ON public.seasonal_stabilizer_actions;
CREATE POLICY "select_own_seasonal_stabilizer_actions" ON public.seasonal_stabilizer_actions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_seasonal_stabilizer());

-- =============================================================
-- Deferral offers (customer opt-in to move a job out of a peak week)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.seasonal_deferral_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES public.seasonal_stabilizer_actions(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  customer_name text,
  original_datetime timestamptz NOT NULL,
  proposed_datetime timestamptz NOT NULL,
  incentive_pct numeric(4,1) NOT NULL DEFAULT 0 CHECK (incentive_pct BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'accepted', 'declined', 'failed')),
  failure_reason text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasonal_deferral_offers_unique UNIQUE (action_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_deferral_offers_user_action
  ON public.seasonal_deferral_offers (user_id, action_id);

ALTER TABLE public.seasonal_deferral_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_seasonal_deferral_offers" ON public.seasonal_deferral_offers;
CREATE POLICY "select_own_seasonal_deferral_offers" ON public.seasonal_deferral_offers
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_seasonal_stabilizer());

-- =============================================================
-- RPC: settings
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_or_create_seasonal_settings()
RETURNS public.seasonal_stabilizer_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_settings;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.seasonal_stabilizer_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.seasonal_stabilizer_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_seasonal_settings(p_patch jsonb)
RETURNS public.seasonal_stabilizer_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_settings;
  v_lines text[];
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Patch must be a JSON object' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.seasonal_stabilizer_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  IF p_patch ? 'deferrable_service_lines' AND jsonb_typeof(p_patch -> 'deferrable_service_lines') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT left(lower(btrim(x)), 120)) FILTER (WHERE btrim(x) <> ''), '{}'::text[])
      INTO v_lines
    FROM jsonb_array_elements_text(p_patch -> 'deferrable_service_lines') AS t(x);
    IF array_length(v_lines, 1) > 30 THEN
      RAISE EXCEPTION 'At most 30 deferrable service lines' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.seasonal_stabilizer_settings s SET
    valley_threshold_pct = CASE WHEN p_patch ? 'valley_threshold_pct' THEN (p_patch ->> 'valley_threshold_pct')::integer ELSE s.valley_threshold_pct END,
    peak_threshold_pct = CASE WHEN p_patch ? 'peak_threshold_pct' THEN (p_patch ->> 'peak_threshold_pct')::integer ELSE s.peak_threshold_pct END,
    max_valley_discount_pct = CASE WHEN p_patch ? 'max_valley_discount_pct' THEN (p_patch ->> 'max_valley_discount_pct')::numeric ELSE s.max_valley_discount_pct END,
    incentive_pct = CASE WHEN p_patch ? 'incentive_pct' THEN (p_patch ->> 'incentive_pct')::numeric ELSE s.incentive_pct END,
    shift_share_pct = CASE WHEN p_patch ? 'shift_share_pct' THEN (p_patch ->> 'shift_share_pct')::integer ELSE s.shift_share_pct END,
    valley_sunk_labor_pct = CASE WHEN p_patch ? 'valley_sunk_labor_pct' THEN (p_patch ->> 'valley_sunk_labor_pct')::integer ELSE s.valley_sunk_labor_pct END,
    subcontractor_margin_share_pct = CASE WHEN p_patch ? 'subcontractor_margin_share_pct' THEN (p_patch ->> 'subcontractor_margin_share_pct')::integer ELSE s.subcontractor_margin_share_pct END,
    temp_help_cost_multiplier = CASE WHEN p_patch ? 'temp_help_cost_multiplier' THEN (p_patch ->> 'temp_help_cost_multiplier')::numeric ELSE s.temp_help_cost_multiplier END,
    overtime_multiplier = CASE WHEN p_patch ? 'overtime_multiplier' THEN (p_patch ->> 'overtime_multiplier')::numeric ELSE s.overtime_multiplier END,
    tech_hourly_cost_cents = CASE WHEN p_patch ? 'tech_hourly_cost_cents' THEN (p_patch ->> 'tech_hourly_cost_cents')::integer ELSE s.tech_hourly_cost_cents END,
    paid_hours_per_tech_week = CASE WHEN p_patch ? 'paid_hours_per_tech_week' THEN (p_patch ->> 'paid_hours_per_tech_week')::numeric ELSE s.paid_hours_per_tech_week END,
    reserve_buffer_weeks = CASE WHEN p_patch ? 'reserve_buffer_weeks' THEN (p_patch ->> 'reserve_buffer_weeks')::integer ELSE s.reserve_buffer_weeks END,
    deferrable_service_lines = CASE WHEN v_lines IS NOT NULL THEN v_lines ELSE s.deferrable_service_lines END,
    updated_at = now()
  WHERE s.user_id = v_owner
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: aggregated history for the engine (ONE read)
-- =============================================================
CREATE OR REPLACE FUNCTION public.seasonal_stabilizer_history()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_bp jsonb;
  v_tz text;
  v_today date;
  v_week_start date;
  v_industry text;
  v_area text;
  v_weekly jsonb := '[]'::jsonb;
  v_booked jsonb := '[]'::jsonb;
  v_margin jsonb := '[]'::jsonb;
  v_weather jsonb := '[]'::jsonb;
  v_regional jsonb := 'null'::jsonb;
  v_tech jsonb := '{}'::jsonb;
  v_members jsonb := '{}'::jsonb;
  v_plans jsonb := '[]'::jsonb;
  v_fixed_monthly bigint := 0;
  v_cash jsonb := 'null'::jsonb;
  v_snapshot jsonb := 'null'::jsonb;
  v_settings jsonb := '{}'::jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(bp) INTO v_bp FROM public.business_profile bp WHERE bp.user_id = v_owner;
  v_bp := COALESCE(v_bp, '{}'::jsonb);
  v_tz := public.seasonal_owner_timezone(v_owner);
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_week_start := date_trunc('week', v_today::timestamp)::date;
  v_industry := NULLIF(v_bp ->> 'primary_industry', '');
  v_area := NULLIF(btrim(COALESCE(v_bp ->> 'service_area', '')), '');

  -- Past weeks (up to ~3 years), per service line. Revenue = invoice_amount of non-cancelled jobs.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('w', x.w, 'line', x.line, 'jobs', x.jobs,
                                               'revenue_cents', x.rev, 'minutes', x.mins) ORDER BY x.w, x.line), '[]'::jsonb)
    INTO v_weekly
  FROM (
    SELECT date_trunc('week', (j.scheduled_datetime AT TIME ZONE v_tz))::date AS w,
           COALESCE(NULLIF(lower(btrim(j.service_type)), ''), 'other') AS line,
           count(*) AS jobs,
           COALESCE(sum(round(COALESCE(j.invoice_amount, 0) * 100)), 0)::bigint AS rev,
           COALESCE(sum(j.duration_minutes), 0)::bigint AS mins
    FROM public.jobs j
    WHERE j.user_id = v_owner
      AND j.scheduled_datetime IS NOT NULL
      AND lower(j.job_status) NOT IN ('cancelled', 'canceled')
      AND j.scheduled_datetime >= ((v_week_start - 1100)::timestamp AT TIME ZONE v_tz)
      AND j.scheduled_datetime < (v_week_start::timestamp AT TIME ZONE v_tz)
    GROUP BY 1, 2
  ) x;

  -- Already-booked work for the coming ~26 weeks (current week included).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('w', x.w, 'line', x.line, 'jobs', x.jobs,
                                               'revenue_cents', x.rev, 'minutes', x.mins) ORDER BY x.w, x.line), '[]'::jsonb)
    INTO v_booked
  FROM (
    SELECT date_trunc('week', (j.scheduled_datetime AT TIME ZONE v_tz))::date AS w,
           COALESCE(NULLIF(lower(btrim(j.service_type)), ''), 'other') AS line,
           count(*) AS jobs,
           COALESCE(sum(round(COALESCE(j.invoice_amount, 0) * 100)), 0)::bigint AS rev,
           COALESCE(sum(j.duration_minutes), 0)::bigint AS mins
    FROM public.jobs j
    WHERE j.user_id = v_owner
      AND j.scheduled_datetime IS NOT NULL
      AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
      AND j.scheduled_datetime >= (v_week_start::timestamp AT TIME ZONE v_tz)
      AND j.scheduled_datetime < ((v_week_start + 182)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1, 2
  ) x;

  -- Real per-line margin (only where cost entries exist). Dynamic + guarded: never breaks the forecast.
  IF to_regclass('public.job_profitability') IS NOT NULL THEN
    BEGIN
      EXECUTE format($q$
        SELECT COALESCE(jsonb_agg(jsonb_build_object('line', t.line, 'margin_pct', t.m, 'sample', t.n)), '[]'::jsonb)
        FROM (
          SELECT COALESCE(NULLIF(lower(btrim(jp.service_type)), ''), 'other') AS line,
                 round(sum(jp.gross_profit_cents)::numeric * 100.0 / NULLIF(sum(jp.revenue_cents), 0), 1) AS m,
                 count(*) AS n
          FROM public.job_profitability jp
          WHERE jp.user_id = %L
            AND jp.cost_entry_count > 0
            AND jp.revenue_cents > 0
            AND jp.scheduled_datetime >= now() - interval '540 days'
          GROUP BY 1
          HAVING sum(jp.revenue_cents) > 0
        ) t
      $q$, v_owner) INTO v_margin;
    EXCEPTION WHEN OTHERS THEN
      v_margin := '[]'::jsonb;
    END;
  END IF;

  -- Weather: how often a triggered severe-weather surge happened in each calendar month.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('m', x.m, 'events', x.ev, 'years', x.yrs) ORDER BY x.m), '[]'::jsonb)
    INTO v_weather
  FROM (
    SELECT extract(month FROM e.effective_at)::int AS m,
           count(*) AS ev,
           count(DISTINCT extract(year FROM e.effective_at)) AS yrs
    FROM public.weather_surge_events e
    WHERE e.user_id = v_owner AND e.triggered_surge AND e.effective_at IS NOT NULL
    GROUP BY 1
  ) x;

  -- Regional demand: k-anonymous snapshot only (sample_size >= 5).
  IF v_industry IS NOT NULL AND v_area IS NOT NULL THEN
    SELECT jsonb_build_object('change_pct', r.call_volume_change_pct, 'sample_size', r.sample_size,
                              'label', r.region_label, 'computed_at', r.computed_at)
      INTO v_regional
    FROM public.regional_demand_snapshots r
    WHERE r.industry = v_industry AND r.region_key = lower(v_area) AND r.sample_size >= 5
    LIMIT 1;
    v_regional := COALESCE(v_regional, 'null'::jsonb);
  END IF;

  SELECT jsonb_build_object(
           'headcount', count(*),
           'capacity_jobs_per_day', COALESCE(sum(tm.max_jobs_per_day), 0),
           'avg_hourly_cost_cents', round(avg(NULLIF(to_jsonb(tm) ->> 'hourly_cost_rate_cents', '')::numeric))
         )
    INTO v_tech
  FROM public.team_members tm
  WHERE tm.account_owner_id = v_owner AND tm.role = 'technician' AND tm.dispatch_enabled = true;

  SELECT jsonb_build_object(
           'active', count(*) FILTER (WHERE m.status IN ('active', 'past_due')),
           'offered', count(*) FILTER (WHERE m.status = 'offered'),
           'mrr_cents', COALESCE(round(sum(CASE WHEN m.status IN ('active', 'past_due') THEN
               (CASE WHEN p.billing_interval = 'yearly' THEN p.price_cents / 12.0 ELSE p.price_cents END)
             ELSE 0 END)), 0)::bigint
         )
    INTO v_members
  FROM public.memberships m
  LEFT JOIN public.membership_plans p ON p.id = m.plan_id
  WHERE m.user_id = v_owner;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price_cents', p.price_cents,
                                               'billing_interval', p.billing_interval) ORDER BY p.created_at), '[]'::jsonb)
    INTO v_plans
  FROM public.membership_plans p
  WHERE p.user_id = v_owner AND p.active;

  SELECT COALESCE(round(sum(CASE f.frequency
                              WHEN 'weekly' THEN f.amount * 52.0 / 12
                              WHEN 'biweekly' THEN f.amount * 26.0 / 12
                              WHEN 'monthly' THEN f.amount
                              ELSE 0 END) * 100), 0)::bigint
    INTO v_fixed_monthly
  FROM public.cash_flow_fixed_expenses f
  WHERE f.user_id = v_owner AND f.active;

  SELECT jsonb_build_object('starting_balance_cents', round(COALESCE(s.starting_cash_balance, 0) * 100)::bigint,
                            'default_cost_ratio_pct', s.default_cost_ratio)
    INTO v_cash
  FROM public.cash_flow_settings s WHERE s.user_id = v_owner;

  SELECT jsonb_build_object('created_at', n.created_at, 'weeks', n.weeks)
    INTO v_snapshot
  FROM public.cash_flow_snapshots n
  WHERE n.user_id = v_owner
  ORDER BY n.created_at DESC
  LIMIT 1;

  SELECT to_jsonb(s) INTO v_settings FROM public.seasonal_stabilizer_settings s WHERE s.user_id = v_owner;

  RETURN jsonb_build_object(
    'timezone', v_tz,
    'today', v_today,
    'week_start', v_week_start,
    'industry', v_industry,
    'service_area', v_area,
    'weekly', v_weekly,
    'booked_ahead', v_booked,
    'line_margin', v_margin,
    'margin_floor_pct', COALESCE((v_bp ->> 'margin_floor_pct')::numeric, 20),
    'default_cost_ratio_pct', COALESCE((v_bp ->> 'default_cost_ratio_pct')::numeric, 55),
    'weather_monthly', v_weather,
    'regional', v_regional,
    'tech', v_tech,
    'memberships', v_members,
    'membership_plans', v_plans,
    'fixed_monthly_cents', v_fixed_monthly,
    'cash', COALESCE(v_cash, 'null'::jsonb),
    'cash_snapshot', COALESCE(v_snapshot, 'null'::jsonb),
    'settings', COALESCE(v_settings, '{}'::jsonb)
  );
END;
$$;

-- =============================================================
-- RPC: save a forecast run
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_seasonal_stabilizer_run(
  p_engine_version text,
  p_confidence text,
  p_score integer,
  p_score_with_actions integer,
  p_headline jsonb,
  p_report jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' OR pg_column_size(p_report) > 2000000 THEN
    RAISE EXCEPTION 'Report must be a JSON object under 2 MB' USING ERRCODE = '22023';
  END IF;
  IF p_confidence NOT IN ('high', 'medium', 'low') THEN
    RAISE EXCEPTION 'Invalid confidence' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.seasonal_stabilizer_runs
    (user_id, requested_by, engine_version, confidence, stability_score, stability_score_with_actions, headline, report)
  VALUES
    (v_owner, auth.uid(), left(COALESCE(p_engine_version, 'unknown'), 40), p_confidence,
     GREATEST(0, LEAST(100, COALESCE(p_score, 0))),
     CASE WHEN p_score_with_actions IS NULL THEN NULL ELSE GREATEST(0, LEAST(100, p_score_with_actions)) END,
     COALESCE(p_headline, '{}'::jsonb), p_report)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- =============================================================
-- RPC: propose actions (idempotent; never touches decided actions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.propose_seasonal_actions(p_actions jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item jsonb;
  v_fps text[] := '{}';
  v_is_new boolean;
  v_inserted integer := 0;
  v_refreshed integer := 0;
  v_cancelled integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array' THEN
    RAISE EXCEPTION 'Actions must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_actions) > 200 THEN
    RAISE EXCEPTION 'At most 200 actions per call' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
    v_fps := array_append(v_fps, v_item ->> 'fingerprint');
    v_is_new := NULL;

    INSERT INTO public.seasonal_stabilizer_actions AS a (
      user_id, fingerprint, action_type, service_line, title, rationale, window_start, window_end,
      est_revenue_cents, est_margin_cents, shifted_revenue_cents, est_labor_hours,
      margin_pct_after, margin_floor_pct, guardrail_status, details, measure_windows
    ) VALUES (
      v_owner,
      v_item ->> 'fingerprint',
      v_item ->> 'action_type',
      left(v_item ->> 'service_line', 120),
      left(v_item ->> 'title', 200),
      left(COALESCE(v_item ->> 'rationale', ''), 2000),
      (v_item ->> 'window_start')::date,
      (v_item ->> 'window_end')::date,
      round(COALESCE((v_item ->> 'est_revenue_cents')::numeric, 0))::bigint,
      round(COALESCE((v_item ->> 'est_margin_cents')::numeric, 0))::bigint,
      round(COALESCE((v_item ->> 'shifted_revenue_cents')::numeric, 0))::bigint,
      round(COALESCE((v_item ->> 'est_labor_hours')::numeric, 0), 1),
      round((v_item ->> 'margin_pct_after')::numeric, 1),
      round((v_item ->> 'margin_floor_pct')::numeric, 1),
      COALESCE(NULLIF(v_item ->> 'guardrail_status', ''), 'not_applicable'),
      COALESCE(v_item -> 'details', '{}'::jsonb),
      COALESCE(v_item -> 'measure_windows', '[]'::jsonb)
    )
    ON CONFLICT ON CONSTRAINT seasonal_stabilizer_actions_fp_unique DO UPDATE SET
      title = EXCLUDED.title,
      rationale = EXCLUDED.rationale,
      window_start = EXCLUDED.window_start,
      window_end = EXCLUDED.window_end,
      est_revenue_cents = EXCLUDED.est_revenue_cents,
      est_margin_cents = EXCLUDED.est_margin_cents,
      shifted_revenue_cents = EXCLUDED.shifted_revenue_cents,
      est_labor_hours = EXCLUDED.est_labor_hours,
      margin_pct_after = EXCLUDED.margin_pct_after,
      margin_floor_pct = EXCLUDED.margin_floor_pct,
      guardrail_status = EXCLUDED.guardrail_status,
      details = EXCLUDED.details,
      measure_windows = EXCLUDED.measure_windows,
      updated_at = now()
    WHERE a.status = 'proposed'
    RETURNING (xmax = 0) INTO v_is_new;

    IF v_is_new IS TRUE THEN
      v_inserted := v_inserted + 1;
    ELSIF v_is_new IS FALSE THEN
      v_refreshed := v_refreshed + 1;
    END IF;
  END LOOP;

  -- Proposals the latest forecast no longer supports are withdrawn (decided actions are never touched).
  UPDATE public.seasonal_stabilizer_actions a
     SET status = 'cancelled', decision_note = 'Superseded by a newer forecast', updated_at = now()
   WHERE a.user_id = v_owner
     AND a.status = 'proposed'
     AND NOT (a.fingerprint = ANY (v_fps));
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'refreshed', v_refreshed, 'withdrawn', v_cancelled);
END;
$$;

-- =============================================================
-- RPC: approval step
-- =============================================================
CREATE OR REPLACE FUNCTION public.decide_seasonal_action(p_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS public.seasonal_stabilizer_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_actions;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_is_owner boolean;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.seasonal_stabilizer_actions WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only proposed actions can be approved' USING ERRCODE = '22023';
    END IF;
    IF v_row.guardrail_status = 'blocked' THEN
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner') INTO v_is_owner;
      IF NOT v_is_owner THEN
        RAISE EXCEPTION 'Below the margin floor: only the account owner can approve with an override' USING ERRCODE = '42501';
      END IF;
      IF v_reason IS NULL OR char_length(v_reason) < 10 THEN
        RAISE EXCEPTION 'Below the margin floor: an override reason of at least 10 characters is required' USING ERRCODE = '22023';
      END IF;
      UPDATE public.seasonal_stabilizer_actions
         SET guardrail_status = 'overridden', override_reason = v_reason, override_by = auth.uid()
       WHERE id = p_id;
    END IF;
    UPDATE public.seasonal_stabilizer_actions
       SET status = 'approved', decided_by = auth.uid(), decided_at = now(),
           decision_note = COALESCE(v_reason, decision_note), updated_at = now()
     WHERE id = p_id
     RETURNING * INTO v_row;

  ELSIF p_decision = 'reject' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only proposed actions can be rejected' USING ERRCODE = '22023';
    END IF;
    UPDATE public.seasonal_stabilizer_actions
       SET status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           decision_note = v_reason, updated_at = now()
     WHERE id = p_id
     RETURNING * INTO v_row;

  ELSIF p_decision = 'cancel' THEN
    IF v_row.status NOT IN ('proposed', 'approved', 'launched') THEN
      RAISE EXCEPTION 'This action can no longer be cancelled' USING ERRCODE = '22023';
    END IF;
    UPDATE public.seasonal_stabilizer_actions
       SET status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
           decision_note = v_reason, updated_at = now()
     WHERE id = p_id
     RETURNING * INTO v_row;

  ELSE
    RAISE EXCEPTION 'Decision must be approve, reject or cancel' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.launch_seasonal_action(p_id uuid, p_ref text DEFAULT NULL)
RETURNS public.seasonal_stabilizer_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_actions;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.seasonal_stabilizer_actions
     SET status = 'launched', launched_at = now(), launch_ref = left(NULLIF(btrim(COALESCE(p_ref, '')), ''), 500), updated_at = now()
   WHERE id = p_id AND user_id = v_owner AND status = 'approved'
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only approved actions can be marked as launched' USING ERRCODE = '22023';
  END IF;
  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: measured results (observational: actual vs the baseline forecast stored at proposal time)
-- =============================================================
CREATE OR REPLACE FUNCTION public.measure_seasonal_action(p_id uuid)
RETURNS public.seasonal_stabilizer_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_actions;
  v_tz text;
  v_today date;
  v_w jsonb;
  v_start date;
  v_end date;
  v_max_end date;
  v_actual bigint;
  v_jobs integer;
  v_all_lines boolean;
  v_windows jsonb := '[]'::jsonb;
  v_realized bigint := 0;
  v_predicted bigint := 0;
  v_expected_base bigint;
  v_expected_with bigint;
  v_margin_pct numeric;
  v_new_members integer := 0;
  v_offers_accepted integer := 0;
  v_offers_total integer := 0;
  v_result jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.seasonal_stabilizer_actions WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('approved', 'launched', 'measured') THEN
    RAISE EXCEPTION 'Only approved or launched actions can be measured' USING ERRCODE = '22023';
  END IF;

  v_tz := public.seasonal_owner_timezone(v_owner);
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_all_lines := (v_row.service_line = '*');

  SELECT max((w ->> 'end')::date) INTO v_max_end FROM jsonb_array_elements(v_row.measure_windows) AS t(w);
  IF v_max_end IS NULL THEN
    v_max_end := v_row.window_end;
  END IF;
  IF v_max_end >= v_today THEN
    RAISE EXCEPTION 'The measurement window ends on % - measure again after it has finished', v_max_end USING ERRCODE = '22023';
  END IF;

  FOR v_w IN SELECT value FROM jsonb_array_elements(v_row.measure_windows) LOOP
    v_start := (v_w ->> 'start')::date;
    v_end := (v_w ->> 'end')::date;
    v_expected_base := round(COALESCE((v_w ->> 'expected_baseline_cents')::numeric, 0))::bigint;
    v_expected_with := round(COALESCE((v_w ->> 'expected_with_action_cents')::numeric, 0))::bigint;

    SELECT COALESCE(sum(round(COALESCE(j.invoice_amount, 0) * 100)), 0)::bigint, count(*)::integer
      INTO v_actual, v_jobs
    FROM public.jobs j
    WHERE j.user_id = v_owner
      AND j.scheduled_datetime IS NOT NULL
      AND lower(j.job_status) NOT IN ('cancelled', 'canceled')
      AND (v_all_lines OR COALESCE(NULLIF(lower(btrim(j.service_type)), ''), 'other') = v_row.service_line)
      AND (j.scheduled_datetime AT TIME ZONE v_tz)::date BETWEEN v_start AND v_end;

    v_realized := v_realized + (v_actual - v_expected_base);
    v_predicted := v_predicted + (v_expected_with - v_expected_base);
    v_windows := v_windows || jsonb_build_array(jsonb_build_object(
      'role', v_w ->> 'role', 'start', v_start, 'end', v_end,
      'expected_baseline_cents', v_expected_base, 'expected_with_action_cents', v_expected_with,
      'actual_cents', v_actual, 'actual_jobs', v_jobs));
  END LOOP;

  IF v_row.action_type = 'membership_push' THEN
    SELECT count(*)::integer INTO v_new_members
    FROM public.memberships m
    WHERE m.user_id = v_owner
      AND m.started_at IS NOT NULL
      AND (m.started_at AT TIME ZONE v_tz)::date BETWEEN v_row.window_start AND v_row.window_end;
  END IF;

  IF v_row.action_type = 'defer_to_valley' THEN
    SELECT count(*) FILTER (WHERE o.status = 'accepted')::integer, count(*)::integer
      INTO v_offers_accepted, v_offers_total
    FROM public.seasonal_deferral_offers o
    WHERE o.user_id = v_owner AND o.action_id = v_row.id;
  END IF;

  v_margin_pct := COALESCE((v_row.details ->> 'line_margin_pct')::numeric, 0);

  v_result := jsonb_build_object(
    'measured_on', v_today,
    'windows', v_windows,
    'realized_revenue_delta_cents', v_realized,
    'predicted_revenue_delta_cents', v_predicted,
    'realized_margin_delta_cents', round(v_realized * v_margin_pct / 100.0)::bigint,
    'accuracy_ratio', CASE WHEN v_predicted <> 0 THEN round(v_realized::numeric / v_predicted, 2) ELSE NULL END,
    'new_memberships', v_new_members,
    'membership_target', (v_row.details ->> 'target_new_members')::numeric,
    'deferral_offers_accepted', v_offers_accepted,
    'deferral_offers_total', v_offers_total,
    'method', 'Actual invoiced revenue of non-cancelled jobs in each window vs the baseline forecast stored when the action was proposed. Observational, not causal.'
  );

  UPDATE public.seasonal_stabilizer_actions
     SET status = 'measured', measured_at = now(), result = v_result, updated_at = now()
   WHERE id = p_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: deferral offers (customer opt-in, recorded by staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_seasonal_deferral_offers(p_action_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.seasonal_stabilizer_actions;
  v_tz text;
  v_lines text[];
  v_src_start date;
  v_src_end date;
  v_shift_days integer;
  v_max integer;
  v_incentive numeric;
  v_count integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.seasonal_stabilizer_actions WHERE id = p_action_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.action_type <> 'defer_to_valley' OR v_row.status NOT IN ('approved', 'launched') THEN
    RAISE EXCEPTION 'Offers can only be created for an approved defer-to-valley action' USING ERRCODE = '22023';
  END IF;

  SELECT s.deferrable_service_lines INTO v_lines FROM public.seasonal_stabilizer_settings s WHERE s.user_id = v_owner;
  IF v_lines IS NULL OR array_length(v_lines, 1) IS NULL THEN
    RAISE EXCEPTION 'Choose your deferrable service lines in the stabilizer settings first' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_row.service_line = ANY (v_lines)) THEN
    RAISE EXCEPTION 'This service line is not marked deferrable in settings' USING ERRCODE = '22023';
  END IF;

  v_tz := public.seasonal_owner_timezone(v_owner);
  v_src_start := (v_row.details ->> 'source_start')::date;
  v_src_end := (v_row.details ->> 'source_end')::date;
  v_shift_days := (v_row.details ->> 'shift_days')::integer;
  v_max := GREATEST(1, LEAST(500, COALESCE((v_row.details ->> 'max_jobs')::integer, 25)));
  v_incentive := COALESCE((v_row.details ->> 'incentive_pct')::numeric, 0);

  IF v_src_start IS NULL OR v_src_end IS NULL OR v_shift_days IS NULL OR v_shift_days < 7 THEN
    RAISE EXCEPTION 'This action has no valid source window' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.seasonal_deferral_offers
    (user_id, action_id, job_id, customer_name, original_datetime, proposed_datetime, incentive_pct)
  SELECT v_owner, v_row.id, j.id, j.customer_name, j.scheduled_datetime,
         j.scheduled_datetime + make_interval(days => v_shift_days), v_incentive
  FROM public.jobs j
  WHERE j.user_id = v_owner
    AND j.job_status = 'scheduled'
    AND j.scheduled_datetime IS NOT NULL
    AND COALESCE(NULLIF(lower(btrim(j.service_type)), ''), 'other') = v_row.service_line
    AND (j.scheduled_datetime AT TIME ZONE v_tz)::date BETWEEN v_src_start AND v_src_end
    AND (j.scheduled_datetime AT TIME ZONE v_tz)::date >= (now() AT TIME ZONE v_tz)::date
  ORDER BY j.scheduled_datetime
  LIMIT v_max
  ON CONFLICT ON CONSTRAINT seasonal_deferral_offers_unique DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_seasonal_deferral_offer(p_offer_id uuid, p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_offer public.seasonal_deferral_offers;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_seasonal_stabilizer() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_offer FROM public.seasonal_deferral_offers WHERE id = p_offer_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offer not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_offer.status <> 'offered' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This offer was already answered');
  END IF;

  IF NOT COALESCE(p_accept, false) THEN
    UPDATE public.seasonal_deferral_offers SET status = 'declined', responded_at = now() WHERE id = p_offer_id;
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;

  BEGIN
    UPDATE public.jobs
       SET scheduled_datetime = v_offer.proposed_datetime
     WHERE id = v_offer.job_id AND user_id = v_owner AND job_status = 'scheduled';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The job is no longer in a scheduled state';
    END IF;
    UPDATE public.seasonal_deferral_offers SET status = 'accepted', responded_at = now() WHERE id = p_offer_id;
    RETURN jsonb_build_object('ok', true, 'status', 'accepted');
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.seasonal_deferral_offers
       SET status = 'failed', failure_reason = left(SQLERRM, 300), responded_at = now()
     WHERE id = p_offer_id;
    RETURN jsonb_build_object('ok', false, 'error', left(SQLERRM, 300));
  END;
END;
$$;

-- =============================================================
-- Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.get_or_create_seasonal_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_seasonal_settings(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seasonal_stabilizer_history() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_seasonal_stabilizer_run(text, text, integer, integer, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_seasonal_actions(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_seasonal_action(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.launch_seasonal_action(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.measure_seasonal_action(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_seasonal_deferral_offers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_seasonal_deferral_offer(uuid, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_or_create_seasonal_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_seasonal_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seasonal_stabilizer_history() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_seasonal_stabilizer_run(text, text, integer, integer, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_seasonal_actions(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_seasonal_action(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.launch_seasonal_action(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.measure_seasonal_action(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_seasonal_deferral_offers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_seasonal_deferral_offer(uuid, boolean) TO authenticated;
