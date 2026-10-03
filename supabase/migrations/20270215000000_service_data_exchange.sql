/*
  # VIREEK Service Data Exchange (SDE)

  A consent-governed, privacy-preserving industry data layer.

  ## Why
  The project already has k-anonymous benchmarking
  (20260923000000 / 20261205000000), OEM failure patterns
  (20261215000000) and regional demand (20260930000000). Two things were
  missing:

    1. CONSENT. Those pipelines read every tenant automatically. There is
       no per-domain opt-in, no revocation, no audit trail and no record
       of what a contractor actually contributed.
    2. RECIPROCITY. Nothing ties what a contractor GIVES to what they
       GET, so the "more data -> better intelligence -> more customers"
       flywheel has no enforcement point.

  ## Model
  - Contractor never hands over raw data. Per-tenant "facts" exist only
    inside a TEMP table during refresh and are dropped on commit. Only
    cohort aggregates are ever persisted.
  - Six contribution domains (opt-in, per account, owner-only, revocable):
      failure   -> failure_intelligence
      equipment -> oem_intelligence
      pricing   -> pricing_intelligence
      labor     -> labor_intelligence
      parts     -> parts_intelligence
      outcomes  -> benchmark_intelligence + demand_intelligence
  - Give-to-get: sde_get_intelligence() returns rows for a product only
    if the caller's account contributes the domain feeding it.

  ## Privacy guarantees (enforced in code below)
  - k-anonymity: a cohort is published only with >= 5 distinct
    contributing accounts (>= 8 for pricing).
  - Bounded contribution: event-level facts are capped per account per
    cohort (25), so no account can swamp a cohort.
  - Dominance cap: a cohort is dropped if one account supplies > 40% of
    its rows.
  - Noise: a calibrated, order-preserving jitter scaled by
    stddev/sqrt(contributors). DP-INSPIRED, NOT a formally-proven
    epsilon-DP guarantee. Do not market it as certified differential
    privacy.
  - Sample sizes are rounded to the nearest 5.
  - Free-text dimensions (service type, part name) containing '@' or a
    run of 7+ digits are discarded.
  - The aggregate table has RLS enabled and NO policies, and direct table
    privileges are revoked: the only read path is the RPC.
  - Revocation takes effect at the next refresh (nightly): the cohorts
    are fully recomputed from currently-consenting accounts, so a revoked
    account's data is excluded and any cohort that drops below k vanishes.

  ## Deploy
    1. Run this migration.
    2. (Optional) run once manually:  select public.sde_refresh_exchange();
    3. Nightly pg_cron job is scheduled at the bottom (no-op if pg_cron
       is not enabled).
*/

-- =============================================================
-- 1. Helper functions (all tunables live here)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sde_terms_version()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'sde-terms-2027-02'::text $$;

CREATE OR REPLACE FUNCTION public.sde_product_domain(p_product text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_product
    WHEN 'failure_intelligence'   THEN 'failure'
    WHEN 'oem_intelligence'       THEN 'equipment'
    WHEN 'pricing_intelligence'   THEN 'pricing'
    WHEN 'labor_intelligence'     THEN 'labor'
    WHEN 'parts_intelligence'     THEN 'parts'
    WHEN 'benchmark_intelligence' THEN 'outcomes'
    WHEN 'demand_intelligence'    THEN 'outcomes'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.sde_min_contributors(p_product text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_product = 'pricing_intelligence' THEN 8 ELSE 5 END
$$;

-- Normalises free text used as a cohort dimension. Returns NULL for empty
-- strings and for anything that looks like contact data.
CREATE OR REPLACE FUNCTION public.sde_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n IS NULL THEN NULL
    WHEN n ~ '(@|[0-9]{7,})' THEN NULL
    ELSE n
  END
  FROM (
    SELECT NULLIF(left(lower(regexp_replace(btrim(COALESCE(p, '')), '\s+', ' ', 'g')), 60), '') AS n
  ) s
$$;

-- What counts as a "failure event" in service_type text. Tunable.
CREATE OR REPLACE FUNCTION public.sde_is_repair_service(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    p ~* '(repair|fix|breakdown|broken|no[ _-]?(heat|cool|ac|hot water|power)|not (working|cooling|heating)|leak|clog|emergency|diagnos|troubleshoot|replace|failure|service call)'
    AND p !~* '(maintenance|tune[ -]?up|inspection|estimate)',
    false)
$$;

-- Unit-aware clamp used by the noise step (counts/prices/minutes never go
-- negative; percentages stay within 0-100).
CREATE OR REPLACE FUNCTION public.sde_clamp(p numeric, p_unit text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN p_unit = 'percent' THEN round(LEAST(100, GREATEST(0, p)), 2)
    ELSE round(GREATEST(0, p), 2)
  END
$$;

-- =============================================================
-- 2. Consent, audit, contribution ledger
-- =============================================================

CREATE TABLE IF NOT EXISTS sde_consents (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes')),
  status text NOT NULL CHECK (status IN ('granted', 'revoked')),
  terms_version text NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, domain)
);

CREATE TABLE IF NOT EXISTS sde_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  domain text NOT NULL,
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  actor_id uuid,
  terms_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sde_consent_events_user ON sde_consent_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sde_contribution_ledger (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  domain text NOT NULL,
  run_date date NOT NULL,
  records_contributed integer NOT NULL DEFAULT 0,
  cohorts_contributed integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, domain, run_date)
);

ALTER TABLE sde_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sde_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sde_contribution_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_sde_consents" ON sde_consents;
CREATE POLICY "select_own_sde_consents" ON sde_consents
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_sde_consent_events" ON sde_consent_events;
CREATE POLICY "select_own_sde_consent_events" ON sde_consent_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_sde_ledger" ON sde_contribution_ledger;
CREATE POLICY "select_own_sde_ledger" ON sde_contribution_ledger
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Writes happen only inside SECURITY DEFINER functions below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sde_consents, sde_consent_events, sde_contribution_ledger FROM anon, authenticated;
REVOKE ALL ON sde_consents, sde_consent_events, sde_contribution_ledger FROM anon;

-- =============================================================
-- 3. Published cohort aggregates (no client access at all)
-- =============================================================

CREATE TABLE IF NOT EXISTS sde_intelligence_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL CHECK (product IN (
    'failure_intelligence', 'oem_intelligence', 'pricing_intelligence', 'labor_intelligence',
    'parts_intelligence', 'benchmark_intelligence', 'demand_intelligence'
  )),
  dimension jsonb NOT NULL,
  metric text NOT NULL,
  unit text NOT NULL,
  contributor_count integer NOT NULL CHECK (contributor_count >= 5),
  sample_size integer NOT NULL,
  avg_value numeric,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  noise_applied boolean NOT NULL DEFAULT true,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, dimension, metric)
);

CREATE INDEX IF NOT EXISTS idx_sde_cells_product ON sde_intelligence_cells(product, contributor_count DESC);

ALTER TABLE sde_intelligence_cells ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: only sde_get_intelligence() can read this table.
REVOKE ALL ON sde_intelligence_cells FROM anon, authenticated;

-- =============================================================
-- 4. sde_refresh_exchange — builds facts (TEMP), aggregates, publishes
-- =============================================================

CREATE OR REPLACE FUNCTION public.sde_refresh_exchange()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end CONSTANT date := CURRENT_DATE;
  v_start CONSTANT date := CURRENT_DATE - 180;
  v_event_cap CONSTANT integer := 25;
  v_max_share CONSTANT numeric := 0.40;
  v_noise CONSTANT numeric := 0.35;
  v_published integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('vireek_sde_refresh')) THEN
    RETURN -1; -- another refresh is already running
  END IF;

  DROP TABLE IF EXISTS tmp_sde_consenting;
  DROP TABLE IF EXISTS tmp_sde_facts;
  DROP TABLE IF EXISTS tmp_sde_cells;

  CREATE TEMP TABLE tmp_sde_consenting (user_id uuid, domain text, industry text) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_sde_facts (
    user_id uuid, product text, dimension jsonb, metric text, unit text, value numeric
  ) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_sde_cells (
    product text, dimension jsonb, metric text, unit text, tenants integer, total_rows integer,
    avg_value numeric, p25 numeric, p50 numeric, p75 numeric
  ) ON COMMIT DROP;

  -- Only accounts that currently have a granted consent participate.
  INSERT INTO tmp_sde_consenting (user_id, domain, industry)
  SELECT c.user_id, c.domain,
         COALESCE((
           SELECT NULLIF(lower(btrim(bp.primary_industry)), '')
           FROM business_profile bp WHERE bp.user_id = c.user_id LIMIT 1
         ), 'unspecified')
  FROM sde_consents c
  WHERE c.status = 'granted';

  -- ---------------------------------------------------------------
  -- FACTS (never persisted)
  -- ---------------------------------------------------------------

  -- failure_intelligence: age of the unit at each repair event.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT x.user_id, 'failure_intelligence',
         jsonb_build_object('equipment_type', x.et, 'make', x.mk),
         'age_at_failure_years', 'years', x.age
  FROM (
    SELECT e.user_id,
           public.sde_norm(e.equipment_type) AS et,
           public.sde_norm(e.make) AS mk,
           round(((j.created_at::date - e.install_date)::numeric / 365.25), 1) AS age,
           row_number() OVER (
             PARTITION BY e.user_id, public.sde_norm(e.equipment_type), public.sde_norm(e.make)
             ORDER BY j.created_at DESC
           ) AS rn
    FROM job_equipment je
    JOIN jobs j ON j.id = je.job_id
    JOIN equipment e ON e.id = je.equipment_id
    JOIN tmp_sde_consenting c ON c.user_id = e.user_id AND c.domain = 'failure'
    WHERE j.created_at::date BETWEEN v_start AND v_end
      AND e.install_date IS NOT NULL
      AND e.install_date <= j.created_at::date
      AND COALESCE(j.is_rework, false) = false
      AND public.sde_is_repair_service(COALESCE(je.service_type, j.service_type))
  ) x
  WHERE x.rn <= v_event_cap
    AND x.et IS NOT NULL AND x.mk IS NOT NULL
    AND x.age BETWEEN 0 AND 60;

  -- oem_intelligence: service burden per unit and rework rate, per make.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  WITH unit_jobs AS (
    SELECT e.user_id,
           public.sde_norm(e.equipment_type) AS et,
           public.sde_norm(e.make) AS mk,
           e.id AS eid, j.id AS jid, COALESCE(j.is_rework, false) AS rw
    FROM equipment e
    JOIN tmp_sde_consenting c ON c.user_id = e.user_id AND c.domain = 'equipment'
    LEFT JOIN job_equipment je ON je.equipment_id = e.id
    LEFT JOIN jobs j ON j.id = je.job_id AND j.created_at::date BETWEEN v_start AND v_end
    WHERE e.status = 'active'
  ),
  agg AS (
    SELECT user_id, et, mk,
           count(DISTINCT eid) AS units,
           count(DISTINCT jid) AS calls,
           count(DISTINCT jid) FILTER (WHERE rw) AS rework
    FROM unit_jobs
    WHERE et IS NOT NULL AND mk IS NOT NULL
    GROUP BY user_id, et, mk
    HAVING count(DISTINCT eid) >= 3
  )
  SELECT user_id, 'oem_intelligence', jsonb_build_object('equipment_type', et, 'make', mk),
         'service_calls_per_unit', 'ratio', round(calls::numeric / units, 2)
  FROM agg
  UNION ALL
  SELECT user_id, 'oem_intelligence', jsonb_build_object('equipment_type', et, 'make', mk),
         'rework_rate_pct', 'percent', round(100.0 * rework / calls, 1)
  FROM agg WHERE calls >= 3;

  -- pricing_intelligence: median paid ticket per trade + service.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT j.user_id, 'pricing_intelligence',
         jsonb_build_object('industry', c.industry, 'service_type', public.sde_norm(j.service_type)),
         'median_paid_ticket_cents', 'cents',
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY j.invoice_amount * 100))
  FROM jobs j
  JOIN tmp_sde_consenting c ON c.user_id = j.user_id AND c.domain = 'pricing'
  WHERE j.created_at::date BETWEEN v_start AND v_end
    AND j.invoice_status = 'paid'
    AND j.invoice_amount > 0 AND j.invoice_amount < 1000000
    AND public.sde_norm(j.service_type) IS NOT NULL
  GROUP BY j.user_id, c.industry, public.sde_norm(j.service_type)
  HAVING count(*) >= 3;

  -- labor_intelligence: median on-site minutes + first-time-fix rate.
  -- Tenant-level only: no technician identifier is ever read here.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT j.user_id, 'labor_intelligence',
         jsonb_build_object('industry', c.industry, 'service_type', public.sde_norm(j.service_type)),
         'median_job_minutes', 'minutes',
         round((percentile_cont(0.5) WITHIN GROUP (
           ORDER BY extract(epoch FROM (j.completed_at - j.started_at)) / 60.0))::numeric, 0)
  FROM jobs j
  JOIN tmp_sde_consenting c ON c.user_id = j.user_id AND c.domain = 'labor'
  WHERE j.created_at::date BETWEEN v_start AND v_end
    AND j.job_status = 'completed'
    AND j.started_at IS NOT NULL AND j.completed_at IS NOT NULL
    AND j.completed_at - j.started_at BETWEEN interval '5 minutes' AND interval '24 hours'
    AND public.sde_norm(j.service_type) IS NOT NULL
  GROUP BY j.user_id, c.industry, public.sde_norm(j.service_type)
  HAVING count(*) >= 3;

  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT j.user_id, 'labor_intelligence',
         jsonb_build_object('industry', c.industry, 'service_type', public.sde_norm(j.service_type)),
         'first_time_fix_rate_pct', 'percent',
         round(100.0 * count(*) FILTER (WHERE rw.had IS NULL) / count(*), 1)
  FROM jobs j
  JOIN tmp_sde_consenting c ON c.user_id = j.user_id AND c.domain = 'labor'
  LEFT JOIN LATERAL (
    SELECT true AS had FROM jobs r WHERE r.rework_of_job_id = j.id LIMIT 1
  ) rw ON true
  WHERE j.created_at::date BETWEEN v_start AND v_end
    AND j.job_status = 'completed'
    AND COALESCE(j.is_rework, false) = false
    AND public.sde_norm(j.service_type) IS NOT NULL
  GROUP BY j.user_id, c.industry, public.sde_norm(j.service_type)
  HAVING count(*) >= 5;

  -- parts_intelligence: how often a part is needed for a service type.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  WITH svc AS (
    SELECT j.user_id, c.industry, public.sde_norm(j.service_type) AS svc, count(*) AS n
    FROM jobs j
    JOIN tmp_sde_consenting c ON c.user_id = j.user_id AND c.domain = 'parts'
    WHERE j.created_at::date BETWEEN v_start AND v_end
      AND j.job_status = 'completed'
      AND public.sde_norm(j.service_type) IS NOT NULL
    GROUP BY j.user_id, c.industry, public.sde_norm(j.service_type)
    HAVING count(*) >= 5
  ),
  pj AS (
    SELECT j.user_id, public.sde_norm(j.service_type) AS svc, public.sde_norm(p.name) AS part,
           count(DISTINCT j.id) AS jobs_with
    FROM job_parts_required r
    JOIN jobs j ON j.id = r.job_id
    JOIN inventory_parts p ON p.id = r.part_id
    JOIN tmp_sde_consenting c ON c.user_id = j.user_id AND c.domain = 'parts'
    WHERE j.created_at::date BETWEEN v_start AND v_end
      AND j.job_status = 'completed'
    GROUP BY j.user_id, public.sde_norm(j.service_type), public.sde_norm(p.name)
    HAVING count(DISTINCT j.id) >= 2
  )
  SELECT pj.user_id, 'parts_intelligence',
         jsonb_build_object('industry', svc.industry, 'service_type', pj.svc, 'part', pj.part),
         'attach_rate_pct', 'percent',
         round(LEAST(100.0, 100.0 * pj.jobs_with / svc.n), 1)
  FROM pj
  JOIN svc ON svc.user_id = pj.user_id AND svc.svc = pj.svc
  WHERE pj.part IS NOT NULL;

  -- benchmark_intelligence (outcomes): reuses the existing metric engine.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT c.user_id, 'benchmark_intelligence', jsonb_build_object('industry', c.industry),
         m.metric, m.unit, m.value
  FROM tmp_sde_consenting c
  CROSS JOIN LATERAL public.compute_tenant_metrics(c.user_id, v_start, v_end) m
  WHERE c.domain = 'outcomes' AND m.value IS NOT NULL;

  -- demand_intelligence (outcomes): last-30-day volume vs trailing monthly pace.
  INSERT INTO tmp_sde_facts (user_id, product, dimension, metric, unit, value)
  SELECT c.user_id, 'demand_intelligence',
         jsonb_build_object('industry', c.industry, 'service_type', x.svc),
         'demand_momentum_index', 'index',
         round(LEAST(500.0, 100.0 * x.recent / (x.prior / 5.0)))
  FROM (
    SELECT j.user_id, public.sde_norm(j.service_type) AS svc,
           count(*) FILTER (WHERE j.created_at::date > v_end - 30) AS recent,
           count(*) FILTER (WHERE j.created_at::date <= v_end - 30) AS prior
    FROM jobs j
    WHERE j.created_at::date BETWEEN v_start AND v_end
      AND public.sde_norm(j.service_type) IS NOT NULL
    GROUP BY j.user_id, public.sde_norm(j.service_type)
  ) x
  JOIN tmp_sde_consenting c ON c.user_id = x.user_id AND c.domain = 'outcomes'
  WHERE x.prior >= 10;

  -- ---------------------------------------------------------------
  -- AGGREGATE: k-anonymity + dominance cap + order-preserving noise
  -- ---------------------------------------------------------------
  INSERT INTO tmp_sde_cells (product, dimension, metric, unit, tenants, total_rows, avg_value, p25, p50, p75)
  WITH per_tenant AS (
    SELECT product, dimension, metric, user_id, count(*) AS rows_n
    FROM tmp_sde_facts
    GROUP BY product, dimension, metric, user_id
  ),
  eligible AS (
    SELECT product, dimension, metric,
           count(*) AS tenants, sum(rows_n)::integer AS total_rows
    FROM per_tenant
    GROUP BY product, dimension, metric
    HAVING count(*) >= public.sde_min_contributors(product)
       AND max(rows_n)::numeric / sum(rows_n) <= v_max_share
  )
  SELECT f.product, f.dimension, f.metric, min(f.unit), e.tenants, e.total_rows,
         avg(f.value),
         percentile_cont(0.25) WITHIN GROUP (ORDER BY f.value),
         percentile_cont(0.50) WITHIN GROUP (ORDER BY f.value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY f.value)
  FROM tmp_sde_facts f
  JOIN eligible e ON e.product = f.product AND e.dimension = f.dimension AND e.metric = f.metric
  GROUP BY f.product, f.dimension, f.metric, e.tenants, e.total_rows;

  -- ---------------------------------------------------------------
  -- PUBLISH (full replace: cohorts that fell below k disappear)
  -- ---------------------------------------------------------------
  DELETE FROM sde_intelligence_cells WHERE true;

  INSERT INTO sde_intelligence_cells (
    product, dimension, metric, unit, contributor_count, sample_size,
    avg_value, p25, p50, p75, noise_applied, computed_at
  )
  SELECT s.product, s.dimension, s.metric, s.unit, s.tenants,
         GREATEST(5, (round(s.total_rows / 5.0) * 5)::integer),
         public.sde_clamp(s.avg_value + s.jitter, s.unit),
         public.sde_clamp(s.p25 + s.jitter, s.unit),
         public.sde_clamp(s.p50 + s.jitter, s.unit),
         public.sde_clamp(s.p75 + s.jitter, s.unit),
         true, now()
  FROM (
    SELECT c.*,
           ((random() - 0.5) * 2
             * (GREATEST(c.p75 - c.p25, abs(c.p50) * 0.05 + 0.01) / 1.35)::double precision
             / sqrt(c.tenants::double precision) * v_noise::double precision)::numeric AS jitter
    FROM tmp_sde_cells c
  ) s;
  GET DIAGNOSTICS v_published = ROW_COUNT;

  -- ---------------------------------------------------------------
  -- LEDGER: what each account contributed in this run
  -- ---------------------------------------------------------------
  INSERT INTO sde_contribution_ledger (user_id, domain, run_date, records_contributed, cohorts_contributed)
  SELECT c.user_id, c.domain, v_end, COALESCE(x.records, 0), COALESCE(x.cohorts, 0)
  FROM tmp_sde_consenting c
  LEFT JOIN (
    SELECT f.user_id, public.sde_product_domain(f.product) AS domain,
           count(*)::integer AS records,
           count(DISTINCT f.product || '|' || f.dimension::text || '|' || f.metric)::integer AS cohorts
    FROM tmp_sde_facts f
    JOIN tmp_sde_cells k ON k.product = f.product AND k.dimension = f.dimension AND k.metric = f.metric
    GROUP BY f.user_id, public.sde_product_domain(f.product)
  ) x ON x.user_id = c.user_id AND x.domain = c.domain
  ON CONFLICT (user_id, domain, run_date) DO UPDATE
    SET records_contributed = EXCLUDED.records_contributed,
        cohorts_contributed = EXCLUDED.cohorts_contributed;

  DELETE FROM sde_contribution_ledger WHERE run_date < v_end - 400;

  RETURN v_published;
END;
$$;

REVOKE ALL ON FUNCTION public.sde_refresh_exchange() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sde_refresh_exchange() TO service_role;

-- =============================================================
-- 5. Owner-facing RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.sde_set_consent(p_domain text, p_granted boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.get_account_owner_id();
  v_prev text;
  v_new text := CASE WHEN p_granted THEN 'granted' ELSE 'revoked' END;
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF auth.uid() <> v_tenant THEN
    RAISE EXCEPTION 'Only the account owner can change data-sharing consent' USING ERRCODE = '42501';
  END IF;
  IF p_domain IS NULL OR p_domain NOT IN ('failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes') THEN
    RAISE EXCEPTION 'Unknown data domain' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_prev FROM sde_consents WHERE user_id = v_tenant AND domain = p_domain;

  IF v_prev IS NULL AND NOT p_granted THEN
    RETURN jsonb_build_object('domain', p_domain, 'status', 'none', 'changed', false);
  END IF;
  IF v_prev IS NOT DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('domain', p_domain, 'status', v_new, 'changed', false);
  END IF;

  INSERT INTO sde_consents (user_id, domain, status, terms_version, granted_at, revoked_at, updated_by, updated_at)
  VALUES (v_tenant, p_domain, v_new, public.sde_terms_version(),
          CASE WHEN p_granted THEN now() END, CASE WHEN p_granted THEN NULL ELSE now() END,
          auth.uid(), now())
  ON CONFLICT (user_id, domain) DO UPDATE
    SET status = EXCLUDED.status,
        terms_version = EXCLUDED.terms_version,
        granted_at = CASE WHEN EXCLUDED.status = 'granted' THEN now() ELSE sde_consents.granted_at END,
        revoked_at = CASE WHEN EXCLUDED.status = 'revoked' THEN now() ELSE NULL END,
        updated_by = auth.uid(),
        updated_at = now();

  INSERT INTO sde_consent_events (user_id, domain, action, actor_id, terms_version)
  VALUES (v_tenant, p_domain, v_new, auth.uid(), public.sde_terms_version());

  RETURN jsonb_build_object('domain', p_domain, 'status', v_new, 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.sde_get_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.get_account_owner_id();
  v_domains jsonb;
  v_products jsonb;
  v_participants integer;
  v_last timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'domain', d.domain,
           'status', COALESCE(c.status, 'none'),
           'granted_at', c.granted_at,
           'records_contributed', CASE WHEN c.status = 'granted' THEN COALESCE(l.records_contributed, 0) ELSE 0 END,
           'cohorts_contributed', CASE WHEN c.status = 'granted' THEN COALESCE(l.cohorts_contributed, 0) ELSE 0 END
         ) ORDER BY d.ord), '[]'::jsonb)
  INTO v_domains
  FROM (VALUES ('failure', 1), ('equipment', 2), ('pricing', 3), ('labor', 4), ('parts', 5), ('outcomes', 6)) AS d(domain, ord)
  LEFT JOIN sde_consents c ON c.user_id = v_tenant AND c.domain = d.domain
  LEFT JOIN LATERAL (
    SELECT l2.records_contributed, l2.cohorts_contributed
    FROM sde_contribution_ledger l2
    WHERE l2.user_id = v_tenant AND l2.domain = d.domain
    ORDER BY l2.run_date DESC LIMIT 1
  ) l ON true;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product', p.product,
           'domain', public.sde_product_domain(p.product),
           'unlocked', EXISTS (
             SELECT 1 FROM sde_consents s
             WHERE s.user_id = v_tenant AND s.status = 'granted'
               AND s.domain = public.sde_product_domain(p.product)
           ),
           'available_cells', COALESCE(k.n, 0)
         ) ORDER BY p.ord), '[]'::jsonb)
  INTO v_products
  FROM (VALUES ('failure_intelligence', 1), ('oem_intelligence', 2), ('pricing_intelligence', 3),
               ('labor_intelligence', 4), ('parts_intelligence', 5), ('benchmark_intelligence', 6),
               ('demand_intelligence', 7)) AS p(product, ord)
  LEFT JOIN (
    SELECT product, count(*)::integer AS n FROM sde_intelligence_cells GROUP BY product
  ) k ON k.product = p.product;

  SELECT count(DISTINCT user_id)::integer INTO v_participants FROM sde_consents WHERE status = 'granted';
  SELECT max(computed_at) INTO v_last FROM sde_intelligence_cells;

  RETURN jsonb_build_object(
    'terms_version', public.sde_terms_version(),
    'can_manage', auth.uid() = v_tenant,
    'last_refreshed_at', v_last,
    -- Hidden below the k-floor so the network size itself is not a leak.
    'network_contributors', CASE WHEN v_participants >= 5 THEN v_participants ELSE NULL END,
    'domains', v_domains,
    'products', v_products
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sde_get_intelligence(
  p_product text,
  p_search text DEFAULT NULL,
  p_my_trade_only boolean DEFAULT false,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  dimension jsonb,
  metric text,
  unit text,
  contributor_count integer,
  sample_size integer,
  avg_value numeric,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  computed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.dimension, c.metric, c.unit, c.contributor_count, c.sample_size,
         c.avg_value, c.p25, c.p50, c.p75, c.computed_at
  FROM sde_intelligence_cells c
  WHERE c.product = p_product
    -- Give-to-get gate: caller's account must contribute the feeding domain.
    AND EXISTS (
      SELECT 1 FROM sde_consents s
      WHERE s.user_id = public.get_account_owner_id()
        AND s.status = 'granted'
        AND s.domain = public.sde_product_domain(p_product)
    )
    AND (
      p_search IS NULL OR btrim(p_search) = ''
      OR c.dimension::text ILIKE '%' || replace(replace(btrim(p_search), '%', '\%'), '_', '\_') || '%'
    )
    AND (
      NOT COALESCE(p_my_trade_only, false)
      OR NOT (c.dimension ? 'industry')
      OR c.dimension->>'industry' = COALESCE((
           SELECT NULLIF(lower(btrim(bp.primary_industry)), '')
           FROM business_profile bp WHERE bp.user_id = public.get_account_owner_id() LIMIT 1
         ), 'unspecified')
    )
  ORDER BY c.contributor_count DESC, c.metric
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
$$;

REVOKE ALL ON FUNCTION public.sde_set_consent(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sde_get_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sde_get_intelligence(text, text, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sde_set_consent(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sde_get_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sde_get_intelligence(text, text, boolean, integer) TO authenticated;

-- =============================================================
-- 6. Nightly schedule (no-op, not an error, if pg_cron is absent)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-sde-refresh-exchange');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-sde-refresh-exchange', '10 4 * * *', 'select public.sde_refresh_exchange()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
