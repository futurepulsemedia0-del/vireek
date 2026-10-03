/*
  # VIREEK Global Failure Atlas

  A network-wide, privacy-preserving failure knowledge graph:

    Equipment (type + make + model family)
      -> Failure mode (job_outcomes.root_cause_key)
         -> units observed, failure rate, age-at-failure (median / IQR),
            first-visit-fix rate, callback rate, rework rate,
            best parts, best diagnostic tests, typical symptoms

  Every small customer benefits from the collective outcome data of the
  whole network, while no business's data is ever exposed.

  ## Privacy architecture (all enforced in SQL, not in the UI)
  1. OPT-IN. Only accounts with failure_atlas_consent.contribute = true
     feed the Atlas. Default is OFF. Withdrawal takes effect at the next
     refresh because the cells table is rebuilt from scratch every run.
  2. k-ANONYMITY. A cell is published only if >= 5 distinct businesses
     observed the failure mode AND >= 5 businesses / >= 20 units make up
     the denominator (same k=5 floor as cross_tenant_benchmarking).
  3. DOMINANCE RULE. No single business may account for more than 40% of
     a cell's failure events.
  4. SUB-AGGREGATE k. A part / diagnostic test / symptom is listed only
     if >= 3 distinct businesses used it (kills one-off free text).
  5. BUCKETING + NOISE. Counts are bucketed, rates are rounded and get a
     small deterministic jitter scaled to the binomial standard error
     (stable within an ISO week so it cannot be averaged away inside a
     week). DP-INSPIRED, NOT a formally proven epsilon-DP guarantee.
  6. No client-parameterized cross-tenant query exists. refresh_failure_atlas()
     is SECURITY DEFINER and executable by service_role only; clients can
     only read the already-aggregated failure_atlas_cells table.
  7. Cells carry no tenant id, customer id, job id, address, price or name.

  ## Objects
  - job_outcomes.symptom_key / diagnostic_test_key   structured capture (additive)
  - failure_atlas_consent                             per-account opt-in
  - failure_atlas_cells                               published aggregates (shared, read-only)
  - failure_atlas_stats                               one-row network headline stats
  - atlas_norm / atlas_model_family / atlas_bucket    shared normalisation helpers
  - refresh_failure_atlas()                           nightly rebuild (service_role / pg_cron)
  - set_failure_atlas_consent(boolean)                owner-only consent RPC
  - get_failure_atlas(type, make, model)              lookup with model->make fallback
  - get_failure_atlas_index()                         browse index
  - get_my_atlas_exposure()                           my own active fleet vs the Atlas

  Failure attribution only counts jobs linked to exactly ONE equipment unit
  (job_equipment), so a multi-unit visit is never blamed on the wrong unit.
*/

-- =============================================================
-- 1. Structured capture on job_outcomes (additive, nullable)
-- =============================================================

ALTER TABLE job_outcomes
  ADD COLUMN IF NOT EXISTS symptom_key text
    CHECK (symptom_key IS NULL OR symptom_key ~ '^[a-z0-9_]{1,48}$');
ALTER TABLE job_outcomes
  ADD COLUMN IF NOT EXISTS diagnostic_test_key text
    CHECK (diagnostic_test_key IS NULL OR diagnostic_test_key ~ '^[a-z0-9_]{1,48}$');

-- =============================================================
-- 2. Consent
-- =============================================================

CREATE TABLE IF NOT EXISTS failure_atlas_consent (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  contribute boolean NOT NULL DEFAULT false,
  consented_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE failure_atlas_consent ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_failure_atlas_consent" ON failure_atlas_consent;
CREATE POLICY "select_own_failure_atlas_consent" ON failure_atlas_consent
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE: written only by set_failure_atlas_consent().

CREATE OR REPLACE FUNCTION public.set_failure_atlas_consent(p_contribute boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Only the account owner can change Failure Atlas contribution.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO failure_atlas_consent (user_id, contribute, consented_at, updated_at)
  VALUES (auth.uid(), p_contribute, CASE WHEN p_contribute THEN now() END, now())
  ON CONFLICT (user_id) DO UPDATE
    SET contribute = EXCLUDED.contribute,
        consented_at = CASE
          WHEN EXCLUDED.contribute AND NOT failure_atlas_consent.contribute THEN now()
          WHEN EXCLUDED.contribute THEN failure_atlas_consent.consented_at
          ELSE NULL
        END,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.set_failure_atlas_consent(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_failure_atlas_consent(boolean) TO authenticated;

-- =============================================================
-- 3. Published aggregates (shared, read-only for clients)
-- =============================================================

CREATE TABLE IF NOT EXISTS failure_atlas_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_type text NOT NULL,
  make_key text NOT NULL,
  model_family text NOT NULL,              -- '*' = brand-wide fallback cell
  failure_mode text NOT NULL,
  units_observed integer NOT NULL,         -- bucketed
  failed_units integer NOT NULL,           -- bucketed
  failure_events integer NOT NULL,         -- bucketed
  contributor_count integer NOT NULL,
  failure_rate_pct numeric(5,2) NOT NULL,
  median_age_months integer,
  p25_age_months integer,
  p75_age_months integer,
  first_visit_fix_pct numeric(5,2),
  callback_pct numeric(5,2),
  rework_pct numeric(5,2),
  top_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_symptoms jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_diagnostic_tests jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_months integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (equipment_type, make_key, model_family, failure_mode)
);

CREATE INDEX IF NOT EXISTS idx_failure_atlas_cells_lookup
  ON failure_atlas_cells (make_key, equipment_type, model_family);

ALTER TABLE failure_atlas_cells ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_failure_atlas_cells" ON failure_atlas_cells;
CREATE POLICY "read_failure_atlas_cells" ON failure_atlas_cells
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS failure_atlas_stats (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  contributing_businesses integer NOT NULL DEFAULT 0,
  units_observed integer NOT NULL DEFAULT 0,
  cells_published integer NOT NULL DEFAULT 0,
  window_months integer NOT NULL DEFAULT 36,
  computed_at timestamptz
);

ALTER TABLE failure_atlas_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_failure_atlas_stats" ON failure_atlas_stats;
CREATE POLICY "read_failure_atlas_stats" ON failure_atlas_stats
  FOR SELECT TO authenticated USING (true);

INSERT INTO failure_atlas_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- =============================================================
-- 4. Helpers (shared so refresh and lookups can never drift)
-- =============================================================

CREATE OR REPLACE FUNCTION public.atlas_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(lower(regexp_replace(coalesce(p, ''), '[^a-zA-Z0-9]', '', 'g')), '');
$$;

-- Model family = first 6 normalised characters of the model number
-- (heuristic; tune freely — cells are rebuilt from scratch every refresh and
-- clients normalise through the same function, so nothing can drift).
CREATE OR REPLACE FUNCTION public.atlas_model_family(p_model text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN length(public.atlas_norm(p_model)) >= 4
              THEN left(public.atlas_norm(p_model), 6) END;
$$;

CREATE OR REPLACE FUNCTION public.atlas_bucket(p_n bigint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_n < 100  THEN (p_n / 5)  * 5
    WHEN p_n < 1000 THEN (p_n / 10) * 10
    ELSE (p_n / 50) * 50
  END::integer;
$$;

-- Deterministic jitter in [-1, 1], stable for a given key within an ISO week.
CREATE OR REPLACE FUNCTION public.atlas_jitter(p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ((abs(hashtextextended(p_key, 0)) % 2001) - 1000) / 1000.0;
$$;

GRANT EXECUTE ON FUNCTION public.atlas_norm(text), public.atlas_model_family(text),
  public.atlas_bucket(bigint), public.atlas_jitter(text) TO authenticated, service_role;

-- =============================================================
-- 5. refresh_failure_atlas — rebuild all published cells
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_failure_atlas(p_window_months integer DEFAULT 36)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k_tenants   CONSTANT integer := 5;
  k_units     CONSTANT integer := 20;
  k_sub       CONSTANT integer := 3;
  k_age       CONSTANT integer := 10;
  max_share   CONSTANT numeric := 0.40;
  jitter_amp  CONSTANT numeric := 0.35;
  v_window    integer := GREATEST(6, LEAST(COALESCE(p_window_months, 36), 120));
  v_week      text := to_char(now(), 'IYYY-IW');
  v_rows      integer := 0;
  v_businesses integer;
  v_units_total integer;
BEGIN
  CREATE TEMP TABLE tmp_units (
    equipment_id uuid, user_id uuid, equipment_type text, make_key text,
    model_family text, install_date date
  ) ON COMMIT DROP;

  INSERT INTO tmp_units
  SELECT e.id, e.user_id, lower(btrim(e.equipment_type)), public.atlas_norm(e.make),
         public.atlas_model_family(e.model), e.install_date
  FROM equipment e
  JOIN failure_atlas_consent c ON c.user_id = e.user_id AND c.contribute
  WHERE public.atlas_norm(e.make) IS NOT NULL
    AND btrim(coalesce(e.equipment_type, '')) <> '';

  -- Scope expansion: every unit counts at its model-family level AND brand-wide.
  CREATE TEMP TABLE tmp_unit_scope (
    equipment_id uuid, user_id uuid, equipment_type text, make_key text,
    scope_family text
  ) ON COMMIT DROP;

  INSERT INTO tmp_unit_scope
  SELECT equipment_id, user_id, equipment_type, make_key, model_family FROM tmp_units WHERE model_family IS NOT NULL
  UNION ALL
  SELECT equipment_id, user_id, equipment_type, make_key, '*' FROM tmp_units;

  CREATE TEMP TABLE tmp_denoms (
    equipment_type text, make_key text, scope_family text, units integer, tenants integer
  ) ON COMMIT DROP;

  INSERT INTO tmp_denoms
  SELECT equipment_type, make_key, scope_family,
         count(DISTINCT equipment_id), count(DISTINCT user_id)
  FROM tmp_unit_scope
  GROUP BY equipment_type, make_key, scope_family
  HAVING count(DISTINCT user_id) >= k_tenants AND count(DISTINCT equipment_id) >= k_units;

  -- Failure events: outcomes with a structured root cause, on jobs that touched
  -- exactly ONE equipment unit (no mis-attribution on multi-unit visits).
  CREATE TEMP TABLE tmp_events (
    equipment_id uuid, user_id uuid, equipment_type text, make_key text,
    model_family text, failure_mode text, resolution text,
    caused_callback boolean, is_rework boolean, parts_used text[],
    symptom_key text, diagnostic_test_key text, age_months numeric
  ) ON COMMIT DROP;

  INSERT INTO tmp_events
  SELECT u.equipment_id, u.user_id, u.equipment_type, u.make_key, u.model_family,
         lower(btrim(jo.root_cause_key)), jo.resolution, jo.caused_callback, jo.is_rework,
         jo.parts_used, jo.symptom_key, jo.diagnostic_test_key,
         CASE WHEN u.install_date IS NOT NULL AND jo.recorded_at::date >= u.install_date
              THEN (jo.recorded_at::date - u.install_date) / 30.4375 END
  FROM job_outcomes jo
  JOIN (
    SELECT job_id, min(equipment_id::text)::uuid AS equipment_id
    FROM job_equipment GROUP BY job_id HAVING count(*) = 1
  ) je ON je.job_id = jo.job_id
  JOIN tmp_units u ON u.equipment_id = je.equipment_id AND u.user_id = jo.user_id
  WHERE jo.root_cause_key IS NOT NULL
    AND btrim(jo.root_cause_key) <> ''
    AND lower(btrim(jo.root_cause_key)) NOT IN ('other', 'unknown', 'none', 'not_diagnosed')
    AND jo.recorded_at >= now() - make_interval(months => v_window);

  CREATE TEMP TABLE tmp_event_scope (
    equipment_id uuid, user_id uuid, equipment_type text, make_key text,
    scope_family text, failure_mode text, resolution text,
    caused_callback boolean, is_rework boolean, parts_used text[],
    symptom_key text, diagnostic_test_key text, age_months numeric
  ) ON COMMIT DROP;

  INSERT INTO tmp_event_scope
  SELECT equipment_id, user_id, equipment_type, make_key, model_family, failure_mode, resolution,
         caused_callback, is_rework, parts_used, symptom_key, diagnostic_test_key, age_months
  FROM tmp_events WHERE model_family IS NOT NULL
  UNION ALL
  SELECT equipment_id, user_id, equipment_type, make_key, '*', failure_mode, resolution,
         caused_callback, is_rework, parts_used, symptom_key, diagnostic_test_key, age_months
  FROM tmp_events;

  -- Cells that clear k-anonymity and the dominance rule.
  CREATE TEMP TABLE tmp_cells (
    equipment_type text, make_key text, scope_family text, failure_mode text,
    units integer, failed_units integer, events integer, tenants integer,
    median_age numeric, p25_age numeric, p75_age numeric,
    ftf_pct numeric, callback_pct numeric, rework_pct numeric
  ) ON COMMIT DROP;

  INSERT INTO tmp_cells
  WITH per_tenant AS (
    SELECT equipment_type, make_key, scope_family, failure_mode, user_id, count(*) AS n
    FROM tmp_event_scope
    GROUP BY equipment_type, make_key, scope_family, failure_mode, user_id
  ), dom AS (
    SELECT equipment_type, make_key, scope_family, failure_mode,
           count(*) AS tenants, sum(n) AS events, max(n)::numeric / sum(n) AS top_share
    FROM per_tenant
    GROUP BY equipment_type, make_key, scope_family, failure_mode
    HAVING count(*) >= k_tenants AND max(n)::numeric / sum(n) <= max_share
  ), agg AS (
    SELECT es.equipment_type, es.make_key, es.scope_family, es.failure_mode,
           count(DISTINCT es.equipment_id) AS failed_units,
           count(es.age_months) AS age_n,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY es.age_months) FILTER (WHERE es.age_months IS NOT NULL) AS med,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY es.age_months) FILTER (WHERE es.age_months IS NOT NULL) AS p25,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY es.age_months) FILTER (WHERE es.age_months IS NOT NULL) AS p75,
           100.0 * avg((es.resolution = 'fixed_first_visit')::int) AS ftf,
           100.0 * avg(es.caused_callback::int) AS cb,
           100.0 * avg(es.is_rework::int) AS rw
    FROM tmp_event_scope es
    JOIN dom d USING (equipment_type, make_key, scope_family, failure_mode)
    GROUP BY es.equipment_type, es.make_key, es.scope_family, es.failure_mode
  )
  SELECT a.equipment_type, a.make_key, a.scope_family, a.failure_mode,
         dn.units, a.failed_units, d.events::integer, d.tenants::integer,
         CASE WHEN a.age_n >= k_age THEN a.med END,
         CASE WHEN a.age_n >= k_age THEN a.p25 END,
         CASE WHEN a.age_n >= k_age THEN a.p75 END,
         a.ftf, a.cb, a.rw
  FROM agg a
  JOIN dom d USING (equipment_type, make_key, scope_family, failure_mode)
  JOIN tmp_denoms dn USING (equipment_type, make_key, scope_family);

  -- Sub-aggregates: parts, diagnostic tests, symptoms (each needs >= k_sub businesses).
  CREATE TEMP TABLE tmp_parts (
    equipment_type text, make_key text, scope_family text, failure_mode text, payload jsonb
  ) ON COMMIT DROP;

  INSERT INTO tmp_parts
  SELECT equipment_type, make_key, scope_family, failure_mode,
         jsonb_agg(jsonb_build_object('part', item, 'share_pct', share, 'first_visit_fix_pct', ftf, 'sample', n) ORDER BY n DESC)
  FROM (
    SELECT p.equipment_type, p.make_key, p.scope_family, p.failure_mode, p.item, p.n,
           round(100.0 * p.n / c.events, 1) AS share, round(p.ftf, 1) AS ftf,
           row_number() OVER (PARTITION BY p.equipment_type, p.make_key, p.scope_family, p.failure_mode ORDER BY p.n DESC, p.item) AS rn
    FROM (
      SELECT es.equipment_type, es.make_key, es.scope_family, es.failure_mode,
             lower(btrim(part)) AS item, count(*) AS n,
             100.0 * avg((es.resolution = 'fixed_first_visit')::int) AS ftf
      FROM tmp_event_scope es, unnest(es.parts_used) AS part
      WHERE length(btrim(part)) BETWEEN 2 AND 60
      GROUP BY es.equipment_type, es.make_key, es.scope_family, es.failure_mode, lower(btrim(part))
      HAVING count(DISTINCT es.user_id) >= k_sub
    ) p
    JOIN tmp_cells c USING (equipment_type, make_key, scope_family, failure_mode)
  ) ranked
  WHERE rn <= 5
  GROUP BY equipment_type, make_key, scope_family, failure_mode;

  CREATE TEMP TABLE tmp_tests (
    equipment_type text, make_key text, scope_family text, failure_mode text, payload jsonb
  ) ON COMMIT DROP;

  INSERT INTO tmp_tests
  SELECT equipment_type, make_key, scope_family, failure_mode,
         jsonb_agg(jsonb_build_object('test', item, 'first_visit_fix_pct', ftf, 'sample', n) ORDER BY ftf DESC, n DESC)
  FROM (
    SELECT t.*, row_number() OVER (PARTITION BY equipment_type, make_key, scope_family, failure_mode ORDER BY ftf DESC, n DESC, item) AS rn
    FROM (
      SELECT es.equipment_type, es.make_key, es.scope_family, es.failure_mode,
             es.diagnostic_test_key AS item, count(*) AS n,
             round(100.0 * avg((es.resolution = 'fixed_first_visit')::int), 1) AS ftf
      FROM tmp_event_scope es
      WHERE es.diagnostic_test_key IS NOT NULL
      GROUP BY es.equipment_type, es.make_key, es.scope_family, es.failure_mode, es.diagnostic_test_key
      HAVING count(DISTINCT es.user_id) >= k_sub AND count(*) >= 5
    ) t
    JOIN tmp_cells c USING (equipment_type, make_key, scope_family, failure_mode)
  ) ranked
  WHERE rn <= 3
  GROUP BY equipment_type, make_key, scope_family, failure_mode;

  CREATE TEMP TABLE tmp_symptoms (
    equipment_type text, make_key text, scope_family text, failure_mode text, payload jsonb
  ) ON COMMIT DROP;

  INSERT INTO tmp_symptoms
  SELECT equipment_type, make_key, scope_family, failure_mode,
         jsonb_agg(jsonb_build_object('symptom', item, 'share_pct', share) ORDER BY n DESC)
  FROM (
    SELECT s.*, row_number() OVER (PARTITION BY equipment_type, make_key, scope_family, failure_mode ORDER BY n DESC, item) AS rn
    FROM (
      SELECT es.equipment_type, es.make_key, es.scope_family, es.failure_mode,
             es.symptom_key AS item, count(*) AS n,
             round(100.0 * count(*) / c.events, 1) AS share
      FROM tmp_event_scope es
      JOIN tmp_cells c USING (equipment_type, make_key, scope_family, failure_mode)
      WHERE es.symptom_key IS NOT NULL
      GROUP BY es.equipment_type, es.make_key, es.scope_family, es.failure_mode, es.symptom_key, c.events
      HAVING count(DISTINCT es.user_id) >= k_sub
    ) s
  ) ranked
  WHERE rn <= 3
  GROUP BY equipment_type, make_key, scope_family, failure_mode;

  -- Publish: rebuild from scratch so withdrawn consent / failed k vanish immediately.
  DELETE FROM failure_atlas_cells;

  INSERT INTO failure_atlas_cells (
    equipment_type, make_key, model_family, failure_mode,
    units_observed, failed_units, failure_events, contributor_count,
    failure_rate_pct, median_age_months, p25_age_months, p75_age_months,
    first_visit_fix_pct, callback_pct, rework_pct,
    top_parts, top_symptoms, top_diagnostic_tests, window_months, computed_at
  )
  SELECT
    c.equipment_type, c.make_key, c.scope_family, c.failure_mode,
    public.atlas_bucket(c.units), public.atlas_bucket(c.failed_units), public.atlas_bucket(c.events), c.tenants,
    q.rate,
    round(c.median_age)::integer, round(c.p25_age)::integer, round(c.p75_age)::integer,
    round(c.ftf_pct, 1), round(c.callback_pct, 1), round(c.rework_pct, 1),
    COALESCE(tp.payload, '[]'::jsonb), COALESCE(ts.payload, '[]'::jsonb), COALESCE(tt.payload, '[]'::jsonb),
    v_window, now()
  FROM tmp_cells c
  CROSS JOIN LATERAL (
    SELECT round(GREATEST(0, LEAST(100,
      100.0 * c.failed_units / c.units
      + public.atlas_jitter(c.equipment_type || '|' || c.make_key || '|' || c.scope_family || '|' || c.failure_mode || '|' || v_week)
        * jitter_amp * 100.0 * sqrt((c.failed_units::numeric / c.units) * (1 - c.failed_units::numeric / c.units) / c.units)
    )), 1) AS rate
  ) q
  LEFT JOIN tmp_parts tp USING (equipment_type, make_key, scope_family, failure_mode)
  LEFT JOIN tmp_symptoms ts USING (equipment_type, make_key, scope_family, failure_mode)
  LEFT JOIN tmp_tests tt USING (equipment_type, make_key, scope_family, failure_mode);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(DISTINCT user_id), count(DISTINCT equipment_id)
    INTO v_businesses, v_units_total FROM tmp_units;

  UPDATE failure_atlas_stats
  SET contributing_businesses = CASE WHEN v_businesses >= k_tenants THEN public.atlas_bucket(v_businesses) ELSE 0 END,
      units_observed = CASE WHEN v_businesses >= k_tenants THEN public.atlas_bucket(v_units_total) ELSE 0 END,
      cells_published = v_rows,
      window_months = v_window,
      computed_at = now()
  WHERE id = 1;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_failure_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_failure_atlas(integer) TO service_role;

-- =============================================================
-- 6. Read RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_failure_atlas(
  p_equipment_type text,
  p_make text,
  p_model text DEFAULT NULL
)
RETURNS SETOF failure_atlas_cells
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (c.failure_mode) c.*
    FROM failure_atlas_cells c
    WHERE c.make_key = public.atlas_norm(p_make)
      AND (btrim(coalesce(p_equipment_type, '')) = '' OR c.equipment_type = lower(btrim(p_equipment_type)))
      AND c.model_family IN (COALESCE(public.atlas_model_family(p_model), '*'), '*')
    ORDER BY c.failure_mode, (c.model_family = '*')
  ) best
  ORDER BY best.failure_rate_pct DESC
  LIMIT 25;
$$;

CREATE OR REPLACE FUNCTION public.get_failure_atlas_index()
RETURNS TABLE (
  equipment_type text, make_key text, model_family text,
  units_observed integer, failure_modes integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.equipment_type, c.make_key, c.model_family,
         max(c.units_observed)::integer, count(*)::integer
  FROM failure_atlas_cells c
  GROUP BY c.equipment_type, c.make_key, c.model_family
  ORDER BY max(c.units_observed) DESC, c.make_key
  LIMIT 500;
$$;

CREATE OR REPLACE FUNCTION public.get_my_atlas_exposure()
RETURNS TABLE (
  equipment_id uuid, customer_id uuid, equipment_type text, make text, model text,
  unit_age_months numeric, failure_mode text, scope_family text,
  failure_rate_pct numeric, median_age_months integer,
  p25_age_months integer, p75_age_months integer,
  first_visit_fix_pct numeric, callback_pct numeric, risk_band text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH my AS (
    SELECT e.id, e.customer_id, e.equipment_type, e.make, e.model,
           lower(btrim(e.equipment_type)) AS et,
           public.atlas_norm(e.make) AS mk,
           public.atlas_model_family(e.model) AS fam,
           CASE WHEN e.install_date IS NOT NULL
                THEN round(((CURRENT_DATE - e.install_date) / 30.4375)::numeric, 1) END AS age_m
    FROM equipment e
    WHERE e.status = 'active'
      AND e.user_id = public.get_account_owner_id()
      AND public.atlas_norm(e.make) IS NOT NULL
  )
  SELECT * FROM (
    SELECT my.id, my.customer_id, my.equipment_type, my.make, my.model, my.age_m,
           c.failure_mode, c.model_family, c.failure_rate_pct, c.median_age_months,
           c.p25_age_months, c.p75_age_months, c.first_visit_fix_pct, c.callback_pct,
           CASE
             WHEN my.age_m IS NULL OR c.p25_age_months IS NULL THEN 'unknown'
             WHEN my.age_m > c.p75_age_months THEN 'past_typical'
             WHEN my.age_m >= c.p25_age_months THEN 'in_window'
             WHEN my.age_m >= c.p25_age_months * 0.8 THEN 'approaching'
             ELSE 'early'
           END AS risk_band
    FROM my
    JOIN LATERAL (
      SELECT DISTINCT ON (x.failure_mode) x.*
      FROM failure_atlas_cells x
      WHERE x.make_key = my.mk AND x.equipment_type = my.et
        AND x.model_family IN (COALESCE(my.fam, '*'), '*')
      ORDER BY x.failure_mode, (x.model_family = '*')
    ) c ON true
  ) r
  ORDER BY CASE r.risk_band WHEN 'past_typical' THEN 0 WHEN 'in_window' THEN 1 WHEN 'approaching' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END,
           r.failure_rate_pct DESC
  LIMIT 300;
$$;

GRANT EXECUTE ON FUNCTION public.get_failure_atlas(text, text, text),
  public.get_failure_atlas_index(), public.get_my_atlas_exposure() TO authenticated;

GRANT SELECT ON failure_atlas_cells, failure_atlas_stats, failure_atlas_consent TO authenticated;
GRANT SELECT ON failure_atlas_cells, failure_atlas_stats, failure_atlas_consent TO service_role;

-- =============================================================
-- 7. Nightly refresh (no-op, not an error, if pg_cron is absent)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-failure-atlas-refresh');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-failure-atlas-refresh', '40 3 * * *', 'select public.refresh_failure_atlas(36)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
