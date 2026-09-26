/*
  # Deep Cross-Customer Privacy-Preserving Benchmarking

  ## Why
  20260923000000_cross_tenant_benchmarking.sql already built a real
  k-anonymity system (contributor_count >= 5, aggregated-twice, no
  client-parameterized cross-tenant queries). Two things were still
  missing for genuinely deep, actionable "compare me to SIMILAR
  businesses" benchmarking:

  1. Peer groups were industry-only. A 3-person handyman outfit and a
     40-truck regional HVAC company doing the same trade are not
     comparable, even though they share an industry slug.
  2. Nothing ever DISCOVERS a gap and surfaces it — the whole system
     was pull-only (a business had to visit BenchmarksPage). There was
     also no scheduling anywhere in the codebase for
     refresh_benchmark_cohorts() — grep the repo: nothing calls it, so
     benchmark_cohort_stats has likely never been populated outside a
     manual SQL Editor run. This migration schedules it.

  Also fixes a real bug found while reading the original migration:
  `GET DIAGNOSTICS v_rows_written = v_rows_written + ROW_COUNT` is not
  valid PL/pgSQL (the right-hand side of GET DIAGNOSTICS must be a
  fixed diagnostics item, not an expression) — this would have thrown
  the moment refresh_benchmark_cohorts() actually ran, which is
  probably exactly why it was never caught.

  ## What this adds
  1. `benchmark_cohort_stats.size_tier` — a job-volume tier
     ('small'/'mid'/'large', tune the thresholds in
     tenant_size_tier() freely) alongside industry. Unique key becomes
     (industry, size_tier, metric, period_start, period_end).
  2. `tenant_size_tier()` — one shared helper so refresh and the live
     comparison RPC can never drift on the tiering logic.
  3. Calibrated jitter on avg_value/percentiles, scaled by
     stddev/sqrt(n) — meaningfully protective on thin cohorts near the
     k=5 floor, negligible on large ones. This is a practical,
     DP-INSPIRED mechanism, not a formally-proven epsilon-DP guarantee
     — said plainly so nobody downstream oversells it as certified
     differential privacy.
  4. `benchmark_tenant_standing` — one row per (tenant, metric): the
     tenant's own last-known bucket. Lets the refresh loop detect a
     genuine CROSSING (entering bottom25, entering top10) instead of
     firing every single night.
  5. refresh_benchmark_cohorts() rewritten: three cohort levels per
     metric (industry+size, industry+'all', 'all'+'all'), the
     GET DIAGNOSTICS bug fixed, noise applied, and a second pass that
     fires append_activity_event('benchmark.gap_detected' /
     'benchmark.standout_detected') on a genuine bucket crossing —
     same mechanism service-recovery-agent and the epistemic boundary
     trigger already use, so an existing workflow playbook can react
     to it with zero new notification code.
  6. get_benchmark_comparison() cohort selection now prefers
     industry+size over industry-only over the platform pool — same
     output columns/types as before (scope stays 'industry' | 'all' |
     'none'), so BenchmarksPage.tsx and src/lib/benchmarking.ts need
     no changes at all.
  7. Nightly pg_cron schedule for refresh_benchmark_cohorts(), guarded
     exactly like 20261110000000_truck_stock_replenishment.sql's
     pg_cron block — a no-op, not an error, if pg_cron isn't enabled
     on this project.

  RLS: benchmark_tenant_standing is scoped to the owning tenant only
  (get_account_owner_id()), same convention as everywhere else.
  benchmark_cohort_stats' existing "open to every authenticated user"
  policy is unchanged and still correct — a row only exists there once
  k-anonymity clears, size_tier or not.
*/

-- =============================================================
-- 1. benchmark_cohort_stats — add size_tier + noise flag
-- =============================================================

ALTER TABLE benchmark_cohort_stats ADD COLUMN IF NOT EXISTS size_tier text NOT NULL DEFAULT 'all';
ALTER TABLE benchmark_cohort_stats ADD COLUMN IF NOT EXISTS noise_applied boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'benchmark_cohort_stats'::regclass AND contype = 'u' AND array_length(conkey, 1) = 4;
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE benchmark_cohort_stats DROP CONSTRAINT %I', v_conname);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'benchmark_cohort_stats_unique_key') THEN
    ALTER TABLE benchmark_cohort_stats ADD CONSTRAINT benchmark_cohort_stats_unique_key
      UNIQUE (industry, size_tier, metric, period_start, period_end);
  END IF;
END $$;

-- =============================================================
-- 2. tenant_size_tier — shared tiering logic (used by both refresh
--    and the live comparison RPC, so they can never drift)
-- =============================================================

CREATE OR REPLACE FUNCTION public.tenant_size_tier(p_user_id uuid, p_start date, p_end date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Thresholds are tunable — nothing else in the system depends on
  -- these exact numbers. Fixed (not a floating tertile) so a tenant's
  -- tier doesn't quietly shift every night as the platform's overall
  -- distribution moves.
  SELECT CASE
    WHEN count(*) < 10 THEN 'small'
    WHEN count(*) < 40 THEN 'mid'
    ELSE 'large'
  END
  FROM jobs WHERE user_id = p_user_id AND created_at::date BETWEEN p_start AND p_end;
$$;

GRANT EXECUTE ON FUNCTION public.tenant_size_tier(uuid, date, date) TO authenticated, service_role;

-- =============================================================
-- 3. benchmark_tenant_standing — a tenant's own last-known bucket,
--    used only to detect genuine crossings (never exposes anyone
--    else's row — RLS scopes strictly to the owning tenant)
-- =============================================================

CREATE TABLE IF NOT EXISTS benchmark_tenant_standing (
  user_id uuid NOT NULL,
  metric text NOT NULL,
  last_bucket text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric)
);

ALTER TABLE benchmark_tenant_standing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_benchmark_standing" ON benchmark_tenant_standing;
CREATE POLICY "select_own_benchmark_standing" ON benchmark_tenant_standing
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client insert/update/delete: written exclusively inside refresh_benchmark_cohorts().

-- =============================================================
-- 4. refresh_benchmark_cohorts — rewritten: size-tier cohorts, fixed
--    GET DIAGNOSTICS bug, calibrated noise, gap-discovery trigger
-- =============================================================

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
  DELETE FROM benchmark_cohort_stats WHERE period_end < CURRENT_DATE - interval '14 days';

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

GRANT EXECUTE ON FUNCTION public.refresh_benchmark_cohorts(integer) TO service_role;

-- =============================================================
-- 5. get_benchmark_comparison — cohort fallback now size-tier aware.
--    Output columns/types UNCHANGED (scope stays 'industry' | 'all' |
--    'none') so BenchmarksPage.tsx / src/lib/benchmarking.ts need no
--    changes at all.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_benchmark_comparison(p_user_id uuid, p_period_days integer DEFAULT 30)
RETURNS TABLE (
  metric text,
  unit text,
  direction text,
  my_value numeric,
  scope text,
  industry text,
  contributor_count integer,
  cohort_avg numeric,
  p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric,
  percentile_bucket text
)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
DECLARE
  v_my_industry text;
  v_my_size_tier text;
  v_start date := CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90));
BEGIN
  IF p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN;
  END IF;

  SELECT NULLIF(trim(bp.primary_industry), '') INTO v_my_industry
  FROM business_profile bp WHERE bp.user_id = p_user_id;
  v_my_industry := COALESCE(v_my_industry, 'unspecified');
  v_my_size_tier := public.tenant_size_tier(p_user_id, v_start, CURRENT_DATE);

  RETURN QUERY
  WITH mine AS (
    SELECT * FROM public.get_my_benchmark_metrics(p_user_id, p_period_days)
  ),
  cohort AS (
    -- Prefer the tightest match that has cleared k-anonymity: own
    -- industry + own size tier, then own industry at any size, then
    -- the cross-platform pool.
    SELECT DISTINCT ON (b.metric)
      b.metric, b.industry, b.contributor_count, b.avg_value,
      b.p10, b.p25, b.p50, b.p75, b.p90
    FROM benchmark_cohort_stats b
    WHERE (b.industry = v_my_industry AND b.size_tier = v_my_size_tier)
       OR (b.industry = v_my_industry AND b.size_tier = 'all')
       OR (b.industry = 'all' AND b.size_tier = 'all')
    ORDER BY
      b.metric,
      CASE WHEN b.industry = v_my_industry AND b.size_tier = v_my_size_tier THEN 0
           WHEN b.industry = v_my_industry THEN 1
           ELSE 2 END,
      b.period_end DESC
  )
  SELECT
    m.metric, m.unit, m.direction, m.value,
    CASE WHEN c.industry = v_my_industry THEN 'industry' WHEN c.industry = 'all' THEN 'all' ELSE 'none' END,
    COALESCE(c.industry, v_my_industry),
    c.contributor_count, c.avg_value, c.p10, c.p25, c.p50, c.p75, c.p90,
    CASE
      WHEN c.metric IS NULL THEN NULL
      WHEN m.direction = 'higher_is_better' THEN
        CASE
          WHEN m.value >= c.p90 THEN 'top10'
          WHEN m.value >= c.p75 THEN 'top25'
          WHEN m.value >= c.p50 THEN 'top50'
          WHEN m.value >= c.p25 THEN 'bottom50'
          ELSE 'bottom25'
        END
      ELSE
        CASE
          WHEN m.value <= c.p10 THEN 'top10'
          WHEN m.value <= c.p25 THEN 'top25'
          WHEN m.value <= c.p50 THEN 'top50'
          WHEN m.value <= c.p75 THEN 'bottom50'
          ELSE 'bottom25'
        END
    END
  FROM mine m
  LEFT JOIN cohort c ON c.metric = m.metric;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_benchmark_comparison(uuid, integer) TO authenticated;

-- =============================================================
-- 6. Nightly schedule — this is what was missing entirely before.
--    No-op (not an error) if pg_cron isn't enabled on this project.
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-refresh-benchmark-cohorts');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-refresh-benchmark-cohorts', '30 3 * * *', 'select public.refresh_benchmark_cohorts()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
