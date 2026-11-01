/*
  # Real-user monitoring: web vitals

  Adds: rum_vitals (one row per metric sample), rum_vitals_summary() for the staff dashboard,
  rum_vitals_purge() for 30-day retention.

  ## Design notes
  - Privacy: no user id, no IP, no query string. Only a normalised route, coarse device/connection
    class, release id and the metric value are stored.
  - Writes: only the rum-ingest edge function (service role). RLS is ON with NO policies and all
    table privileges are revoked from anon/authenticated, so no browser client can read or write rows.
  - Reads: staff only, through rum_vitals_summary() (SECURITY DEFINER, gated by is_vireek_staff()).
  - Rollback: DROP FUNCTION public.rum_vitals_summary(integer); DROP FUNCTION public.rum_vitals_purge();
    DROP TABLE public.rum_vitals;  (data is disposable)
*/

CREATE TABLE IF NOT EXISTS public.rum_vitals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  metric text NOT NULL CHECK (metric IN ('LCP', 'CLS', 'INP', 'FCP', 'TTFB')),
  value double precision NOT NULL CHECK (value >= 0 AND value <= 600000),
  rating text NOT NULL CHECK (rating IN ('good', 'needs-improvement', 'poor')),
  route text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 120),
  device text NOT NULL CHECK (device IN ('mobile', 'tablet', 'desktop')),
  conn text NOT NULL CHECK (conn IN ('slow-2g', '2g', '3g', '4g', 'unknown')),
  release text NOT NULL CHECK (char_length(release) BETWEEN 1 AND 40),
  nav text NOT NULL CHECK (nav IN ('navigate', 'reload', 'back-forward', 'back-forward-cache', 'prerender', 'restore', 'unknown'))
);

ALTER TABLE public.rum_vitals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rum_vitals FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS rum_vitals_created_idx ON public.rum_vitals (created_at DESC);
CREATE INDEX IF NOT EXISTS rum_vitals_metric_route_idx ON public.rum_vitals (metric, route, created_at DESC);

-- Staff dashboard: p75 per route/metric/device for the last N days vs the N days before.
CREATE OR REPLACE FUNCTION public.rum_vitals_summary(p_days integer DEFAULT 7)
RETURNS TABLE (
  route text,
  metric text,
  device text,
  samples bigint,
  p75 double precision,
  p75_prev double precision,
  good_ratio double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH win AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 7), 1), 30) AS d
  ),
  cur AS (
    SELECT v.route, v.metric, v.device,
           count(*) AS samples,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY v.value) AS p75,
           avg((v.rating = 'good')::int)::double precision AS good_ratio
    FROM public.rum_vitals v, win
    WHERE v.created_at >= now() - make_interval(days => win.d)
    GROUP BY v.route, v.metric, v.device
  ),
  prev AS (
    SELECT v.route, v.metric, v.device,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY v.value) AS p75
    FROM public.rum_vitals v, win
    WHERE v.created_at >= now() - make_interval(days => win.d * 2)
      AND v.created_at < now() - make_interval(days => win.d)
    GROUP BY v.route, v.metric, v.device
  )
  SELECT cur.route, cur.metric, cur.device, cur.samples, cur.p75, prev.p75, cur.good_ratio
  FROM cur
  LEFT JOIN prev ON prev.route = cur.route AND prev.metric = cur.metric AND prev.device = cur.device
  WHERE cur.samples >= 20
    AND auth.uid() IS NOT NULL
    AND public.is_vireek_staff(auth.uid())
  ORDER BY cur.metric, cur.samples DESC;
$$;

REVOKE ALL ON FUNCTION public.rum_vitals_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rum_vitals_summary(integer) TO authenticated;

-- 30-day retention. Schedule from the SQL editor (pg_cron), as other migrations in this repo do:
--   select cron.schedule('rum-vitals-purge', '17 3 * * *', $cron$ select public.rum_vitals_purge(); $cron$);
CREATE OR REPLACE FUNCTION public.rum_vitals_purge()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM public.rum_vitals WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.rum_vitals_purge() FROM PUBLIC, anon, authenticated;
