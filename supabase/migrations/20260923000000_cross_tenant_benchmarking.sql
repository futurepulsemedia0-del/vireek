/*
  # Cross-Tenant Anonymous Benchmarking

  ## Why
  Every number in this product today ("your conversion rate is 34%") is
  meaningless without a reference point. Is 34% good? A business only
  finds out by comparing itself to peers doing the same trade — but this
  is a multi-tenant SaaS with strict per-account RLS, so "peers" means
  *other tenants' data*, which nothing in this schema is allowed to touch
  directly. This migration builds a way to answer "how do I compare" that
  never lets one tenant see another tenant's numbers, even in aggregate
  form, unless enough tenants are pooled together that no individual
  business's result is recoverable from it.

  ## Privacy design — read this before changing anything below

  1. **k-anonymity floor.** A cohort statistic (an industry+metric+period
     combination) is only ever written to the exposed table if at least
     `MIN_COHORT_SIZE` (5) distinct tenants contributed a value to it. Below
     that, the row simply doesn't exist — there is no way to request it,
     no "insufficient data" row that leaks the count. Five is a common,
     defensible floor: enough that no single tenant's data measurably
     shifts an average, small enough that most trade categories on the
     platform clear it once there's real usage.

  2. **No client-parameterized cross-tenant queries, ever.** The only
     table any tenant can SELECT from that contains other tenants'
     influence (`benchmark_cohort_stats`) holds nothing but pre-computed
     aggregates — count, mean, stddev, and five percentile break points —
     recalculated on a fixed nightly schedule by `refresh_benchmark_cohorts()`,
     a SECURITY DEFINER function no client can call with arbitrary
     arguments. There is no live "compare me against calls placed between
     X and Y" endpoint a client could hammer with shifting date ranges to
     triangulate a specific competitor's numbers (a classic differencing
     attack on aggregate statistics) — the window is fixed (trailing 30
     days) and the whole cohort snapshot is recomputed as one atomic unit.

  3. **Aggregated twice, not once.** Per-tenant raw call/lead/quote/job
     rows are first collapsed into ONE number per tenant per metric
     (`compute_tenant_metrics`), and only THOSE per-tenant numbers are fed
     into the cohort's mean/stddev/percentiles. A tenant's individual
     event-level data never appears in any structure another tenant's
     query can reach, even transiently.

  4. **No extremes stored.** Min/max are deliberately not kept — even in a
     k-of-5 cohort, "the fastest responder is under 4 minutes" is closer
     to identifying than a mean or a median is. p10/p25/p50/p75/p90 give
     a business a real sense of where it stands without exposing an edge.

  5. **Self-inclusion is intentional and disclosed.** A tenant's own data
     is part of the cohort average it's compared against — the same way a
     credit score percentile includes your own score in the population.
     The UI says so plainly rather than implying an external-only
     benchmark.

  ## What's benchmarked
  Six metrics chosen because every input already exists in this schema and
  each has an unambiguous "better" direction: lead conversion rate, quote
  acceptance rate, missed-call rate, AI call score, lead-to-quote response
  time, and average paid ticket size. Cohorts are by `primary_industry`
  (falling back to an all-industry pool when a tenant's own industry
  hasn't cleared k-anonymity yet, or has no industry set at all).

  ## Depends on
  Nothing new — reads `calls`, `leads`, `quotes`, `jobs`, `profiles`,
  `business_profile`, all already RLS-protected, using the SAME
  `get_account_owner_id()` ownership convention as the rest of the schema.
*/

-- =============================================================
-- 1. EXPOSED TABLE — anonymized aggregates only
-- =============================================================

CREATE TABLE IF NOT EXISTS benchmark_cohort_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- A primary_industry slug (see src/lib/industries.ts), or 'all' for the
  -- cross-industry pool used as a fallback.
  industry text NOT NULL,
  metric text NOT NULL CHECK (metric IN (
    'lead_conversion_rate', 'quote_acceptance_rate', 'missed_call_rate',
    'avg_call_score', 'avg_lead_response_hours', 'avg_ticket_cents'
  )),
  unit text NOT NULL CHECK (unit IN ('percent', 'score', 'hours', 'cents')),
  direction text NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better')),

  period_start date NOT NULL,
  period_end date NOT NULL,

  -- How many distinct tenants fed into this row. Never exposed as an exact
  -- count in the UI below a rounded-down bucket, but stored precisely so
  -- the k-anonymity gate itself is auditable.
  contributor_count integer NOT NULL CHECK (contributor_count >= 5),

  avg_value numeric NOT NULL,
  stddev_value numeric,
  p10 numeric NOT NULL,
  p25 numeric NOT NULL,
  p50 numeric NOT NULL,
  p75 numeric NOT NULL,
  p90 numeric NOT NULL,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (industry, metric, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_cohort_lookup
  ON benchmark_cohort_stats(industry, metric, period_end DESC);

ALTER TABLE benchmark_cohort_stats ENABLE ROW LEVEL SECURITY;

-- Deliberately open to every authenticated tenant: by construction (the
-- CHECK above and the refresh function below) a row can only exist here
-- once it has cleared k-anonymity, so there is nothing tenant-specific to
-- protect. No INSERT/UPDATE/DELETE policy — written exclusively by
-- refresh_benchmark_cohorts().
DROP POLICY IF EXISTS "select_benchmark_cohort_stats" ON benchmark_cohort_stats;
CREATE POLICY "select_benchmark_cohort_stats" ON benchmark_cohort_stats
  FOR SELECT TO authenticated USING (true);

-- =============================================================
-- 2. PER-TENANT METRIC SNAPSHOT — the one shared computation
-- =============================================================

/*
  Returns up to six rows (metric, value, unit, direction) for ONE tenant
  over [p_start, p_end]. A metric is simply absent from the result when
  its denominator is zero for that tenant in that period (e.g. a tenant
  with no calls that month contributes nothing to missed_call_rate) —
  never a fabricated 0, which would silently drag every cohort toward a
  number no real business produced.

  Filters explicitly by p_user_id in every subquery rather than relying on
  ambient RLS, so this gives correct, safely-scoped results whether it's
  invoked directly by an authenticated tenant (get_my_benchmark_metrics)
  or from inside the SECURITY DEFINER refresh loop iterating every tenant
  on the platform.
*/
CREATE OR REPLACE FUNCTION public.compute_tenant_metrics(p_user_id uuid, p_start date, p_end date)
RETURNS TABLE (metric text, value numeric, unit text, direction text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH lead_totals AS (
    SELECT
      count(*) FILTER (WHERE created_at::date BETWEEN p_start AND p_end) AS total,
      count(*) FILTER (WHERE created_at::date BETWEEN p_start AND p_end AND stage = 'won') AS won
    FROM leads WHERE user_id = p_user_id
  ),
  quote_totals AS (
    SELECT
      count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at::date BETWEEN p_start AND p_end) AS sent,
      count(*) FILTER (WHERE status = 'accepted' AND sent_at IS NOT NULL AND sent_at::date BETWEEN p_start AND p_end) AS accepted
    FROM quotes WHERE user_id = p_user_id
  ),
  call_totals AS (
    SELECT
      count(*) FILTER (WHERE call_datetime::date BETWEEN p_start AND p_end) AS total,
      count(*) FILTER (WHERE call_datetime::date BETWEEN p_start AND p_end AND (status = 'missed' OR is_voicemail)) AS missed,
      avg(call_score) FILTER (WHERE call_datetime::date BETWEEN p_start AND p_end AND call_score IS NOT NULL) AS avg_score
    FROM calls WHERE user_id = p_user_id
  ),
  response_totals AS (
    SELECT avg(extract(epoch FROM (quote_sent_at - created_at)) / 3600.0) AS avg_hours
    FROM leads
    WHERE user_id = p_user_id
      AND quote_sent_at IS NOT NULL
      AND created_at::date BETWEEN p_start AND p_end
      AND quote_sent_at >= created_at
  ),
  ticket_totals AS (
    SELECT avg(invoice_amount * 100) AS avg_cents
    FROM jobs
    WHERE user_id = p_user_id
      AND invoice_status = 'paid'
      AND invoice_amount IS NOT NULL
      AND created_at::date BETWEEN p_start AND p_end
  )
  SELECT 'lead_conversion_rate', round(100.0 * won / total, 2), 'percent', 'higher_is_better'
  FROM lead_totals WHERE total > 0
  UNION ALL
  SELECT 'quote_acceptance_rate', round(100.0 * accepted / sent, 2), 'percent', 'higher_is_better'
  FROM quote_totals WHERE sent > 0
  UNION ALL
  SELECT 'missed_call_rate', round(100.0 * missed / total, 2), 'percent', 'lower_is_better'
  FROM call_totals WHERE total > 0
  UNION ALL
  SELECT 'avg_call_score', round(avg_score, 1), 'score', 'higher_is_better'
  FROM call_totals WHERE avg_score IS NOT NULL
  UNION ALL
  SELECT 'avg_lead_response_hours', round(avg_hours::numeric, 2), 'hours', 'lower_is_better'
  FROM response_totals WHERE avg_hours IS NOT NULL
  UNION ALL
  SELECT 'avg_ticket_cents', round(avg_cents), 'cents', 'higher_is_better'
  FROM ticket_totals WHERE avg_cents IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.compute_tenant_metrics(uuid, date, date) TO authenticated;

-- =============================================================
-- 3. MY METRICS — a tenant's own numbers, always live
-- =============================================================

/*
  Thin, ownership-checked wrapper. Explicit p_user_id = get_account_owner_id()
  guard (rather than trusting RLS alone) because this is the one function
  in this migration a client calls directly with a user id it supplies.
*/
CREATE OR REPLACE FUNCTION public.get_my_benchmark_metrics(p_user_id uuid, p_period_days integer DEFAULT 30)
RETURNS TABLE (metric text, value numeric, unit text, direction text)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM public.compute_tenant_metrics(
    p_user_id,
    (CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90))),
    CURRENT_DATE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_benchmark_metrics(uuid, integer) TO authenticated;

-- =============================================================
-- 4. NIGHTLY REFRESH — the only path that ever touches all tenants
-- =============================================================

/*
  Rebuilds the trailing-30-day (by default) cohort snapshot for every
  metric, for every industry that clears k-anonymity, plus the 'all'
  cross-industry pool. Meant to run once a night via pg_cron — see the
  integration guide for the `cron.schedule(...)` call, since scheduling it
  is an operational choice for whoever runs this instance, not something
  a migration should silently install.

  SECURITY DEFINER is required here — this is the one place in the entire
  feature that legitimately reads every tenant's data in one pass, and it
  does so only to produce the k-anonymized rows in step 2, discarding the
  per-tenant intermediate values (the temp table) the moment the function
  returns. Not granted to `authenticated` at all; only `service_role` can
  invoke it, so no client session can trigger a full-platform scan on
  demand.
*/
CREATE OR REPLACE FUNCTION public.refresh_benchmark_cohorts(p_period_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_cohort_size CONSTANT integer := 5;
  v_start date := CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90));
  v_end date := CURRENT_DATE;
  v_owner record;
  v_industry text;
  v_rows_written integer := 0;
BEGIN
  CREATE TEMP TABLE tmp_tenant_metrics (
    user_id uuid, industry text, metric text, value numeric, unit text, direction text
  ) ON COMMIT DROP;

  -- One pass over every tenant (account owners only — team members share
  -- their owner's user_id on every data row, so per-owner is per-tenant).
  FOR v_owner IN SELECT id AS user_id FROM profiles WHERE role = 'owner'
  LOOP
    SELECT bp.primary_industry INTO v_industry FROM business_profile bp WHERE bp.user_id = v_owner.user_id;
    v_industry := COALESCE(NULLIF(trim(v_industry), ''), 'unspecified');

    INSERT INTO tmp_tenant_metrics (user_id, industry, metric, value, unit, direction)
    SELECT v_owner.user_id, v_industry, m.metric, m.value, m.unit, m.direction
    FROM public.compute_tenant_metrics(v_owner.user_id, v_start, v_end) m;
  END LOOP;

  -- Per-industry cohorts, gated by k-anonymity.
  INSERT INTO benchmark_cohort_stats (
    industry, metric, unit, direction, period_start, period_end,
    contributor_count, avg_value, stddev_value, p10, p25, p50, p75, p90
  )
  SELECT
    industry, metric, min(unit), min(direction), v_start, v_end,
    count(*), avg(value), stddev_samp(value),
    percentile_cont(0.10) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
  FROM tmp_tenant_metrics
  GROUP BY industry, metric
  HAVING count(*) >= v_min_cohort_size
  ON CONFLICT (industry, metric, period_start, period_end) DO UPDATE
    SET contributor_count = EXCLUDED.contributor_count,
        avg_value = EXCLUDED.avg_value,
        stddev_value = EXCLUDED.stddev_value,
        p10 = EXCLUDED.p10, p25 = EXCLUDED.p25, p50 = EXCLUDED.p50,
        p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
        computed_at = now();

  GET DIAGNOSTICS v_rows_written = ROW_COUNT;

  -- Cross-industry pool ('all'), same gate. A tenant whose own industry
  -- hasn't cleared k-anonymity yet still gets a meaningful comparison.
  INSERT INTO benchmark_cohort_stats (
    industry, metric, unit, direction, period_start, period_end,
    contributor_count, avg_value, stddev_value, p10, p25, p50, p75, p90
  )
  SELECT
    'all', metric, min(unit), min(direction), v_start, v_end,
    count(*), avg(value), stddev_samp(value),
    percentile_cont(0.10) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.25) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
    percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
  FROM tmp_tenant_metrics
  GROUP BY metric
  HAVING count(*) >= v_min_cohort_size
  ON CONFLICT (industry, metric, period_start, period_end) DO UPDATE
    SET contributor_count = EXCLUDED.contributor_count,
        avg_value = EXCLUDED.avg_value,
        stddev_value = EXCLUDED.stddev_value,
        p10 = EXCLUDED.p10, p25 = EXCLUDED.p25, p50 = EXCLUDED.p50,
        p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
        computed_at = now();

  GET DIAGNOSTICS v_rows_written = v_rows_written + ROW_COUNT;

  -- Bound table growth: keep a rolling two-week history of nightly
  -- snapshots (enough to show "this improved over the last couple of
  -- weeks" later without keeping every night forever).
  DELETE FROM benchmark_cohort_stats WHERE period_end < CURRENT_DATE - interval '14 days';

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_benchmark_cohorts(integer) TO service_role;

-- =============================================================
-- 5. THE ONE CLIENT-FACING COMPARISON RPC
-- =============================================================

/*
  Combines a tenant's own live numbers with the most recent cohort
  snapshot for each metric, preferring their own industry when it has
  cleared k-anonymity and falling back to the 'all' pool otherwise (or to
  neither, if the platform genuinely doesn't have enough data yet for that
  metric anywhere — returned as scope = 'none', never a fabricated
  comparison).

  `percentile_bucket` is computed here, not stored, from the same p10..p90
  breakpoints — 'top10' / 'top25' / 'top50' / 'bottom50' / 'bottom25',
  direction-aware so a lower-is-better metric like missed_call_rate ranks
  correctly.
*/
CREATE OR REPLACE FUNCTION public.get_benchmark_comparison(p_user_id uuid, p_period_days integer DEFAULT 30)
RETURNS TABLE (
  metric text,
  unit text,
  direction text,
  my_value numeric,
  scope text,              -- 'industry' | 'all' | 'none'
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
BEGIN
  IF p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN;
  END IF;

  SELECT NULLIF(trim(bp.primary_industry), '') INTO v_my_industry
  FROM business_profile bp WHERE bp.user_id = p_user_id;
  v_my_industry := COALESCE(v_my_industry, 'unspecified');

  RETURN QUERY
  WITH mine AS (
    SELECT * FROM public.get_my_benchmark_metrics(p_user_id, p_period_days)
  ),
  cohort AS (
    -- Latest snapshot per (industry, metric), preferring the tenant's own
    -- industry row when present, else the 'all' row.
    SELECT DISTINCT ON (b.metric)
      b.metric, b.industry, b.contributor_count, b.avg_value,
      b.p10, b.p25, b.p50, b.p75, b.p90
    FROM benchmark_cohort_stats b
    WHERE b.industry IN (v_my_industry, 'all')
    ORDER BY b.metric, (b.industry = v_my_industry) DESC, b.period_end DESC
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
