/*
  # Cross-Tenant Anonymous Benchmarking

  Businesses see how they compare to the platform (median, p25/p75) on
  a handful of operational metrics — never another business's raw
  numbers. Two-layer anonymity guarantee:
    1. compute_platform_benchmarks() only returns a metric when at
       least min_sample_size distinct businesses contributed to it.
    2. benchmark_snapshots' RLS still re-checks sample_size >= 5 at
       read time, so even a bug in the compute job can't leak a
       low-sample row to the client.
  The aggregation function is locked to service_role only — an
  authenticated user calling it directly with a lower min_sample_size
  to try to de-anonymize a competitor is blocked at the grant level,
  not just by a default parameter.
*/

CREATE TABLE IF NOT EXISTS benchmark_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key text NOT NULL,
  segment text NOT NULL DEFAULT 'all',
  sample_size integer NOT NULL,
  p25 numeric,
  median numeric,
  p75 numeric,
  average numeric,
  period_start date,
  period_end date,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (metric_key, segment)
);

ALTER TABLE benchmark_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_benchmark_snapshots" ON benchmark_snapshots;
CREATE POLICY "select_benchmark_snapshots" ON benchmark_snapshots
  FOR SELECT TO authenticated USING (sample_size >= 5);
-- No insert/update/delete policy: only the compute-benchmarks edge
-- function (service role) ever writes here.

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
    GROUP BY l.user_id
    HAVING COUNT(DISTINCT l.id) >= 3
  ),
  tenant_invoice AS (
    SELECT user_id, AVG(invoice_amount) AS value
    FROM jobs
    WHERE invoice_amount IS NOT NULL AND created_at > now() - interval '90 days'
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  ),
  tenant_call_duration AS (
    SELECT user_id, AVG(duration_seconds) AS value
    FROM calls
    WHERE duration_seconds IS NOT NULL AND call_datetime > now() - interval '90 days'
    GROUP BY user_id
    HAVING COUNT(*) >= 5
  ),
  tenant_emergency_rate AS (
    SELECT user_id, COUNT(*) FILTER (WHERE is_emergency)::numeric / NULLIF(COUNT(*), 0) AS value
    FROM calls
    WHERE call_datetime > now() - interval '90 days'
    GROUP BY user_id
    HAVING COUNT(*) >= 5
  ),
  tenant_completion AS (
    SELECT user_id, COUNT(*) FILTER (WHERE job_status = 'completed')::numeric / NULLIF(COUNT(*), 0) AS value
    FROM jobs
    WHERE created_at > now() - interval '90 days'
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  ),
  tenant_payment_speed AS (
    SELECT user_id, AVG(EXTRACT(EPOCH FROM (paid_at - created_at)) / 3600) AS value
    FROM payment_requests
    WHERE paid_at IS NOT NULL AND created_at > now() - interval '90 days'
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

REVOKE ALL ON FUNCTION public.compute_platform_benchmarks(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_platform_benchmarks(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.compute_platform_benchmarks(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_platform_benchmarks(integer) TO service_role;
