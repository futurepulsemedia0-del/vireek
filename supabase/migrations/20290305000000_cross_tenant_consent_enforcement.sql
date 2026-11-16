/*
  # Cross-tenant consent enforcement (central gate over the Service Data Exchange)

  ## Why
  The 2026-27 benchmarking / pattern pipelines read EVERY tenant automatically, and four of them
  default to opt-OUT (failure_genome_contribute, fie_settings.contribute_to_network,
  service_loop_settings.share_global, outcome_benchmark_settings.participating all DEFAULT true).
  20270215000000_service_data_exchange.sql already provides the consent model (sde_consents,
  append-only sde_consent_events, owner-only sde_set_consent(), give-to-get) but only its OWN pipeline
  (sde_refresh_exchange) reads it. This migration closes that gap WITHOUT a second consent system.

  ## What this adds
  1. cross_tenant_flows   registry: flow_key -> SDE domain (NULL = no consent wording covers it yet).
  2. xtl_contributors(flow) / xtl_contributes(user, flow)
                          fail-closed gate: true only when the tenant has status='granted' in
                          sde_consents for the flow's domain. Evaluated live on every build, so
                          revocation excludes the tenant from the NEXT build with no cache to expire.
  3. Twelve builders / read helpers re-created with that predicate added (see numbered sections).

  ## Behaviour change (intentional, read before deploying)
  * Cohorts now contain only tenants that granted the mapped SDE domain. Until >= 5 tenants consent,
    k-anonymity suppresses benchmark / pattern output. This is the opt-in outcome, not a bug.
  * Flows with sde_domain NULL (vertical_intelligence, causal_cohorts, rebate_realization) contribute
    NOTHING until product + counsel map them to a domain whose consent wording covers them:
        UPDATE cross_tenant_flows SET sde_domain = 'outcomes' WHERE flow_key = '...';   -- [COUNSEL]
  * Legacy opt-out flags are KEPT as additional off-switches (a tenant must pass both).

  ## Not changed
  Flows that were already opt-in by default (failure atlas, OEM reliability, evidence marketplace,
  outcome-learning aggregates, voice pooled priors, state-of-calls report, network_enabled marketplaces,
  procurement, physical-economy network). See docs/compliance/cross-tenant-data-flows.md.

  ## Safety
  Idempotent. No DROP, no DELETE of tenant data, no policy loosened. Previously published aggregates are
  replaced by the next scheduled run of each builder; run them once after deploy (see doc, section 7).

  ## Rollback
  Re-apply the original definitions from the migrations named in each section; the registry/gate
  objects can stay (unused) or be dropped:
    DROP FUNCTION IF EXISTS public.xtl_contributes(uuid, text);
    DROP FUNCTION IF EXISTS public.xtl_contributors(text);
    DROP TABLE IF EXISTS public.cross_tenant_flows;
  (drop only AFTER restoring the original functions, which would otherwise fail to resolve the gate).
*/

-- =============================================================
-- A. Registry
-- =============================================================
CREATE TABLE IF NOT EXISTS public.cross_tenant_flows (
  flow_key     text PRIMARY KEY CHECK (flow_key ~ '^[a-z0-9_]{2,48}$'),
  sde_domain   text CHECK (sde_domain IS NULL OR sde_domain IN ('failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes')),
  description  text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  wording_fit  text NOT NULL CHECK (wording_fit IN ('exact', 'partial', 'none')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cross_tenant_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cross_tenant_flows FROM PUBLIC, anon, authenticated;
-- No policy: clients never read the registry; service_role / SECURITY DEFINER code only.

-- DO NOTHING (not DO UPDATE): a manual remap made by an operator must survive a re-run of this migration.
INSERT INTO public.cross_tenant_flows (flow_key, sde_domain, description, wording_fit) VALUES
  ('benchmark_cohorts',     'outcomes', 'benchmark_cohort_stats via refresh_benchmark_cohorts()',               'exact'),
  ('regional_demand',       'outcomes', 'regional_demand_snapshots via compute_regional_demand()',              'exact'),
  ('platform_benchmarks',   'outcomes', 'benchmark_snapshots via compute_platform_benchmarks() (legacy)',       'partial'),
  ('outcome_benchmarks',    'outcomes', 'outcome_benchmark_cohorts via refresh_outcome_benchmarks()',           'partial'),
  ('failure_genome',        'failure',  'failure_patterns via refresh_failure_patterns()',                      'partial'),
  ('fie_patterns',          'failure',  'fie_global_patterns via fie_refresh_global_patterns()',                'partial'),
  ('service_loop_priors',   'failure',  'service_loop_global_priors via refresh_service_loop_global_priors()',  'partial'),
  ('vertical_intelligence', NULL,       'vertical_intelligence_signals via mine_vertical_intelligence()',       'none'),
  ('causal_cohorts',        NULL,       'compute_causal_cohort_insights()',                                     'none'),
  ('rebate_realization',    NULL,       'rebate_network_realization()',                                         'none')
ON CONFLICT (flow_key) DO NOTHING;

-- =============================================================
-- B. Gate
-- =============================================================
-- Set form: use as  <col> IN (SELECT public.xtl_contributors('flow'))  so Postgres evaluates it once
-- (uncorrelated subquery) instead of once per scanned row.
CREATE OR REPLACE FUNCTION public.xtl_contributors(p_flow text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.user_id
  FROM public.cross_tenant_flows f
  JOIN public.sde_consents c ON c.domain = f.sde_domain AND c.status = 'granted'
  WHERE f.flow_key = p_flow AND f.sde_domain IS NOT NULL;
$$;

-- Scalar form for single-tenant checks. Unknown flow, unmapped flow, missing or revoked consent => false.
CREATE OR REPLACE FUNCTION public.xtl_contributes(p_user uuid, p_flow text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.xtl_contributors(p_flow) u WHERE u = p_user
  );
$$;

-- Never callable by clients: with an arbitrary p_user they would reveal another tenant's consent state.
REVOKE ALL ON FUNCTION public.xtl_contributors(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xtl_contributes(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xtl_contributors(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.xtl_contributes(uuid, text) TO service_role;

-- =============================================================
-- C. Re-created builders (CREATE OR REPLACE keeps owner and existing GRANT/REVOKE state)
-- =============================================================

-- -------------------------------------------------------------
-- 01. refresh_benchmark_cohorts
--     Only consenting owners enter the cohort; every row not rewritten in this run is deleted so a revoked tenant cannot linger in history.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_benchmark_cohorts(p_period_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_cohort_size CONSTANT integer := 5;
  v_noise_factor CONSTANT numeric := 0.35;
  v_start date := CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90));
  v_end date := CURRENT_DATE;
  v_owner record;
  v_industry text;
  v_size_tier text;
  v_rows_written integer := 0;
  v_step_count integer;
  v_standing record;
  v_prev_bucket text;
BEGIN
  CREATE TEMP TABLE tmp_tenant_metrics (
    user_id uuid, industry text, size_tier text, metric text, value numeric, unit text, direction text
  ) ON COMMIT DROP;

  FOR v_owner IN SELECT id AS user_id FROM profiles WHERE role = 'owner'
      AND id IN (SELECT public.xtl_contributors('benchmark_cohorts'))
  LOOP
    SELECT bp.primary_industry INTO v_industry FROM business_profile bp WHERE bp.user_id = v_owner.user_id;
    v_industry := COALESCE(NULLIF(trim(v_industry), ''), 'unspecified');
    v_size_tier := public.tenant_size_tier(v_owner.user_id, v_start, v_end);

    INSERT INTO tmp_tenant_metrics (user_id, industry, size_tier, metric, value, unit, direction)
    SELECT v_owner.user_id, v_industry, v_size_tier, m.metric, m.value, m.unit, m.direction
    FROM public.compute_tenant_metrics(v_owner.user_id, v_start, v_end) m;
  END LOOP;

  -- Level 1: industry + size_tier — the "similar customers" cohort.
  INSERT INTO benchmark_cohort_stats (
    industry, size_tier, metric, unit, direction, period_start, period_end,
    contributor_count, avg_value, stddev_value, p10, p25, p50, p75, p90
  )
  SELECT
    industry, size_tier, metric, min(unit), min(direction), v_start, v_end,
    count(*), avg(value), stddev_samp(value),
    percentile_cont(0.10) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
  FROM tmp_tenant_metrics
  GROUP BY industry, size_tier, metric
  HAVING count(*) >= v_min_cohort_size
  ON CONFLICT (industry, size_tier, metric, period_start, period_end) DO UPDATE
    SET contributor_count = EXCLUDED.contributor_count, avg_value = EXCLUDED.avg_value,
        stddev_value = EXCLUDED.stddev_value, p10 = EXCLUDED.p10, p25 = EXCLUDED.p25,
        p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
        computed_at = now(), noise_applied = false;
  GET DIAGNOSTICS v_step_count = ROW_COUNT;
  v_rows_written := v_rows_written + v_step_count;

  -- Level 2: industry only, any size — fallback when a tenant's exact
  -- (industry, size_tier) pair hasn't cleared k-anonymity yet.
  INSERT INTO benchmark_cohort_stats (
    industry, size_tier, metric, unit, direction, period_start, period_end,
    contributor_count, avg_value, stddev_value, p10, p25, p50, p75, p90
  )
  SELECT
    industry, 'all', metric, min(unit), min(direction), v_start, v_end,
    count(*), avg(value), stddev_samp(value),
    percentile_cont(0.10) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
  FROM tmp_tenant_metrics
  GROUP BY industry, metric
  HAVING count(*) >= v_min_cohort_size
  ON CONFLICT (industry, size_tier, metric, period_start, period_end) DO UPDATE
    SET contributor_count = EXCLUDED.contributor_count, avg_value = EXCLUDED.avg_value,
        stddev_value = EXCLUDED.stddev_value, p10 = EXCLUDED.p10, p25 = EXCLUDED.p25,
        p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
        computed_at = now(), noise_applied = false;
  GET DIAGNOSTICS v_step_count = ROW_COUNT;
  v_rows_written := v_rows_written + v_step_count;

  -- Level 3: cross-industry, cross-size platform pool — last resort.
  INSERT INTO benchmark_cohort_stats (
    industry, size_tier, metric, unit, direction, period_start, period_end,
    contributor_count, avg_value, stddev_value, p10, p25, p50, p75, p90
  )
  SELECT
    'all', 'all', metric, min(unit), min(direction), v_start, v_end,
    count(*), avg(value), stddev_samp(value),
    percentile_cont(0.10) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
  FROM tmp_tenant_metrics
  GROUP BY metric
  HAVING count(*) >= v_min_cohort_size
  ON CONFLICT (industry, size_tier, metric, period_start, period_end) DO UPDATE
    SET contributor_count = EXCLUDED.contributor_count, avg_value = EXCLUDED.avg_value,
        stddev_value = EXCLUDED.stddev_value, p10 = EXCLUDED.p10, p25 = EXCLUDED.p25,
        p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
        computed_at = now(), noise_applied = false;
  GET DIAGNOSTICS v_step_count = ROW_COUNT;
  v_rows_written := v_rows_written + v_step_count;

  -- Calibrated jitter, 1/sqrt(n)-scaled — protective on thin cohorts
  -- near the k=5 floor, negligible on large ones. Practical,
  -- DP-inspired, NOT a formally-proven epsilon-DP guarantee.
  UPDATE benchmark_cohort_stats
  SET avg_value = avg_value + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(avg_value) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      p10 = p10 + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(p10) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      p25 = p25 + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(p25) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      p50 = p50 + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(p50) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      p75 = p75 + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(p75) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      p90 = p90 + (random() - 0.5) * 2 * (COALESCE(stddev_value, abs(p90) * 0.1 + 0.01) / sqrt(contributor_count)) * v_noise_factor,
      noise_applied = true
  WHERE period_start = v_start AND period_end = v_end;

  -- Bound table growth: rolling two-week history, same as before.
  DELETE FROM benchmark_cohort_stats WHERE computed_at < now();

  -- ---------------------------------------------------------------
  -- PASS 2: per-tenant standing + gap-discovery trigger. Fires only
  -- on a genuine crossing into bottom25 or top10, not every night.
  -- ---------------------------------------------------------------
  FOR v_standing IN
    SELECT
      t.user_id, t.metric, t.value, t.direction,
      c.p10, c.p25, c.p50, c.p75, c.p90,
      CASE
        WHEN c.p50 IS NULL THEN NULL
        WHEN t.direction = 'higher_is_better' THEN
          CASE WHEN t.value >= c.p90 THEN 'top10' WHEN t.value >= c.p75 THEN 'top25'
               WHEN t.value >= c.p50 THEN 'top50' WHEN t.value >= c.p25 THEN 'bottom50'
               ELSE 'bottom25' END
        ELSE
          CASE WHEN t.value <= c.p10 THEN 'top10' WHEN t.value <= c.p25 THEN 'top25'
               WHEN t.value <= c.p50 THEN 'top50' WHEN t.value <= c.p75 THEN 'bottom50'
               ELSE 'bottom25' END
      END AS bucket
    FROM tmp_tenant_metrics t
    LEFT JOIN LATERAL (
      SELECT b.p10, b.p25, b.p50, b.p75, b.p90
      FROM benchmark_cohort_stats b
      WHERE b.metric = t.metric AND b.period_start = v_start AND b.period_end = v_end
        AND ((b.industry = t.industry AND b.size_tier = t.size_tier)
          OR (b.industry = t.industry AND b.size_tier = 'all')
          OR (b.industry = 'all' AND b.size_tier = 'all'))
      ORDER BY
        CASE WHEN b.industry = t.industry AND b.size_tier = t.size_tier THEN 0
             WHEN b.industry = t.industry THEN 1 ELSE 2 END
      LIMIT 1
    ) c ON true
  LOOP
    IF v_standing.bucket IS NULL THEN CONTINUE; END IF;

    SELECT last_bucket INTO v_prev_bucket FROM benchmark_tenant_standing
      WHERE user_id = v_standing.user_id AND metric = v_standing.metric;

    IF v_standing.bucket = 'bottom25' AND COALESCE(v_prev_bucket, '') <> 'bottom25' THEN
      PERFORM public.append_activity_event(
        p_aggregate_type := 'benchmark_standing', p_aggregate_id := v_standing.user_id,
        p_event_type := 'benchmark.gap_detected',
        p_event_data := jsonb_build_object('metric', v_standing.metric, 'bucket', v_standing.bucket, 'value', v_standing.value),
        p_actor_type := 'ai', p_user_id := v_standing.user_id
      );
    ELSIF v_standing.bucket = 'top10' AND COALESCE(v_prev_bucket, '') <> 'top10' THEN
      PERFORM public.append_activity_event(
        p_aggregate_type := 'benchmark_standing', p_aggregate_id := v_standing.user_id,
        p_event_type := 'benchmark.standout_detected',
        p_event_data := jsonb_build_object('metric', v_standing.metric, 'bucket', v_standing.bucket, 'value', v_standing.value),
        p_actor_type := 'ai', p_user_id := v_standing.user_id
      );
    END IF;

    INSERT INTO benchmark_tenant_standing (user_id, metric, last_bucket, updated_at)
    VALUES (v_standing.user_id, v_standing.metric, v_standing.bucket, now())
    ON CONFLICT (user_id, metric) DO UPDATE SET last_bucket = EXCLUDED.last_bucket, updated_at = now();
  END LOOP;

  RETURN v_rows_written;
END;
$$;

-- -------------------------------------------------------------
-- 02. compute_platform_benchmarks
--     All six per-tenant CTEs are restricted to consenting tenants.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_platform_benchmarks(min_sample_size integer DEFAULT 5)
RETURNS TABLE (
  metric_key text,
  segment text,
  sample_size integer,
  p25 numeric,
  median numeric,
  p75 numeric,
  average numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH tenant_conversion AS (
    SELECT l.user_id,
           COUNT(DISTINCT j.id)::numeric / NULLIF(COUNT(DISTINCT l.id), 0) AS value
    FROM leads l
    LEFT JOIN jobs j ON j.lead_id = l.id
    WHERE l.created_at > now() - interval '90 days'
      AND l.user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY l.user_id
    HAVING COUNT(DISTINCT l.id) >= 3
  ),
  tenant_invoice AS (
    SELECT user_id, AVG(invoice_amount) AS value
    FROM jobs
    WHERE invoice_amount IS NOT NULL AND created_at > now() - interval '90 days'
      AND user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  ),
  tenant_call_duration AS (
    SELECT user_id, AVG(duration_seconds) AS value
    FROM calls
    WHERE duration_seconds IS NOT NULL AND call_datetime > now() - interval '90 days'
      AND user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY user_id
    HAVING COUNT(*) >= 5
  ),
  tenant_emergency_rate AS (
    SELECT user_id, COUNT(*) FILTER (WHERE is_emergency)::numeric / NULLIF(COUNT(*), 0) AS value
    FROM calls
    WHERE call_datetime > now() - interval '90 days'
      AND user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY user_id
    HAVING COUNT(*) >= 5
  ),
  tenant_completion AS (
    SELECT user_id, COUNT(*) FILTER (WHERE job_status = 'completed')::numeric / NULLIF(COUNT(*), 0) AS value
    FROM jobs
    WHERE created_at > now() - interval '90 days'
      AND user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  ),
  tenant_payment_speed AS (
    SELECT user_id, AVG(EXTRACT(EPOCH FROM (paid_at - created_at)) / 3600) AS value
    FROM payment_requests
    WHERE paid_at IS NOT NULL AND created_at > now() - interval '90 days'
      AND user_id IN (SELECT public.xtl_contributors('platform_benchmarks'))
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  )
  SELECT 'lead_conversion_rate'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_conversion HAVING COUNT(*) >= min_sample_size
  UNION ALL
  SELECT 'avg_invoice_amount'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_invoice HAVING COUNT(*) >= min_sample_size
  UNION ALL
  SELECT 'avg_call_duration_seconds'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_call_duration HAVING COUNT(*) >= min_sample_size
  UNION ALL
  SELECT 'emergency_call_rate'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_emergency_rate HAVING COUNT(*) >= min_sample_size
  UNION ALL
  SELECT 'job_completion_rate'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_completion HAVING COUNT(*) >= min_sample_size
  UNION ALL
  SELECT 'avg_payment_collection_hours'::text, 'all'::text, COUNT(*)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY value), percentile_cont(0.5) WITHIN GROUP (ORDER BY value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY value), AVG(value)
  FROM tenant_payment_speed HAVING COUNT(*) >= min_sample_size;
END;
$$;

-- -------------------------------------------------------------
-- 03. compute_regional_demand
--     Segments are built from consenting tenants only.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_regional_demand(min_sample_size integer DEFAULT 5)
RETURNS TABLE (
  industry text,
  region_key text,
  region_label text,
  sample_size integer,
  current_week_calls integer,
  prior_week_calls integer,
  call_volume_change_pct numeric,
  current_week_leads integer,
  emergency_rate_pct numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH tenant_calls AS (
    SELECT
      bp.user_id,
      lower(trim(bp.service_area)) AS region_key,
      bp.primary_industry AS industry,
      COUNT(*) FILTER (WHERE c.call_datetime >= now() - interval '7 days') AS calls_this_week,
      COUNT(*) FILTER (WHERE c.call_datetime < now() - interval '7 days'
                         AND c.call_datetime >= now() - interval '14 days') AS calls_prior_week,
      COUNT(*) FILTER (WHERE c.is_emergency AND c.call_datetime >= now() - interval '7 days') AS emergency_this_week
    FROM business_profile bp
    JOIN calls c ON c.user_id = bp.user_id AND c.call_datetime >= now() - interval '14 days'
    WHERE bp.service_area IS NOT NULL AND trim(bp.service_area) <> ''
      AND bp.user_id IN (SELECT public.xtl_contributors('regional_demand'))
      AND bp.primary_industry IS NOT NULL
    GROUP BY bp.user_id, region_key, bp.primary_industry
  ),
  tenant_leads AS (
    SELECT l.user_id, COUNT(*) AS leads_this_week
    FROM leads l
    WHERE l.created_at >= now() - interval '7 days'
    GROUP BY l.user_id
  ),
  segment AS (
    SELECT
      tc.region_key,
      tc.industry,
      COUNT(DISTINCT tc.user_id) AS sample_size,
      SUM(tc.calls_this_week) AS current_week_calls,
      SUM(tc.calls_prior_week) AS prior_week_calls,
      SUM(tc.emergency_this_week) AS current_week_emergency_calls,
      SUM(COALESCE(tl.leads_this_week, 0)) AS current_week_leads
    FROM tenant_calls tc
    LEFT JOIN tenant_leads tl ON tl.user_id = tc.user_id
    GROUP BY tc.region_key, tc.industry
  )
  SELECT
    s.industry,
    s.region_key,
    initcap(s.region_key)::text,
    s.sample_size::int,
    s.current_week_calls::int,
    s.prior_week_calls::int,
    CASE WHEN s.prior_week_calls > 0
      THEN round(((s.current_week_calls - s.prior_week_calls)::numeric / s.prior_week_calls) * 100, 1)
      ELSE NULL END,
    s.current_week_leads::int,
    CASE WHEN s.current_week_calls > 0
      THEN round((s.current_week_emergency_calls::numeric / s.current_week_calls) * 100, 1)
      ELSE NULL END
  FROM segment s
  WHERE s.sample_size >= min_sample_size;
END;
$$;

-- -------------------------------------------------------------
-- 04. ob_is_participating
--     Read side: the existing opt-out flag AND the central consent must both hold (reciprocity).
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ob_is_participating()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT s.participating FROM outcome_benchmark_settings s WHERE s.account_owner_id = public.get_account_owner_id()), true)
    AND public.xtl_contributes(public.get_account_owner_id(), 'outcome_benchmarks');
$$;

-- -------------------------------------------------------------
-- 05. refresh_outcome_benchmarks
--     Contribution side of the same flow.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_outcome_benchmarks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_k CONSTANT integer := 5;
  v_noise CONSTANT numeric := 0.35;
  v_window smallint;
  v_start date;
  v_end date := CURRENT_DATE;
  v_step integer;
  v_written integer := 0;
BEGIN
  FOREACH v_window IN ARRAY ARRAY[30, 90]::smallint[] LOOP
    v_start := v_end - v_window;

    WITH owners AS (
      SELECT p.id AS user_id,
        COALESCE(NULLIF(lower(btrim(bp.primary_industry)), ''), 'unspecified') AS industry,
        public.ob_region_key(bp.service_area) AS region
      FROM profiles p
      LEFT JOIN business_profile bp ON bp.user_id = p.id
      LEFT JOIN outcome_benchmark_settings s ON s.account_owner_id = p.id
      WHERE p.role = 'owner' AND COALESCE(s.participating, true)
        AND p.id IN (SELECT public.xtl_contributors('outcome_benchmarks'))
    ),
    tm AS (
      SELECT o.industry, o.region, m.metric, m.unit, m.direction, m.value
      FROM owners o CROSS JOIN LATERAL public.compute_outcome_metrics(o.user_id, v_start, v_end) m
    ),
    agg AS MATERIALIZED (
      SELECT
        CASE WHEN GROUPING(t.industry) = 1 THEN 'all' ELSE t.industry END AS industry,
        CASE WHEN GROUPING(t.region) = 1 THEN 'all' ELSE t.region END AS region_key,
        t.metric, min(t.unit) AS unit, min(t.direction) AS direction,
        count(*)::integer AS n, stddev_samp(t.value) AS sd,
        percentile_cont(0.10) WITHIN GROUP (ORDER BY t.value) AS p10,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY t.value) AS p25,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY t.value) AS p50,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY t.value) AS p75,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY t.value) AS p90
      FROM tm t
      GROUP BY GROUPING SETS ((t.industry, t.region, t.metric), (t.industry, t.metric), (t.metric))
      HAVING count(*) >= v_k
        AND (GROUPING(t.industry) = 1 OR t.industry <> 'unspecified')
        AND (GROUPING(t.region) = 1 OR t.region <> 'all')
    ),
    jit AS MATERIALIZED (
      SELECT a.*, (random() - 0.5) * 2 * COALESCE(a.sd, 0) / sqrt(a.n) * v_noise AS d FROM agg a
    )
    INSERT INTO outcome_benchmark_cohorts (
      industry, region_key, metric, unit, direction, window_days, contributor_count, p10, p25, p50, p75, p90, computed_at
    )
    SELECT j.industry, j.region_key, j.metric, j.unit, j.direction, v_window, j.n,
      public.ob_clamp(j.p10 + j.d, j.unit), public.ob_clamp(j.p25 + j.d, j.unit), public.ob_clamp(j.p50 + j.d, j.unit),
      public.ob_clamp(j.p75 + j.d, j.unit), public.ob_clamp(j.p90 + j.d, j.unit), now()
    FROM jit j
    ON CONFLICT (industry, region_key, metric, window_days) DO UPDATE
      SET contributor_count = EXCLUDED.contributor_count, p10 = EXCLUDED.p10, p25 = EXCLUDED.p25,
          p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90, computed_at = now();
    GET DIAGNOSTICS v_step = ROW_COUNT;
    v_written := v_written + v_step;

    -- Anything not refreshed this run no longer clears k-anonymity (or its
    -- contributors opted out): remove it so a stale thin cohort never lingers.
    DELETE FROM outcome_benchmark_cohorts WHERE window_days = v_window AND computed_at < now();
  END LOOP;
  RETURN v_written;
END;
$$;

-- -------------------------------------------------------------
-- 06. refresh_service_loop_global_priors
--     Legacy opt-out flag kept as an extra off-switch; central consent added.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_service_loop_global_priors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  DROP TABLE IF EXISTS _sil_base;
  DROP TABLE IF EXISTS _sil_totals;
  DROP TABLE IF EXISTS _sil_cells;

  CREATE TEMP TABLE _sil_base ON COMMIT DROP AS
  SELECT o.user_id, o.playbook_slug, o.job_type_key, o.root_cause_key AS cause_key,
         o.verification_status AS vstatus,
         public.sil_outcome_weight(o.verification_status, o.resolution) AS w
    FROM job_outcomes o
    LEFT JOIN service_loop_settings s ON s.user_id = o.user_id
   WHERE o.root_cause_key IS NOT NULL
     AND COALESCE(s.share_global, true)
     AND o.user_id IN (SELECT public.xtl_contributors('service_loop_priors'))
     AND o.playbook_slug ~ '^[a-z0-9-]{2,40}$'
     AND o.job_type_key ~ '^[a-z0-9-]{2,48}$'
     AND o.root_cause_key ~ '^[a-z0-9-]{2,48}$';

  CREATE TEMP TABLE _sil_totals ON COMMIT DROP AS
  SELECT playbook_slug, job_type_key,
         COUNT(DISTINCT user_id)::int AS contributors,
         ROUND(SUM(w), 1) AS effective_n,
         COUNT(*) FILTER (WHERE vstatus = 'verified')::int AS verified_n,
         COUNT(*)::int AS total_cases
    FROM _sil_base
   WHERE w > 0
   GROUP BY playbook_slug, job_type_key
  HAVING COUNT(DISTINCT user_id) >= public.sil_min_contributors() AND SUM(w) >= 20;

  CREATE TEMP TABLE _sil_cells ON COMMIT DROP AS
  SELECT b.playbook_slug, b.job_type_key, b.cause_key,
         (COUNT(DISTINCT b.user_id) FILTER (WHERE b.w > 0))::int AS contributors,
         SUM(b.w) AS eff,
         (COUNT(*) FILTER (WHERE b.vstatus = 'verified'))::int AS verified_n,
         (COUNT(*) FILTER (WHERE b.vstatus = 'refuted'))::int AS refuted_n
    FROM _sil_base b
    JOIN _sil_totals t ON t.playbook_slug = b.playbook_slug AND t.job_type_key = b.job_type_key
   GROUP BY b.playbook_slug, b.job_type_key, b.cause_key
  HAVING COUNT(DISTINCT b.user_id) FILTER (WHERE b.w > 0) >= public.sil_min_contributors();

  INSERT INTO service_loop_global_totals AS g
         (playbook_slug, job_type_key, contributors, effective_n, verified_n, total_cases, refreshed_at)
  SELECT playbook_slug, job_type_key, contributors, effective_n, verified_n, total_cases, now()
    FROM _sil_totals
  ON CONFLICT (playbook_slug, job_type_key) DO UPDATE
     SET contributors = EXCLUDED.contributors, effective_n = EXCLUDED.effective_n,
         verified_n = EXCLUDED.verified_n, total_cases = EXCLUDED.total_cases,
         refreshed_at = EXCLUDED.refreshed_at;

  INSERT INTO service_loop_global_priors AS g
         (playbook_slug, job_type_key, cause_key, contributors, effective_n, verified_n, share, fix_rate, refreshed_at)
  SELECT c.playbook_slug, c.job_type_key, c.cause_key, c.contributors, ROUND(c.eff, 1), c.verified_n,
         LEAST(1, ROUND(c.eff / NULLIF(t.effective_n, 0), 4)),
         ROUND((c.verified_n + 1)::numeric / (c.verified_n + c.refuted_n + 2), 4),
         now()
    FROM _sil_cells c
    JOIN _sil_totals t ON t.playbook_slug = c.playbook_slug AND t.job_type_key = c.job_type_key
  ON CONFLICT (playbook_slug, job_type_key, cause_key) DO UPDATE
     SET contributors = EXCLUDED.contributors, effective_n = EXCLUDED.effective_n,
         verified_n = EXCLUDED.verified_n, share = EXCLUDED.share,
         fix_rate = EXCLUDED.fix_rate, refreshed_at = EXCLUDED.refreshed_at;

  -- Anything that no longer clears k-anonymity (or whose tenants opted out) is removed.
  DELETE FROM service_loop_global_priors p
   WHERE NOT EXISTS (SELECT 1 FROM _sil_cells c
                      WHERE c.playbook_slug = p.playbook_slug
                        AND c.job_type_key = p.job_type_key
                        AND c.cause_key = p.cause_key);
  DELETE FROM service_loop_global_totals g
   WHERE NOT EXISTS (SELECT 1 FROM _sil_totals t
                      WHERE t.playbook_slug = g.playbook_slug AND t.job_type_key = g.job_type_key);

  SELECT COUNT(*) INTO v_rows FROM service_loop_global_priors;
  RETURN v_rows;
END;
$$;

-- -------------------------------------------------------------
-- 07. fie_refresh_global_patterns
--     Same pattern as above.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fie_refresh_global_patterns()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM fie_global_patterns WHERE true;

  WITH g AS (
    SELECT a.action_kind AS dimension, lower(coalesce(o.equipment_make, '')) AS make, lower(coalesce(o.equipment_model, '')) AS model,
           a.action_key, o.user_id, (a.outcome_label = 'success') AS ok
    FROM fie_actions a
    JOIN fie_observations o ON o.id = a.observation_id
    LEFT JOIN fie_settings s ON s.user_id = o.user_id
    WHERE a.action_kind IN ('diagnosis', 'part') AND a.outcome_label IN ('success', 'failure') AND a.label_confidence >= 0.7
      AND a.action_key NOT IN ('', 'untagged') AND o.equipment_make IS NOT NULL
      AND coalesce(s.contribute_to_network, true)
      AND o.user_id IN (SELECT public.xtl_contributors('fie_patterns'))
  )
  INSERT INTO fie_global_patterns (dimension, equipment_make, equipment_model, action_key, n_observations, n_accounts, n_success, success_rate, wilson_lower)
  SELECT g.dimension, g.make, g.model, g.action_key, count(*), count(DISTINCT g.user_id), count(*) FILTER (WHERE g.ok),
         round(count(*) FILTER (WHERE g.ok)::numeric / count(*), 4),
         public.fie_wilson_lower(count(*) FILTER (WHERE g.ok), count(*))
  FROM g
  GROUP BY g.dimension, g.make, g.model, g.action_key
  HAVING count(DISTINCT g.user_id) >= 3 AND count(*) >= 5
  UNION ALL
  SELECT g.dimension, g.make, '', g.action_key, count(*), count(DISTINCT g.user_id), count(*) FILTER (WHERE g.ok),
         round(count(*) FILTER (WHERE g.ok)::numeric / count(*), 4),
         public.fie_wilson_lower(count(*) FILTER (WHERE g.ok), count(*))
  FROM g
  GROUP BY g.dimension, g.make, g.action_key
  HAVING count(DISTINCT g.user_id) >= 3 AND count(*) >= 5
  ON CONFLICT (dimension, equipment_make, equipment_model, action_key) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- -------------------------------------------------------------
-- 08. refresh_failure_patterns
--     Both exposure and event facts are gated.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_failure_patterns(p_recent_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k CONSTANT integer := 5;            -- min distinct businesses per published pattern
  v_min_units CONSTANT integer := 20;   -- min exposed units per cohort
  v_max_share CONSTANT numeric := 0.60; -- no single business may supply more than this share of events
  v_recent integer := GREATEST(30, LEAST(COALESCE(p_recent_days, 90), 180));
  v_today date := CURRENT_DATE;
  v_r_start date;
  v_b_start date;
  v_started timestamptz := now();
  v_rows integer := 0;
  r_pat record;
  r_ten record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('vireek_failure_patterns_refresh')) THEN
    RETURN 0; -- another run is in progress
  END IF;

  v_r_start := v_today - v_recent;          -- recent window  = (v_r_start, today]
  v_b_start := v_today - v_recent * 4;      -- baseline window = (v_b_start, v_r_start]  (3x as long)

  DROP TABLE IF EXISTS tmp_fg_prev, tmp_fg_units, tmp_fg_ev, tmp_fg_tags;
  CREATE TEMP TABLE tmp_fg_prev (id uuid PRIMARY KEY, status text) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_units (
    equipment_id uuid, user_id uuid, model_key text, age_f text, clim_f text) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_ev (
    user_id uuid, model_key text, age_f text, clim_f text, failure_component text,
    symptoms text[], parts text[], repair_action text, outcome text, repair_cost numeric,
    is_recent boolean) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_fg_tags (
    model_key text, age_f text, clim_f text, failure_component text, kind text, tag text, n integer) ON COMMIT DROP;

  INSERT INTO tmp_fg_prev SELECT id, status FROM failure_patterns;

  -- Exposure: every contributing unit, exploded into its 4 cohort facets
  -- (any/any, age/any, any/climate, age/climate).
  INSERT INTO tmp_fg_units (equipment_id, user_id, model_key, age_f, clim_f)
  SELECT g.equipment_id, g.user_id, g.model_key, f.age_f, f.clim_f
  FROM failure_genomes g
  CROSS JOIN LATERAL (VALUES
    ('any', 'any'), (g.age_band, 'any'), ('any', g.climate_band), (g.age_band, g.climate_band)
  ) AS f(age_f, clim_f)
  WHERE split_part(g.model_key, '/', 1) <> 'unknown'
    AND split_part(g.model_key, '/', 2) <> 'unknown'
    AND f.age_f <> 'unknown' AND f.clim_f <> 'unknown'
    AND NOT EXISTS (SELECT 1 FROM business_profile bp
                    WHERE bp.user_id = g.user_id AND bp.failure_genome_contribute = false)
    AND g.user_id IN (SELECT public.xtl_contributors('failure_genome'));

  INSERT INTO tmp_fg_ev (user_id, model_key, age_f, clim_f, failure_component, symptoms, parts,
                         repair_action, outcome, repair_cost, is_recent)
  SELECT ev.user_id, g.model_key, f.age_f, f.clim_f, ev.failure_component, ev.symptoms,
         ev.parts_replaced, ev.repair_action, ev.outcome, ev.repair_cost, (ev.occurred_on > v_r_start)
  FROM equipment_failure_events ev
  JOIN failure_genomes g ON g.equipment_id = ev.equipment_id
  CROSS JOIN LATERAL (VALUES
    ('any', 'any'), (g.age_band, 'any'), ('any', g.climate_band), (g.age_band, g.climate_band)
  ) AS f(age_f, clim_f)
  WHERE ev.occurred_on > v_b_start AND ev.occurred_on <= v_today
    AND split_part(g.model_key, '/', 1) <> 'unknown'
    AND split_part(g.model_key, '/', 2) <> 'unknown'
    AND f.age_f <> 'unknown' AND f.clim_f <> 'unknown'
    AND NOT EXISTS (SELECT 1 FROM business_profile bp
                    WHERE bp.user_id = g.user_id AND bp.failure_genome_contribute = false)
    AND g.user_id IN (SELECT public.xtl_contributors('failure_genome'));

  INSERT INTO failure_patterns (
    model_key, make_key, type_key, failure_component, age_band, climate_band,
    units_exposed, contributor_count, recent_events, baseline_events, recent_rate, baseline_rate,
    lift, z_score, status, recurrence_rate, replacement_rate, fix_rate, avg_repair_cost,
    window_days, first_detected_at, status_changed_at, computed_at)
  WITH pt AS (
    SELECT model_key, age_f, clim_f, failure_component, user_id,
           count(*) FILTER (WHERE is_recent) AS rec,
           count(*) FILTER (WHERE NOT is_recent) AS base,
           count(*) FILTER (WHERE outcome IN ('recurred', 'callback')) AS recur,
           count(*) FILTER (WHERE outcome = 'replaced_unit') AS repl,
           count(*) FILTER (WHERE outcome = 'fixed') AS fixd,
           sum(repair_cost) AS cost_sum,
           count(repair_cost) AS cost_n
    FROM tmp_fg_ev
    GROUP BY model_key, age_f, clim_f, failure_component, user_id
  ), ag AS (
    SELECT model_key, age_f, clim_f, failure_component,
           sum(rec)::integer AS rec, sum(base)::integer AS base, count(*)::integer AS tenants,
           max(rec + base)::numeric / NULLIF(sum(rec + base), 0) AS top_share,
           sum(recur)::numeric AS recur, sum(repl)::numeric AS repl, sum(fixd)::numeric AS fixd,
           sum(cost_sum) AS cost_sum, sum(cost_n) AS cost_n
    FROM pt GROUP BY model_key, age_f, clim_f, failure_component
  ), tot AS (
    SELECT model_key, age_f, clim_f,
           count(*) FILTER (WHERE is_recent)::numeric AS rec_tot,
           count(*) FILTER (WHERE NOT is_recent)::numeric AS base_tot
    FROM tmp_fg_ev GROUP BY model_key, age_f, clim_f
  ), un AS (
    SELECT model_key, age_f, clim_f, count(*)::integer AS units
    FROM tmp_fg_units GROUP BY model_key, age_f, clim_f
  ), calc AS (
    SELECT ag.*, un.units, tot.rec_tot, tot.base_tot, ag.base / 3.0 AS expected
    FROM ag
    JOIN un USING (model_key, age_f, clim_f)
    JOIN tot USING (model_key, age_f, clim_f)
    WHERE ag.tenants >= v_k
      AND ag.top_share <= v_max_share
      AND un.units >= v_min_units
      AND (ag.rec + ag.base) >= 8
  ), scored AS (
    SELECT c.*,
           LEAST(99, round(c.rec / GREATEST(c.expected, 0.5), 2)) AS lift,
           round((c.rec - c.expected) / sqrt(c.expected + 1), 2) AS z,
           CASE WHEN c.base > 0 AND c.base_tot > 0 AND c.rec_tot > 0
                THEN (c.rec / c.rec_tot) / (c.base / c.base_tot) END AS share_lift
    FROM calc c
  ), classified AS (
    SELECT s.*,
           CASE
             WHEN s.rec >= 6 AND s.lift >= 1.5 AND s.z >= 3 AND COALESCE(s.share_lift, 2) >= 1.2 THEN 'emerging'
             WHEN s.rec >= 4 AND s.lift >= 1.25 AND s.z >= 2 THEN 'elevated'
             WHEN s.lift <= 0.67 AND s.z <= -2 THEN 'declining'
             ELSE 'stable'
           END AS status
    FROM scored s
  )
  SELECT s.model_key, split_part(s.model_key, '/', 1), split_part(s.model_key, '/', 3),
         s.failure_component, s.age_f, s.clim_f,
         s.units, s.tenants, s.rec, s.base,
         round(s.rec * 100.0 / s.units, 2), round(s.expected * 100.0 / s.units, 2),
         s.lift, s.z, s.status,
         round(s.recur / NULLIF(s.rec + s.base, 0), 3),
         round(s.repl / NULLIF(s.rec + s.base, 0), 3),
         round(s.fixd / NULLIF(s.rec + s.base, 0), 3),
         round(s.cost_sum / NULLIF(s.cost_n, 0), 2),
         v_recent,
         CASE WHEN s.status = 'emerging' THEN v_started END,
         v_started, v_started
  FROM classified s
  ON CONFLICT (model_key, failure_component, age_band, climate_band) DO UPDATE SET
    make_key = EXCLUDED.make_key, type_key = EXCLUDED.type_key,
    units_exposed = EXCLUDED.units_exposed, contributor_count = EXCLUDED.contributor_count,
    recent_events = EXCLUDED.recent_events, baseline_events = EXCLUDED.baseline_events,
    recent_rate = EXCLUDED.recent_rate, baseline_rate = EXCLUDED.baseline_rate,
    lift = EXCLUDED.lift, z_score = EXCLUDED.z_score,
    recurrence_rate = EXCLUDED.recurrence_rate, replacement_rate = EXCLUDED.replacement_rate,
    fix_rate = EXCLUDED.fix_rate, avg_repair_cost = EXCLUDED.avg_repair_cost,
    window_days = EXCLUDED.window_days,
    status_changed_at = CASE WHEN failure_patterns.status IS DISTINCT FROM EXCLUDED.status
                             THEN v_started ELSE failure_patterns.status_changed_at END,
    first_detected_at = COALESCE(failure_patterns.first_detected_at, EXCLUDED.first_detected_at),
    status = EXCLUDED.status,
    computed_at = v_started;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Evidence tags: published only when >= k distinct businesses reported the tag.
  INSERT INTO tmp_fg_tags (model_key, age_f, clim_f, failure_component, kind, tag, n)
  SELECT x.model_key, x.age_f, x.clim_f, x.failure_component, x.kind, x.tag, count(*)::integer
  FROM (
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'symptom' AS kind, unnest(symptoms) AS tag FROM tmp_fg_ev
    UNION ALL
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'part', unnest(parts) FROM tmp_fg_ev
    UNION ALL
    SELECT model_key, age_f, clim_f, failure_component, user_id, 'repair', repair_action FROM tmp_fg_ev
    WHERE repair_action IS NOT NULL
  ) x
  GROUP BY x.model_key, x.age_f, x.clim_f, x.failure_component, x.kind, x.tag
  HAVING count(DISTINCT x.user_id) >= v_k;

  UPDATE failure_patterns fp SET
    top_symptoms = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'symptom'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb),
    top_parts = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'part'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb),
    top_repairs = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('tag', q.tag,
               'share', round(q.n::numeric / NULLIF(fp.recent_events + fp.baseline_events, 0), 3))
             ORDER BY q.n DESC, q.tag)
      FROM (SELECT g.tag, g.n FROM tmp_fg_tags g
            WHERE g.model_key = fp.model_key AND g.age_f = fp.age_band AND g.clim_f = fp.climate_band
              AND g.failure_component = fp.failure_component AND g.kind = 'repair'
            ORDER BY g.n DESC, g.tag LIMIT 5) q), '[]'::jsonb)
  WHERE fp.computed_at = v_started;

  -- Anything not re-published this run no longer clears the privacy gates (or the tenant opted out).
  DELETE FROM failure_patterns WHERE computed_at < v_started;

  -- Alert every exposed business exactly once, when a pattern NEWLY becomes emerging.
  FOR r_pat IN
    SELECT fp.id, fp.model_key, fp.failure_component, fp.age_band, fp.climate_band, fp.lift, fp.recent_events
    FROM failure_patterns fp
    LEFT JOIN tmp_fg_prev pv ON pv.id = fp.id
    WHERE fp.status = 'emerging' AND (pv.id IS NULL OR pv.status <> 'emerging')
  LOOP
    FOR r_ten IN
      SELECT u.user_id, count(DISTINCT u.equipment_id)::integer AS units
      FROM tmp_fg_units u
      WHERE u.model_key = r_pat.model_key AND u.age_f = r_pat.age_band AND u.clim_f = r_pat.climate_band
      GROUP BY u.user_id
    LOOP
      BEGIN
        PERFORM public.append_activity_event(
          'failure_pattern', r_pat.id, 'failure_genome.pattern_emerging',
          jsonb_build_object('model_key', r_pat.model_key, 'failure_component', r_pat.failure_component,
                             'age_band', r_pat.age_band, 'climate_band', r_pat.climate_band,
                             'lift', r_pat.lift, 'recent_events', r_pat.recent_events,
                             'your_units', r_ten.units),
          'system', NULL, NULL, '{}'::jsonb, r_ten.user_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'failure_genome notify failed: %', SQLERRM;
      END;
    END LOOP;
  END LOOP;

  RETURN v_rows;
END;
$$;

-- -------------------------------------------------------------
-- 09. mine_vertical_intelligence
--     Objection, intent and upsell extraction are all gated.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mine_vertical_intelligence(p_period_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_tenant_count CONSTANT integer := 5;
  v_start date := CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90));
  v_end date := CURRENT_DATE;
  v_rows_written integer := 0;
BEGIN
  CREATE TEMP TABLE tmp_call_signals (
    user_id uuid,
    industry text,
    signal_type text,
    signal_key text,
    call_score smallint,
    resolved boolean,
    booked boolean
  ) ON COMMIT DROP;

  -- Objections raised, one row per objection per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'objection',
    left(regexp_replace(lower(trim(obj)), '\s+', ' ', 'g'), 200),
    c.call_score,
    c.objections_resolved,
    NULL
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  CROSS JOIN LATERAL unnest(c.objections_raised) AS obj
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND c.user_id IN (SELECT public.xtl_contributors('vertical_intelligence'))
    AND trim(obj) <> '';

  -- Intents, one row per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'intent',
    left(regexp_replace(lower(trim(c.intent)), '\s+', ' ', 'g'), 200),
    c.call_score,
    NULL,
    c.booking_outcome = 'booked'
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND c.user_id IN (SELECT public.xtl_contributors('vertical_intelligence'))
    AND c.intent IS NOT NULL
    AND trim(c.intent) <> ''
    AND lower(trim(c.intent)) <> 'unknown';

  -- Upsell opportunities the AI detected, one row per opportunity per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'upsell_opportunity',
    left(regexp_replace(lower(trim(u)), '\s+', ' ', 'g'), 200),
    c.call_score,
    NULL,
    NULL
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  CROSS JOIN LATERAL unnest(c.upsell_opportunities) AS u
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND c.user_id IN (SELECT public.xtl_contributors('vertical_intelligence'))
    AND trim(u) <> '';

  -- Aggregate, gated by k-anonymity, upsert into the exposed table.
  INSERT INTO vertical_intelligence_signals (
    industry, signal_type, signal_key, period_start, period_end,
    tenant_count, occurrence_count, resolution_rate, booking_rate, avg_call_score
  )
  SELECT
    industry,
    signal_type,
    signal_key,
    v_start,
    v_end,
    count(DISTINCT user_id),
    count(*),
    CASE WHEN signal_type = 'objection'
      THEN round(100.0 * count(*) FILTER (WHERE resolved) / NULLIF(count(*) FILTER (WHERE resolved IS NOT NULL), 0), 2)
    END,
    CASE WHEN signal_type = 'intent'
      THEN round(100.0 * count(*) FILTER (WHERE booked) / NULLIF(count(*), 0), 2)
    END,
    round(avg(call_score) FILTER (WHERE call_score IS NOT NULL), 2)
  FROM tmp_call_signals
  GROUP BY industry, signal_type, signal_key
  HAVING count(DISTINCT user_id) >= v_min_tenant_count
  ON CONFLICT (industry, signal_type, signal_key, period_start, period_end) DO UPDATE
    SET tenant_count = EXCLUDED.tenant_count,
        occurrence_count = EXCLUDED.occurrence_count,
        resolution_rate = EXCLUDED.resolution_rate,
        booking_rate = EXCLUDED.booking_rate,
        avg_call_score = EXCLUDED.avg_call_score,
        computed_at = now();

  GET DIAGNOSTICS v_rows_written = ROW_COUNT;

  -- Bound table growth: keep a rolling 90-day history of period snapshots.
  DELETE FROM vertical_intelligence_signals WHERE period_end < CURRENT_DATE - interval '90 days';

  RETURN v_rows_written;
END;
$$;

-- -------------------------------------------------------------
-- 10. compute_causal_cohort_insights
--     Only consenting accounts feed the causal cohort.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_causal_cohort_insights(
  p_category text,
  p_min_sample integer DEFAULT 5
)
RETURNS TABLE (
  sample_size integer,
  success_rate numeric,
  avg_impact_pct numeric,
  median_impact_pct numeric,
  p25_impact_pct numeric,
  p75_impact_pct numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH measured AS (
    SELECT t.user_id, t.actual_impact_pct
    FROM causal_outcome_tracking t
    JOIN causal_scenarios s ON s.id = t.scenario_id
    WHERE s.decision_category = p_category
      AND t.decision_made = true
      AND t.outcome_recorded_at IS NOT NULL
      AND t.actual_impact_pct IS NOT NULL
      AND t.user_id IN (SELECT public.xtl_contributors('causal_cohorts'))
  )
  SELECT
    COUNT(DISTINCT user_id)::integer,
    ROUND((COUNT(*) FILTER (WHERE actual_impact_pct > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 2),
    ROUND(AVG(actual_impact_pct), 2),
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_impact_pct), 2),
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY actual_impact_pct), 2),
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY actual_impact_pct), 2)
  FROM measured
  HAVING COUNT(DISTINCT user_id) >= p_min_sample;
END;
$$;

-- -------------------------------------------------------------
-- 11. rebate_network_realization
--     Network realization counts consenting accounts only.
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebate_network_realization(p_program_ids uuid[])
RETURNS TABLE (program_id uuid, decided integer, successes integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.program_id,
         count(*)::integer AS decided,
         (count(*) FILTER (WHERE a.status IN ('approved', 'paid')))::integer AS successes
  FROM rebate_applications a
  JOIN incentive_programs p ON p.id = a.program_id AND p.owner_user_id IS NULL
  WHERE a.program_id = ANY (p_program_ids)
    AND a.status IN ('approved', 'paid', 'denied')
    AND a.user_id IN (SELECT public.xtl_contributors('rebate_realization'))
  GROUP BY a.program_id
  HAVING count(*) >= 5 AND count(DISTINCT a.user_id) >= 3;
$$;

-- -------------------------------------------------------------
-- 12. get_voice_pooled_prior
--     Revocation fix: a contribution counts only while its contributor STILL has pooled_priors_opt_in = true (previously only the caller was checked).
--     Body = latest deployed definition + ONLY the change described above. Nothing else changed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_voice_pooled_prior(p_scenario text, p_metric text)
RETURNS TABLE (successes bigint, trials bigint, accounts bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (SELECT public.get_account_owner_id() AS uid),
  opted AS (SELECT 1 FROM public.voice_autopilot_settings s, me WHERE s.user_id = me.uid AND s.pooled_priors_opt_in),
  agg AS (
    SELECT coalesce(sum(c.successes),0)::bigint AS s, coalesce(sum(c.trials),0)::bigint AS t, count(DISTINCT c.user_id)::bigint AS a
    FROM public.voice_prior_contributions c
    JOIN public.voice_autopilot_settings cs ON cs.user_id = c.user_id AND cs.pooled_priors_opt_in
    CROSS JOIN me
    WHERE c.scenario = p_scenario AND c.metric = p_metric AND c.user_id <> me.uid
  )
  SELECT agg.s, agg.t, agg.a FROM agg WHERE EXISTS (SELECT 1 FROM opted) AND agg.a >= 10;
$$;
