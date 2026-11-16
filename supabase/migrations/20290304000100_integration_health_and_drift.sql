/*
  Integration health + drift reports.

  - integration_drift_reports: written ONLY by the integration-reconcile edge function (service_role). Drift is surfaced,
    never auto-fixed. Owners/team read their own rows.
  - get_integration_health(): one call for the UI: per provider connection status, last successful sync, last error,
    open drift count, failed job pushes (job_external_syncs.status='error') in the last 30 days.
    job_external_syncs rows with status 'error' ARE the dead-letter queue for job write-back (verified: schema in
    20261001000000_job_external_sync.sql; jobSyncClaim.ts lets them be retried exactly once at a time).

  Prerequisites: price_book_connections, job_external_syncs, get_account_owner_id().

  ROLLBACK:
    DROP FUNCTION IF EXISTS public.get_integration_health();
    DROP TABLE IF EXISTS public.integration_drift_reports;
*/

CREATE TABLE IF NOT EXISTS public.integration_drift_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('jobber', 'service_titan', 'housecall_pro')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  total integer NOT NULL CHECK (total >= 0),
  missing_in_vireek integer NOT NULL DEFAULT 0,
  missing_in_provider integer NOT NULL DEFAULT 0,
  price_mismatch integer NOT NULL DEFAULT 0,
  active_mismatch integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_integration_drift_open ON public.integration_drift_reports (user_id, provider) WHERE status = 'open';

ALTER TABLE public.integration_drift_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_drift_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_drift_reports TO authenticated;
DROP POLICY IF EXISTS "select_own_integration_drift" ON public.integration_drift_reports;
CREATE POLICY "select_own_integration_drift" ON public.integration_drift_reports
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.get_integration_health()
RETURNS TABLE (provider text, status text, last_synced_at timestamptz, last_sync_error text, open_drift integer, failed_job_pushes_30d integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.provider, c.status, c.last_synced_at, c.last_sync_error,
         COALESCE((SELECT sum(d.total)::integer FROM integration_drift_reports d
                    WHERE d.user_id = c.user_id AND d.provider = c.provider AND d.status = 'open'), 0),
         COALESCE((SELECT count(*)::integer FROM job_external_syncs j
                    WHERE j.user_id = public.get_account_owner_id() AND j.provider = c.provider
                      AND j.status = 'error' AND j.updated_at > now() - interval '30 days'), 0)
    FROM price_book_connections c
   WHERE c.user_id IN (auth.uid(), public.get_account_owner_id())
     AND c.status <> 'disconnected';
$$;
REVOKE ALL ON FUNCTION public.get_integration_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_integration_health() TO authenticated;
