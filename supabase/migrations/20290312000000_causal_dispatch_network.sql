/*
  # Causal Dispatch Network — cross-tenant job-type priors (shadow only)

  ## What
  1. causal_dispatch_tenant_priors   one row per (account, job type): the tenant's OWN job-type-level summary
                                     (rows used, technicians, between-technician variance tau2, baseline FTF rate).
                                     No technician ids, no names, no per-job data. Owner-scoped RLS.
  2. causal_dispatch_job_type_priors pooled output. No account column. Service role only (no client policy, no grant).
  3. refresh_causal_dispatch_priors() rebuilds (2) from (1) using ONLY tenants the central consent gate lets through:
        flow key 'causal_cohorts'  ->  public.xtl_contributors('causal_cohorts')
     That flow is registered in 20290305000000_cross_tenant_consent_enforcement.sql with sde_domain = NULL, so
     NOTHING is pooled until product + counsel map it:
        UPDATE cross_tenant_flows SET sde_domain = 'outcomes' WHERE flow_key = 'causal_cohorts';   -- [COUNSEL]
     Consent is evaluated live on every refresh; a revoked tenant drops out of the next build.

  ## Minimums (HUMAN SIGN-OFF REQUIRED; mirrored in src/lib/causal/pooling.ts)
     >= 5 contributing tenants per job type, >= 30 rows and >= 3 technicians per tenant, >= 300 pooled rows,
     published row count floored to a multiple of 10, equal tenant weights (so no tenant exceeds 1/5 = 20% > the 40% cap),
     job-type label must match ^[a-z0-9][a-z0-9 _-]{1,39}$ (free-text service types never leak odd strings).

  ## Safety
  Additive and idempotent. No existing table, policy or function is changed. Pooled values only ever feed the
  shrinkage target / power calculator in shadow mode; they never drive an assignment, ranking, pay or exclusion.

  ## Rollback
    DROP FUNCTION IF EXISTS public.refresh_causal_dispatch_priors();
    DROP TABLE IF EXISTS public.causal_dispatch_job_type_priors;
    DROP TABLE IF EXISTS public.causal_dispatch_tenant_priors;
  (Nothing else depends on them.)
*/

CREATE TABLE IF NOT EXISTS public.causal_dispatch_tenant_priors (
  user_id       uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_type      text NOT NULL CHECK (job_type ~ '^[a-z0-9][a-z0-9 _-]{1,39}$'),
  n_rows        integer NOT NULL CHECK (n_rows >= 0),
  n_technicians integer NOT NULL CHECK (n_technicians >= 0),
  tau2          numeric NOT NULL CHECK (tau2 >= 0 AND tau2 < 1),
  baseline      numeric NOT NULL CHECK (baseline >= 0 AND baseline <= 1),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_type)
);
ALTER TABLE public.causal_dispatch_tenant_priors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'causal_dispatch_tenant_priors' AND policyname = 'cdtp_select') THEN
    CREATE POLICY "cdtp_select" ON public.causal_dispatch_tenant_priors
      FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'causal_dispatch_tenant_priors' AND policyname = 'cdtp_insert') THEN
    CREATE POLICY "cdtp_insert" ON public.causal_dispatch_tenant_priors
      FOR INSERT TO authenticated
      WITH CHECK (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'causal_dispatch_tenant_priors' AND policyname = 'cdtp_update') THEN
    CREATE POLICY "cdtp_update" ON public.causal_dispatch_tenant_priors
      FOR UPDATE TO authenticated
      USING (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()))
      WITH CHECK (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'causal_dispatch_tenant_priors' AND policyname = 'cdtp_delete') THEN
    CREATE POLICY "cdtp_delete" ON public.causal_dispatch_tenant_priors
      FOR DELETE TO authenticated
      USING (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()));
  END IF;
END $$;

REVOKE ALL ON public.causal_dispatch_tenant_priors FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.causal_dispatch_tenant_priors TO authenticated;
GRANT ALL ON public.causal_dispatch_tenant_priors TO service_role;

CREATE TABLE IF NOT EXISTS public.causal_dispatch_job_type_priors (
  job_type     text PRIMARY KEY CHECK (job_type ~ '^[a-z0-9][a-z0-9 _-]{1,39}$'),
  n_tenants    integer NOT NULL CHECK (n_tenants >= 5),
  n_rows       integer NOT NULL CHECK (n_rows >= 300),
  tau2         numeric NOT NULL CHECK (tau2 >= 0),
  baseline     numeric NOT NULL CHECK (baseline >= 0 AND baseline <= 1),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.causal_dispatch_job_type_priors ENABLE ROW LEVEL SECURITY;
-- No policy and no client grant: only the service role (edge function / scheduled job) reads the pooled priors.
REVOKE ALL ON public.causal_dispatch_job_type_priors FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.causal_dispatch_job_type_priors TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_causal_dispatch_priors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now   timestamptz := now();
  v_count integer;
BEGIN
  WITH contrib AS (
    SELECT t.user_id, t.job_type, t.n_rows, t.tau2, t.baseline
    FROM public.causal_dispatch_tenant_priors t
    WHERE t.user_id IN (SELECT public.xtl_contributors('causal_cohorts'))
      AND t.n_rows >= 30
      AND t.n_technicians >= 3
      AND t.job_type ~ '^[a-z0-9][a-z0-9 _-]{1,39}$'
  ), pooled AS (
    SELECT c.job_type,
           count(*)::integer AS n_tenants,
           sum(c.n_rows)::bigint AS total_rows,
           avg(c.tau2) AS tau2,
           avg(c.baseline) AS baseline
    FROM contrib c
    GROUP BY c.job_type
    HAVING count(*) >= 5 AND sum(c.n_rows) >= 300
  )
  INSERT INTO public.causal_dispatch_job_type_priors AS p (job_type, n_tenants, n_rows, tau2, baseline, refreshed_at)
  SELECT pooled.job_type, pooled.n_tenants, ((pooled.total_rows / 10) * 10)::integer, pooled.tau2, pooled.baseline, v_now
  FROM pooled
  ON CONFLICT (job_type) DO UPDATE
    SET n_tenants = EXCLUDED.n_tenants,
        n_rows = EXCLUDED.n_rows,
        tau2 = EXCLUDED.tau2,
        baseline = EXCLUDED.baseline,
        refreshed_at = EXCLUDED.refreshed_at;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- A job type that no longer meets the minimums (or whose tenants revoked consent) must not linger.
  DELETE FROM public.causal_dispatch_job_type_priors WHERE refreshed_at < v_now;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_causal_dispatch_priors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_causal_dispatch_priors() TO service_role;
