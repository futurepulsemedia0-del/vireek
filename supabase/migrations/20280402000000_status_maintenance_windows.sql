-- Scheduled maintenance windows for the public status page.
-- Additive only: new table + new function. Does not touch status_incidents or public_status_feed().
-- Requires: public.synthetic_is_operator() (from 20271102000000_synthetic_monitoring_slo.sql).
-- Rollback:  DROP FUNCTION IF EXISTS public.public_status_maintenance();  DROP TABLE IF EXISTS public.status_maintenance_windows;

CREATE TABLE IF NOT EXISTS public.status_maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  summary text NOT NULL,
  component_id text,
  region text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smw_title_len CHECK (char_length(title) BETWEEN 3 AND 200),
  CONSTRAINT smw_summary_len CHECK (char_length(summary) BETWEEN 3 AND 2000),
  CONSTRAINT smw_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT smw_window_check CHECK (ends_at > starts_at),
  CONSTRAINT smw_region_check CHECK (region IS NULL OR region ~ '^[a-z0-9-]{2,32}$'),
  CONSTRAINT smw_component_check CHECK (component_id IS NULL OR component_id ~ '^[a-z0-9_-]{2,64}$')
);

CREATE INDEX IF NOT EXISTS idx_smw_ends ON public.status_maintenance_windows (ends_at DESC) WHERE status <> 'cancelled';

ALTER TABLE public.status_maintenance_windows ENABLE ROW LEVEL SECURITY;

-- Only Vireek staff / service role may read or write the table directly.
DROP POLICY IF EXISTS smw_operator_all ON public.status_maintenance_windows;
CREATE POLICY smw_operator_all ON public.status_maintenance_windows
  FOR ALL TO authenticated, service_role
  USING (public.synthetic_is_operator())
  WITH CHECK (public.synthetic_is_operator());

-- Public, read-only projection: no created_by, no cancelled rows, only the last 7 days onward.
CREATE OR REPLACE FUNCTION public.public_status_maintenance()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id,
           'title', w.title,
           'summary', w.summary,
           'component_id', w.component_id,
           'region', w.region,
           'starts_at', w.starts_at,
           'ends_at', w.ends_at,
           'status', CASE
                       WHEN w.status = 'cancelled' THEN 'cancelled'
                       WHEN now() >= w.ends_at THEN 'completed'
                       WHEN now() >= w.starts_at THEN 'in_progress'
                       ELSE 'scheduled'
                     END
         ) ORDER BY w.starts_at), '[]'::jsonb)
    FROM public.status_maintenance_windows w
   WHERE w.status <> 'cancelled'
     AND w.ends_at >= now() - interval '7 days';
$$;

REVOKE ALL ON FUNCTION public.public_status_maintenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_status_maintenance() TO anon, authenticated, service_role;
