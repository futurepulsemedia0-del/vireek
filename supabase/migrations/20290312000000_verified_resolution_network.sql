/*
  # Verified Resolution Network - public aggregate RPC

  Public (anon) read of ALREADY-AGGREGATED cohorts from outcome_benchmark_cohorts.
  - Public k-anonymity threshold: 10 contributing businesses (stricter than the internal 5).
  - Exposes industry-level and platform-wide rows only (region_key = 'all'). No region, no tenant ids.
  - Exposes p25 / p50 / p75 only (no p10/p90 extremes).
  - Returns NO invented rows: metrics that do not clear k are simply absent; the client shows "insufficient data".

  Requires: outcome_benchmark_cohorts (20270301000000_outcome_benchmark_network.sql).
  Idempotent. Rollback: DROP FUNCTION public.vrn_public_summary();
*/

CREATE OR REPLACE FUNCTION public.vrn_public_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_k CONSTANT integer := 10;
  v_rows jsonb;
  v_latest timestamptz;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'metric', c.metric,
           'unit', c.unit,
           'direction', c.direction,
           'window_days', c.window_days,
           'scope', CASE WHEN c.industry = 'all' THEN 'platform' ELSE 'industry' END,
           'industry', CASE WHEN c.industry = 'all' THEN NULL ELSE c.industry END,
           'contributors', c.contributor_count,
           'p25', round(c.p25, 1),
           'p50', round(c.p50, 1),
           'p75', round(c.p75, 1),
           'computed_at', c.computed_at
         ) ORDER BY (c.industry = 'all') DESC, c.industry, c.metric, c.window_days), '[]'::jsonb),
         max(c.computed_at)
    INTO v_rows, v_latest
    FROM outcome_benchmark_cohorts c
   WHERE c.region_key = 'all'
     AND c.contributor_count >= v_k
     AND c.industry <> 'unspecified';

  RETURN jsonb_build_object('k_threshold', v_k, 'rows', v_rows, 'latest_computed_at', v_latest);
END;
$$;

REVOKE ALL ON FUNCTION public.vrn_public_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vrn_public_summary() TO anon, authenticated, service_role;
