/*
  Vireek Outcome Benchmark Network

  Outcome-based, anonymized peer benchmarking: first-time-fix rate, reservice
  rate and median response time, compared against businesses in the same
  trade AND the same US state (falls back to trade-wide, then platform-wide).

  Privacy design (same principles as 20260923000000_cross_tenant_benchmarking.sql):
  - k-anonymity: a cohort row only exists when >= 5 distinct businesses
    contributed (CHECK constraint + HAVING). Stale rows are deleted every run.
  - Aggregated twice: one number per business first, percentiles of those after.
  - No min/max stored. One shared jitter per row (keeps p10<=...<=p90 order).
    Practical, DP-inspired noise - NOT a formal epsilon-DP guarantee.
  - Reciprocity + control: businesses can opt out; opted-out businesses neither
    contribute nor see comparisons (effective from the next nightly refresh).
  - Cohort table never exposes tenant rows; only managers can read comparisons.

  Purely additive: no existing table, function or policy is modified.
  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 1) Helpers -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ob_is_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

-- Best-effort US state from free-text service_area ("Austin, TX", "Texas").
-- Returns a lowercase 2-letter code, or 'all' when it cannot be determined.
CREATE OR REPLACE FUNCTION public.ob_region_key(p_service_area text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_text text := lower(btrim(coalesce(p_service_area, '')));
  v_codes constant text[] := ARRAY['al','ak','az','ar','ca','co','ct','de','dc','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','wv','va','wa','wi','wy'];
  v_names constant text[] := ARRAY['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','district of columbia','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','west virginia','virginia','washington','wisconsin','wyoming'];
  v_tok text;
  v_i integer;
BEGIN
  IF v_text = '' THEN RETURN 'all'; END IF;
  -- Trailing 2-letter code first ("Kansas City, MO" must resolve to MO, not Kansas).
  v_tok := substring(v_text from '(?:^|[,\s])([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$');
  IF v_tok IS NOT NULL AND v_tok = ANY (v_codes) THEN RETURN v_tok; END IF;
  FOR v_i IN 1..array_length(v_names, 1) LOOP
    IF v_text ~ ('(^|[^a-z])' || v_names[v_i] || '([^a-z]|$)') THEN RETURN v_codes[v_i]; END IF;
  END LOOP;
  RETURN 'all';
END;
$$;

CREATE OR REPLACE FUNCTION public.ob_clamp(p_value numeric, p_unit text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_unit = 'percent' THEN least(100, greatest(0, p_value)) ELSE greatest(0, p_value) END;
$$;

-- 2) Settings (participation) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_benchmark_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  participating boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE outcome_benchmark_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "outcome_benchmark_settings_read" ON outcome_benchmark_settings;
CREATE POLICY "outcome_benchmark_settings_read" ON outcome_benchmark_settings
  FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
-- No client writes: use set_outcome_benchmark_participation().

CREATE OR REPLACE FUNCTION public.ob_is_participating()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT s.participating FROM outcome_benchmark_settings s WHERE s.account_owner_id = public.get_account_owner_id()), true);
$$;

CREATE OR REPLACE FUNCTION public.set_outcome_benchmark_participation(p_participating boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.ob_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO outcome_benchmark_settings (account_owner_id, participating, updated_at)
  VALUES (v_owner, p_participating, now())
  ON CONFLICT (account_owner_id) DO UPDATE SET participating = EXCLUDED.participating, updated_at = now();
  RETURN p_participating;
END;
$$;

-- 3) Anonymized cohort table ----------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_benchmark_cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry text NOT NULL,
  region_key text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('first_time_fix_rate', 'reservice_rate', 'median_response_minutes')),
  unit text NOT NULL CHECK (unit IN ('percent', 'minutes')),
  direction text NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better')),
  window_days smallint NOT NULL CHECK (window_days IN (30, 90)),
  contributor_count integer NOT NULL CHECK (contributor_count >= 5),
  p10 numeric NOT NULL, p25 numeric NOT NULL, p50 numeric NOT NULL, p75 numeric NOT NULL, p90 numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (industry, region_key, metric, window_days)
);
ALTER TABLE outcome_benchmark_cohorts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "outcome_benchmark_cohorts_read" ON outcome_benchmark_cohorts;
CREATE POLICY "outcome_benchmark_cohorts_read" ON outcome_benchmark_cohorts
  FOR SELECT TO authenticated USING (public.ob_is_manager() AND public.ob_is_participating());

-- AI advice cache (written/read only through the SECURITY DEFINER functions below)
CREATE TABLE IF NOT EXISTS outcome_benchmark_advice (
  account_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_days smallint NOT NULL CHECK (window_days IN (30, 90)),
  input_hash text NOT NULL,
  advice jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_owner_id, window_days)
);
ALTER TABLE outcome_benchmark_advice ENABLE ROW LEVEL SECURITY;

-- 4) Per-business outcome metrics (one number per metric) -------------------------
-- FTF: completed, non-rework jobs completed in [p_start, p_end - 14d] (14-day
-- maturity) with no rework job created within 14 days of completion.
-- Reservice: rework jobs / all jobs created in the window.
-- Response: median minutes from job creation to first_response_at.
-- A metric is absent (never a fabricated 0) when the business has < 5 samples.
CREATE OR REPLACE FUNCTION public.compute_outcome_metrics(p_user_id uuid, p_start date, p_end date)
RETURNS TABLE (metric text, value numeric, unit text, direction text, sample_size integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH done AS (
    SELECT j.id, coalesce(j.completed_at, j.scheduled_datetime, j.created_at) AS done_at
    FROM jobs j
    WHERE j.user_id = p_user_id AND j.job_status = 'completed' AND NOT j.is_rework
  ),
  mature AS (
    SELECT d.id,
      EXISTS (
        SELECT 1 FROM jobs r
        WHERE r.user_id = p_user_id AND r.rework_of_job_id = d.id
          AND r.created_at <= d.done_at + interval '14 days'
      ) AS reworked
    FROM done d
    WHERE d.done_at::date BETWEEN p_start AND p_end - 14
  ),
  ftf AS (SELECT count(*) AS n, count(*) FILTER (WHERE NOT reworked) AS fixed FROM mature),
  vol AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE j.is_rework) AS rw
    FROM jobs j WHERE j.user_id = p_user_id AND j.created_at::date BETWEEN p_start AND p_end
  ),
  resp AS (
    SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.mins) AS med
    FROM (
      SELECT extract(epoch FROM (j.first_response_at - j.created_at)) / 60.0 AS mins
      FROM jobs j
      WHERE j.user_id = p_user_id AND j.first_response_at IS NOT NULL
        AND j.created_at::date BETWEEN p_start AND p_end
        AND j.first_response_at >= j.created_at
        AND j.first_response_at <= j.created_at + interval '30 days'
    ) x
  )
  SELECT 'first_time_fix_rate', round(100.0 * fixed / n, 1), 'percent', 'higher_is_better', n::integer FROM ftf WHERE n >= 5
  UNION ALL
  SELECT 'reservice_rate', round(100.0 * rw / n, 1), 'percent', 'lower_is_better', n::integer FROM vol WHERE n >= 5
  UNION ALL
  SELECT 'median_response_minutes', round(med::numeric, 1), 'minutes', 'lower_is_better', n::integer FROM resp WHERE n >= 5;
$$;

-- 5) Nightly refresh: the only path that reads every tenant --------------------
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

-- 6) Comparison RPC (manager + participating only) ---------------------------------
CREATE OR REPLACE FUNCTION public.get_outcome_benchmark(p_window_days integer DEFAULT 30)
RETURNS TABLE (
  metric text, unit text, direction text, my_value numeric, my_sample integer,
  scope text, industry text, region_key text, contributor_count integer,
  p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric, percentile_bucket text
)
LANGUAGE plpgsql SECURITY INVOKER STABLE SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_window smallint := CASE WHEN p_window_days >= 90 THEN 90 ELSE 30 END;
  v_industry text;
  v_region text;
BEGIN
  IF v_owner IS NULL OR NOT public.ob_is_manager() OR NOT public.ob_is_participating() THEN
    RETURN;
  END IF;

  SELECT COALESCE(NULLIF(lower(btrim(bp.primary_industry)), ''), 'unspecified'), public.ob_region_key(bp.service_area)
  INTO v_industry, v_region
  FROM business_profile bp WHERE bp.user_id = v_owner;
  v_industry := COALESCE(v_industry, 'unspecified');
  v_region := COALESCE(v_region, 'all');

  RETURN QUERY
  WITH mine AS (
    SELECT * FROM public.compute_outcome_metrics(v_owner, CURRENT_DATE - v_window, CURRENT_DATE)
  ),
  cohort AS (
    SELECT DISTINCT ON (c.metric) c.metric, c.industry, c.region_key, c.contributor_count, c.p10, c.p25, c.p50, c.p75, c.p90
    FROM outcome_benchmark_cohorts c
    WHERE c.window_days = v_window
      AND ((c.industry = v_industry AND c.region_key = v_region)
        OR (c.industry = v_industry AND c.region_key = 'all')
        OR (c.industry = 'all' AND c.region_key = 'all'))
    ORDER BY c.metric,
      CASE WHEN c.industry <> 'all' AND c.region_key <> 'all' THEN 0 WHEN c.industry <> 'all' THEN 1 ELSE 2 END
  )
  SELECT
    m.metric, m.unit, m.direction, m.value, m.sample_size,
    CASE WHEN c.metric IS NULL THEN 'none'
         WHEN c.industry <> 'all' AND c.region_key <> 'all' THEN 'region'
         WHEN c.industry <> 'all' THEN 'industry'
         ELSE 'platform' END,
    COALESCE(c.industry, v_industry), COALESCE(c.region_key, v_region),
    c.contributor_count, c.p10, c.p25, c.p50, c.p75, c.p90,
    CASE
      WHEN c.metric IS NULL THEN NULL
      WHEN m.direction = 'higher_is_better' THEN
        CASE WHEN m.value >= c.p90 THEN 'top10' WHEN m.value >= c.p75 THEN 'top25'
             WHEN m.value >= c.p50 THEN 'top50' WHEN m.value >= c.p25 THEN 'bottom50' ELSE 'bottom25' END
      ELSE
        CASE WHEN m.value <= c.p10 THEN 'top10' WHEN m.value <= c.p25 THEN 'top25'
             WHEN m.value <= c.p50 THEN 'top50' WHEN m.value <= c.p75 THEN 'bottom50' ELSE 'bottom25' END
    END
  FROM mine m LEFT JOIN cohort c ON c.metric = m.metric;
END;
$$;

-- 7) Own-data drivers: which service types drag first-time-fix down ------------------
CREATE OR REPLACE FUNCTION public.get_outcome_drivers(p_window_days integer DEFAULT 30)
RETURNS TABLE (service_type text, job_count integer, reworked_count integer, ftf_rate numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH base AS (
    SELECT lower(btrim(j.service_type)) AS st,
      EXISTS (
        SELECT 1 FROM jobs r
        WHERE r.user_id = j.user_id AND r.rework_of_job_id = j.id
          AND r.created_at <= coalesce(j.completed_at, j.scheduled_datetime, j.created_at) + interval '14 days'
      ) AS rw
    FROM jobs j
    WHERE j.user_id = public.get_account_owner_id() AND public.ob_is_manager()
      AND j.job_status = 'completed' AND NOT j.is_rework
      AND j.service_type IS NOT NULL AND btrim(j.service_type) <> ''
      AND coalesce(j.completed_at, j.scheduled_datetime, j.created_at)::date
          BETWEEN CURRENT_DATE - (CASE WHEN p_window_days >= 90 THEN 90 ELSE 30 END) AND CURRENT_DATE - 14
  )
  SELECT initcap(b.st), count(*)::integer, (count(*) FILTER (WHERE b.rw))::integer,
         round(100.0 * (count(*) FILTER (WHERE NOT b.rw)) / count(*), 1)
  FROM base b GROUP BY b.st HAVING count(*) >= 3
  ORDER BY 4 ASC, 2 DESC LIMIT 5;
$$;

-- 8) AI advice cache access (edge function runs with the caller's JWT only) -------
CREATE OR REPLACE FUNCTION public.get_outcome_advice(p_window_days integer)
RETURNS TABLE (input_hash text, advice jsonb, generated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.input_hash, a.advice, a.generated_at
  FROM outcome_benchmark_advice a
  WHERE public.ob_is_manager() AND a.account_owner_id = public.get_account_owner_id()
    AND a.window_days = (CASE WHEN p_window_days >= 90 THEN 90 ELSE 30 END);
$$;

CREATE OR REPLACE FUNCTION public.save_outcome_advice(p_window_days integer, p_input_hash text, p_advice jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.ob_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO outcome_benchmark_advice (account_owner_id, window_days, input_hash, advice, generated_at)
  VALUES (v_owner, CASE WHEN p_window_days >= 90 THEN 90 ELSE 30 END, p_input_hash, p_advice, now())
  ON CONFLICT (account_owner_id, window_days)
  DO UPDATE SET input_hash = EXCLUDED.input_hash, advice = EXCLUDED.advice, generated_at = now();
END;
$$;

-- 9) Grants ----------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.refresh_outcome_benchmarks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_outcome_benchmarks() TO service_role;
REVOKE ALL ON FUNCTION public.set_outcome_benchmark_participation(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_outcome_advice(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_outcome_advice(integer, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_outcome_benchmark(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_outcome_drivers(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compute_outcome_metrics(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ob_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ob_is_participating() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_outcome_benchmark_participation(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_outcome_advice(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_outcome_advice(integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_outcome_benchmark(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_outcome_drivers(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_outcome_metrics(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ob_is_manager() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ob_is_participating() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ob_region_key(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ob_clamp(numeric, text) TO authenticated, service_role;

-- 10) Nightly schedule (no-op, not an error, if pg_cron is unavailable) ------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-refresh-outcome-benchmarks');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-refresh-outcome-benchmarks', '45 3 * * *', 'select public.refresh_outcome_benchmarks()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
