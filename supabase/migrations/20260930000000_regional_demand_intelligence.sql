/*
  # Regional Demand Intelligence

  ## Why
  This project has no structured geo data (no zip/city columns) — only
  the free-text `business_profile.service_area` and free-text addresses
  on leads/jobs. Rather than inventing geocoding, this reuses the exact
  k-anonymity pattern already proven in 20260917010000_cross_tenant_
  benchmarking.sql: businesses that share the SAME normalized
  service_area + primary_industry are grouped into one segment, and a
  segment is only ever exposed once at least `min_sample_size` distinct
  businesses contribute to it. No business ever sees another business's
  raw numbers — only the aggregate.

  ## Security
  Same two-layer anonymity guarantee as benchmark_snapshots:
    1. compute_regional_demand() only returns a segment with >= min_sample_size businesses.
    2. RLS on regional_demand_snapshots re-checks sample_size >= 5 at read time.
  The aggregation function is locked to service_role only.
*/

CREATE TABLE IF NOT EXISTS regional_demand_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry text NOT NULL,
  region_key text NOT NULL,       -- normalized (lower/trim) service_area, used for matching
  region_label text NOT NULL,     -- display-safe version (initcap) of the same string
  sample_size integer NOT NULL,

  current_week_calls integer NOT NULL DEFAULT 0,
  prior_week_calls integer NOT NULL DEFAULT 0,
  call_volume_change_pct numeric(6,1),
  current_week_leads integer NOT NULL DEFAULT 0,
  emergency_rate_pct numeric(5,1),

  period_start date,
  period_end date,
  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (industry, region_key)
);

ALTER TABLE regional_demand_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_regional_demand_snapshots" ON regional_demand_snapshots;
CREATE POLICY "select_regional_demand_snapshots" ON regional_demand_snapshots
  FOR SELECT TO authenticated USING (sample_size >= 5);
-- No insert/update/delete policy: only compute-regional-demand (service role) writes here.

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

REVOKE ALL ON FUNCTION public.compute_regional_demand(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_regional_demand(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.compute_regional_demand(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_regional_demand(integer) TO service_role;
